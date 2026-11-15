import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { HostLogger } from '@fmd/contract';
import { LuaFactory } from 'wasmoon';
import { WasmoonChunkCache } from '../../engine/lua/chunk-cache.js';
import { createLuaHost } from '../../engine/lua/host.js';

/**
 * Staged-tree validation (DESIGN.md §5.1 + §6 sync gate): before anything
 * touches `data/lua/`, the staged tree must prove itself — every `.lua`
 * file in the tree parses (compile-only check via the chunk cache), and
 * every `modules/*.lua` file passes the real Init pass (parse + register).
 * The production Init pass is tolerant (errors are logged, the module is
 * dropped) — the sync gate is strict: any error-level record for a module
 * file is a fatal validation failure, so a broken module refuses the whole
 * sync before the swap.
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
  ) {
    super(message);
    this.name = 'StagedInitError';
  }
}

const MODULES_DIR = 'modules';

export async function validateStagedLuaTree(
  stagedDir: string,
  logger: HostLogger,
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
  const parseCache = new WasmoonChunkCache(new LuaFactory());

  // 1. Parse-check every non-module .lua file (templates, utils, …).
  for (const file of parseOnlyFiles) {
    try {
      await parseCache.get(file, readFileSync(join(stagedDir, file), 'utf8'));
    } catch (error) {
      failures.push({ file, errors: [parseErrorMessage(error)] });
    }
  }

  // 2. Real Init pass over modules/*.lua, strict on any error record.
  //    Parse failures throw out of the chunk cache (outside the registry's
  //    tolerant DoInit catch) — both paths land in `failures`.
  const inventory: StagedInventoryEntry[] = [];
  const host = createLuaHost(logger);
  try {
    for (const file of moduleFiles) {
      const before = logger.records.length;
      let descriptors: readonly { id: string; name: string; sourceFile: string }[] = [];
      let thrown: string | undefined;
      try {
        descriptors = await host.registry.loadFile(file, readFileSync(join(stagedDir, file), 'utf8'));
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

  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `  ${failure.file}:\n${failure.errors.map((e) => `    ${e}`).join('\n')}`)
      .join('\n');
    throw new StagedInitError(
      `staged tree failed Init-pass validation (${failures.length} file(s)):\n${detail}`,
      failures,
    );
  }

  return { inventory, luaFiles: moduleFiles.length + parseOnlyFiles.length, moduleFiles: moduleFiles.length, otherFiles, warnings };
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? `parse failed: ${error.message}` : `parse failed: ${String(error)}`;
}

function comparePosix(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walk(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(root, rel));
    } else if (entry.isFile()) {
      files.push(posix.normalize(rel));
    }
  }
  return files;
}
