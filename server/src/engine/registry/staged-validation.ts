import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkTree } from '../../fs-walk.js';
import type { HostLogger, ToleranceRefusalReason } from '@fmd/contract';
import { TolerancePolicy, SYNC_FAILURE_TOLERANCE } from '@fmd/contract';
import type { LuaHostFactory } from '../contract.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../lua/abort.js';
import { RecordedResponseResolver } from '../shims/http-shim.js';
import { initShimsHook } from '../shims/install.js';

/**
 * Staged-tree validation (DESIGN.md §5.1 + §6 sync gate) — MOVED inside
 * the engine by the engine-boundary story: the validation drives real
 * module hosts (parse + Init pass over the staged tree = registry
 * MECHANISM); the sync layer calls `validateStagedLuaTree` through the
 * facade. Before anything
 * touches `data/lua/`, the staged tree must prove itself — every `.lua`
 * file in the tree parses (compile-only check via the chunk cache), and
 * every `modules/*.lua` file passes the real Init pass (parse + register).
 *
 * The production Init pass is tolerant (errors are logged, the module is
 * dropped) — and the sync gate is tolerance-gated the SAME way, via the
 * shared contract TolerancePolicy: a handful of upstream-broken files
 * (≤5 AND ≤1% of module files, whole-file rounding, none of them
 * previously registered) is ADMITTED — the sync proceeds and the report
 * carries `failures[]`. Anything over the thresholds, or a file that
 * used to register (regression), refuses the whole sync before the
 * swap. Zero-tolerance is gone: the real FMD2 tree permanently carries
 * ~5 upstream-broken files and a zero-tolerance gate could never pass
 * on it (launch defect (a)).
 */

export interface StagedFileFailure {
  readonly file: string;
  readonly errors: readonly string[];
}

export interface StagedTreeValidation {
  /** Registered modules of the staged tree (the diff-report input). */
  readonly inventory: StagedInventoryEntry[];
  /** All `.lua` files parse-checked (module files included). */
  readonly luaFiles: number;
  /** `modules/*.lua` files that went through the Init pass. */
  readonly moduleFiles: number;
  /** Files carried without validation (assets such as `.proto`). */
  readonly otherFiles: number;
  /** Tolerated failures (file + full error list) — empty on a clean tree. */
  readonly failures: readonly StagedFileFailure[];
  /** Non-fatal findings (e.g. a module file that registered nothing). */
  readonly warnings: readonly string[];
}

export interface StagedInventoryEntry {
  readonly id: string;
  readonly name: string;
  readonly sourceFile: string;
}

export class StagedInitError extends Error {
  constructor(
    message: string,
    readonly failures: readonly StagedFileFailure[],
    /** Why the tolerance policy refused ('regression' | 'over-threshold'). */
    readonly toleranceReason?: ToleranceRefusalReason,
  ) {
    super(message);
    this.name = 'StagedInitError';
  }
}

export interface StagedValidationOptions {
  /**
   * Previous sync's registered inventory (the regression guard input):
   * a failing file that appears here used to work and refuses the sync.
   * Omitted on first install.
   */
  readonly previousInventory?: readonly { readonly sourceFile: string }[];
  /**
   * Lua host factory (injected by the composition root): builds the
   * validation's hosts + the isolated parse cache behind the contract
   * interfaces — no wasmoon/host dependency here.
   */
  readonly hostFactory: LuaHostFactory;
}

const MODULES_DIR = 'modules';

export async function validateStagedLuaTree(
  stagedDir: string,
  logger: HostLogger,
  options: StagedValidationOptions,
): Promise<StagedTreeValidation> {
  const allFiles = walk(stagedDir).sort(comparePosix);
  const moduleFiles = allFiles.filter(
    (file) => file.startsWith(`${MODULES_DIR}/`) && file.endsWith('.lua'),
  );
  const parseOnlyFiles = allFiles.filter(
    (file) => file.endsWith('.lua') && !moduleFiles.includes(file),
  );
  const otherFiles = allFiles.length - moduleFiles.length - parseOnlyFiles.length;

  const failures: StagedFileFailure[] = [];
  const warnings: string[] = [];
  const parseCache = options.hostFactory.createChunkCache();

  // 1. Parse-check every non-module .lua file (templates, utils, …).
  for (const file of parseOnlyFiles) {
    try {
      await parseCache.get(file, readFileSync(join(stagedDir, file), 'utf8'));
    } catch (error) {
      failures.push({ file, errors: [parseErrorMessage(error)] });
    }
  }

  // 2. Real Init pass over modules/*.lua — the SAME shim wiring the
  //    registry sweep runs (§5.7 require shim resolving against the
  //    tree root, offline resolver, deadline cells): without it, every
  //    module that requires a template/util fails Lua's native
  //    package.path lookup and the staged failure count explodes past
  //    any tolerance (the deeper half of the D20 launch defect). Parse
  //    failures throw out of the chunk cache (outside the registry's
  //    tolerant DoInit catch) — both paths land in `failures`.
  const inventory: StagedInventoryEntry[] = [];
  const host = options.hostFactory.createHost(logger);
  try {
    for (const file of moduleFiles) {
      const before = logger.records.length;
      const abort = new DeadlineAbortHandle(createDeadlineCells());
      const hook = initShimsHook({
        resolver: new RecordedResponseResolver([]), // offline: no Init-time network
        abort,
        logger,
        moduleId: file,
        luaRoot: stagedDir,
      });
      let descriptors: readonly { id: string; name: string; sourceFile: string }[] = [];
      let thrown: string | undefined;
      try {
        descriptors = await host.registry.loadFile(file, readFileSync(join(stagedDir, file), 'utf8'), hook);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      const errors = logger.records
        .slice(before)
        .filter((record) => record.level === 'error')
        .map((record) => record.message);
      if (thrown !== undefined) {
        errors.push(thrown);
      }
      if (errors.length > 0) {
        failures.push({ file, errors });
        continue;
      }
      if (descriptors.length === 0) {
        warnings.push(`${file} registered no modules`);
        continue;
      }
      for (const descriptor of descriptors) {
        inventory.push({ id: descriptor.id, name: descriptor.name, sourceFile: descriptor.sourceFile });
      }
    }
  } finally {
    await host.dispose();
  }

  const decision = TolerancePolicy.decide(
    failures.map((failure) => ({ file: failure.file, firstError: failure.errors[0] ?? 'unknown error' })),
    moduleFiles.length,
    options.previousInventory ?? [],
  );
  if (decision.decision === 'refuse') {
    const detail = failures
      .map((failure) => `  ${failure.file}:\n${failure.errors.map((e) => `    ${e}`).join('\n')}`)
      .join('\n');
    const why =
      decision.reason === 'regression'
        ? `regression: previously-registered file(s) went broken — ${decision.offenders.map((o) => o.file).join(', ')}`
        : `over-threshold: ${failures.length} failing file(s) exceed the tolerance (≤${String(SYNC_FAILURE_TOLERANCE.maxFiles)} AND ≤1% of ${String(moduleFiles.length)} module files)`;
    throw new StagedInitError(
      `staged tree failed Init-pass validation (${failures.length} file(s), ${why}):\n${detail}`,
      failures,
      decision.reason,
    );
  }

  return {
    inventory,
    luaFiles: moduleFiles.length + parseOnlyFiles.length,
    moduleFiles: moduleFiles.length,
    otherFiles,
    failures,
    warnings,
  };
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? `parse failed: ${error.message}` : `parse failed: ${String(error)}`;
}

function comparePosix(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walk(root: string, prefix = ''): string[] {
  // Shared walker seam (jobs/library/root-walk): the inventory walk
  // keeps its exact historical shape — dotfiles included, plain
  // isFile dirents only, posix-normalized relative paths, readdir
  // order. Delegating keeps ONE tree-walk implementation server-side.
  return walkTree(join(root, prefix)).map((file): string => file.relPath);
}
