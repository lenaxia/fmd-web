import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HostLogRecord } from '@fmd/contract';
import type { LuaHost, LuaHostFactory } from '../contract.js';
import { maxToleratedSyncFailures } from '@fmd/contract';
import { createMemoryLogger, type MemoryLogger } from '../lua/logger.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../lua/abort.js';
import { RecordedResponseResolver } from '../shims/http-shim.js';
import { initShimsHook, FMD2_LUA_ROOT } from '../shims/install.js';
import { toRegistration, type RegistrationRecord } from './capabilities.js';

/**
 * ModuleSyncService (DESIGN.md §2 lua/ sync + §5.1 Init pass + D3): the
 * full-tree registration sweep wired through the Lua host. Per-file ERROR
 * ISOLATION — one broken module file (syntax error, Init() throwing, a
 * failing require, an engine-level failure) is captured per file and NEVER
 * breaks the sweep; every other file still registers. Every Init engine is
 * offline (§5.4 recorded resolver, empty → any accidental Init-time HTTP
 * fails without touching the network).
 *
 * The sweep produces the module_state registry rows (§9 registry columns)
 * and a deterministic summary (the committed registration artifact).
 */

export interface ModuleSyncOptions {
  /** The synced lua/ tree root (default: the pinned FMD2 checkout). */
  readonly luaRoot?: string;
  /** Modules directory (default: `<luaRoot>/modules`). */
  readonly modulesDir?: string;
  /**
   * Lua host factory (injected by the composition root): constructs the
   * sweep's host behind the contract LuaHost interface — substitute
   * hosts wire in here without touching the sweep.
   */
  readonly hostFactory: LuaHostFactory;
}

export interface FileSweepResult {
  /** Module file name relative to the modules dir (e.g. `AsuraScans.lua`). */
  readonly file: string;
  /** true when the file registered ≥1 module. */
  readonly ok: boolean;
  readonly registrations: readonly RegistrationRecord[];
  /** Captured per-file error (isolation: present only when !ok). */
  readonly error?: string;
}

export interface SweepFailure {
  readonly file: string;
  readonly error: string;
}

export interface SweepSummary {
  readonly luaRoot: string;
  readonly treeSha: string;
  readonly totalFiles: number;
  /** Files that registered ≥1 module. */
  readonly registeredFiles: number;
  readonly failedFiles: number;
  /** Total registrations across all files. */
  readonly totalModules: number;
  readonly failures: readonly SweepFailure[];
  /** D3 known-broken flag id → module names carrying it. */
  readonly knownBroken: Readonly<Record<string, readonly string[]>>;
  /** §5.2 event → number of modules declaring an On* handler. */
  readonly eventCoverage: Readonly<Record<string, number>>;
  /**
   * Whether the failure count sits within the SHARED tolerance policy
   * (contract/tolerance.ts — the same constants the staged sync gate
   * uses). The sweep itself is always per-file isolated; this flag is
   * the single-source annotation surfaces read (no second opinion).
   */
  readonly withinTolerance: boolean;
}

export interface SweepResult {
  readonly files: readonly FileSweepResult[];
  readonly summary: SweepSummary;
  /** All registrations, canonical (file, name) order. */
  readonly registrations: readonly RegistrationRecord[];
}

const DO_INIT_PREFIX = 'LUA>DoInit("';
const DO_INIT_SUFFIX = '")> ';

/** Canonical registry order: (file, name) — identical across sweep/cache boots. */
export function sortRegistrations(modules: readonly RegistrationRecord[]): RegistrationRecord[] {
  return [...modules].sort((a, b) =>
    a.file === b.file ? (a.name < b.name ? -1 : 1) : a.file < b.file ? -1 : 1,
  );
}

/**
 * The sweep surface consumers use (engine-boundary story): the structural
 * PORT behind ModuleRuntime.createSweep — stub substrates implement this
 * without the class's private state, StartupRegistryService accepts it.
 */
export interface ModuleTreeSweepPort {
  /** The `*.lua` module files of the tree, sorted (the sweep order). */
  discoverFiles(): string[];
  /** Content SHA of the tree (or an explicit file list). */
  treeSha(files?: readonly string[]): string;
  /** Full-tree registration sweep (per-file error isolation). */
  sweep(): Promise<SweepResult>;
}

export class ModuleSyncService implements ModuleTreeSweepPort {
  private readonly luaRoot: string;
  private readonly modulesDir: string;
  private readonly hostFactory: LuaHostFactory;

  constructor(options: ModuleSyncOptions) {
    this.luaRoot = resolve(options.luaRoot ?? FMD2_LUA_ROOT);
    this.modulesDir = resolve(options.modulesDir ?? join(this.luaRoot, 'modules'));
    this.hostFactory = options.hostFactory;
  }

  /** The `*.lua` module files of the tree, sorted (the sweep order). */
  discoverFiles(): string[] {
    return readdirSync(this.modulesDir)
      .filter((f) => f.endsWith('.lua'))
      .sort();
  }

  /**
   * SHA-256 over the swept tree: sorted `file\0sha256(source)` lines — the
   * re-Init gate for the startup registry (§9: re-Init on lua SHA change).
   */
  treeSha(files?: readonly string[]): string {
    const list = files ?? this.discoverFiles();
    const hash = createHash('sha256');
    for (const file of list) {
      const source = this.readSource(file);
      hash.update(`${file}\0${createHash('sha256').update(source).digest('hex')}\n`);
    }
    return hash.digest('hex');
  }

  readSource(file: string): string {
    return readFileSync(join(this.modulesDir, file), 'utf8');
  }

  /**
   * The Init sweep over the whole tree. NEVER throws — every file runs in
   * its own engine and its own try/catch; failures come back as per-file
   * `error` entries (Lua errors surface through the host log's
   * `LUA>DoInit("<file>")>` records, unexpected JS-side throws through the
   * same catch).
   */
  async sweep(): Promise<SweepResult> {
    const files = this.discoverFiles();
    const treeSha = this.treeSha(files);
    const logger = createMemoryLogger();
    const host = this.hostFactory.createHost(logger);
    const out: FileSweepResult[] = [];
    try {
      for (const file of files) {
        out.push(await this.sweepFile(host, logger, file));
      }
    } finally {
      await host.dispose();
    }
    const registrations = sortRegistrations(out.flatMap((f) => f.registrations));
    return {
      files: out,
      registrations,
      summary: this.buildSummary(treeSha, files, out, registrations),
    };
  }

  /** One file's Init pass — the isolation boundary. */
  private async sweepFile(
    host: LuaHost,
    logger: MemoryLogger,
    file: string,
  ): Promise<FileSweepResult> {
    const recordsBefore = logger.records.length;
    try {
      const source = this.readSource(file);
      const abort = new DeadlineAbortHandle(createDeadlineCells());
      const hook = initShimsHook({
        resolver: new RecordedResponseResolver([]), // offline: no Init-time network
        abort,
        logger,
        moduleId: file,
        luaRoot: this.luaRoot,
      });
      const descriptors = await host.registry.loadFile(file, source, hook);
      if (descriptors.length > 0) {
        const registrations = descriptors.map((d) => toRegistration(d, source, { luaRoot: this.luaRoot }));
        return { file, ok: true, registrations };
      }
      return { file, ok: false, registrations: [], error: this.fileError(logger, file, recordsBefore) };
    } catch (error) {
      // JS-side failure (bridge, shim install, …) — captured per file.
      const message = error instanceof Error ? error.message : String(error);
      return { file, ok: false, registrations: [], error: message };
    }
  }

  /** The file's Init error from the host log (FMD2 DoInit message shape). */
  private fileError(logger: MemoryLogger, file: string, recordsBefore: number): string {
    const needle = `${DO_INIT_PREFIX}${file}${DO_INIT_SUFFIX}`;
    const found = logger.records
      .slice(recordsBefore)
      .filter((r: HostLogRecord) => r.level === 'error' && r.message.startsWith(needle))
      .map((r) => r.message.slice(needle.length));
    return found.at(-1) ?? 'Init pass registered no module';
  }

  private buildSummary(
    treeSha: string,
    files: readonly string[],
    results: readonly FileSweepResult[],
    registrations: readonly RegistrationRecord[],
  ): SweepSummary {
    const knownBroken: Record<string, string[]> = {};
    for (const reg of registrations) {
      for (const flag of reg.capabilities.known_broken_flags) {
        (knownBroken[flag] ??= []).push(reg.name);
      }
    }
    for (const names of Object.values(knownBroken)) {
      names.sort();
    }
    const eventCoverage: Record<string, number> = {};
    for (const reg of registrations) {
      for (const event of reg.capabilities.events) {
        eventCoverage[event] = (eventCoverage[event] ?? 0) + 1;
      }
    }
    return {
      luaRoot: this.luaRoot,
      treeSha,
      totalFiles: files.length,
      registeredFiles: results.filter((f) => f.ok).length,
      failedFiles: results.filter((f) => !f.ok).length,
      totalModules: registrations.length,
      failures: results
        .filter((f) => !f.ok)
        .map((f) => ({ file: f.file, error: f.error ?? 'Init pass registered no module' })),
      knownBroken,
      eventCoverage,
      withinTolerance: results.filter((f) => !f.ok).length <= maxToleratedSyncFailures(files.length),
    };
  }
}
