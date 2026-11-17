import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ModuleDiffReport } from './diff.js';
import type { ModuleInventoryEntry } from './diff.js';

/**
 * sync_state port (DESIGN.md §9): `sync_state(repo PK, sha, fetched_at,
 * report)`. The SQLite store lands with the db stories; the port below is
 * what the sync service depends on, and the file-backed implementation
 * keeps the exact table shape (one JSON row per repo) so migrations can
 * lift it verbatim. Reports embed the module inventory so the next sync
 * can diff against the previous pin without re-running the Init pass.
 */

export interface ModuleSyncReportFailure {
  /** Tree-relative file path (e.g. `modules/JapScan.lua`). */
  readonly file: string;
  /** First error line for the file (the report keeps one line per file). */
  readonly firstError: string;
}

export interface ModuleSyncReport {
  readonly repo: string;
  readonly sha: string;
  /** ISO-8601 UTC timestamp of the sync. */
  readonly fetchedAt: string;
  /** Where the tree came from: codeload zipball or the local-dir override. */
  readonly source: 'codeload' | 'local-dir';
  /** Pin this sync replaced (null on first install). */
  readonly previousSha: string | null;
  readonly luaFiles: number;
  readonly moduleFiles: number;
  readonly otherFiles: number;
  readonly modules: number;
  readonly warnings: readonly string[];
  /**
   * Tolerated staged-validation failures (upstream-broken files the
   * TolerancePolicy admitted — file + first error). Empty on a clean
   * tree; populated on the real FMD2 tree (its ~5 permanently broken
   * files). Surfaced in Settings + the bootstrap log.
   */
  readonly failures: readonly ModuleSyncReportFailure[];
  readonly diff: ModuleDiffReport;
  /** Inventory of the installed tree — the input for the NEXT diff. */
  readonly inventory: readonly ModuleInventoryEntry[];
}

export interface SyncStateEntry {
  readonly repo: string;
  readonly sha: string;
  readonly fetchedAt: string;
  readonly report: ModuleSyncReport;
}

export interface SyncStateStore {
  get(repo: string): Promise<SyncStateEntry | undefined>;
  record(entry: SyncStateEntry): Promise<void>;
}

interface SyncStateFileShape {
  readonly repos: Record<string, SyncStateEntry>;
}

/** File-backed sync_state (`<dataDir>/sync-state.json`), atomic writes. */
export class FileSyncStateStore implements SyncStateStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(repo: string): Promise<SyncStateEntry | undefined> {
    if (!existsSync(this.filePath)) {
      return undefined;
    }
    const shape = JSON.parse(readFileSync(this.filePath, 'utf8')) as SyncStateFileShape;
    return shape.repos[repo];
  }

  async record(entry: SyncStateEntry): Promise<void> {
    const shape: SyncStateFileShape = existsSync(this.filePath)
      ? (JSON.parse(readFileSync(this.filePath, 'utf8')) as SyncStateFileShape)
      : { repos: {} };
    const next: SyncStateFileShape = { repos: { ...shape.repos, [entry.repo]: entry } };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = join(dirname(this.filePath), `.${basename(this.filePath)}.tmp-${process.pid}`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.filePath);
  }
}
