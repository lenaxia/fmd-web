/**
 * SQLite connection discipline for the job queue (DESIGN.md §4, Round-2
 * minor) — the rules every queue connection obeys:
 *
 * - ONE connection per thread: better-sqlite3 handles are not shareable
 *   across `worker_threads`; each thread opens its own connection and
 *   nothing passes a handle across a thread boundary.
 * - `busy_timeout = 5000`: a writer that loses the single-writer race
 *   WAITS (up to 5 s) instead of failing with SQLITE_BUSY — job claims
 *   stay correct under contention, just serialized.
 * - WAL + `synchronous = NORMAL`: crash-safe appends without per-commit
 *   fsync stalls (the fsync boundary is the checkpoint, not the commit).
 * - WAL auto-checkpoint sized (default 1000 pages, tunable) so the WAL
 *   cannot grow unbounded on write-heavy lanes; explicit checkpoints
 *   route through {@link CheckpointMonitor} so stalls are observable.
 * - Write volume bounded by progress coalescing (§4: ≤1 flush/sec/job,
 *   see `../coalesce.ts`), keeping checkpoint pressure low by design.
 */
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import type { JobFailureKind } from '@fmd/contract';

/** §4: claim contention waits, it does not fail. */
export const BUSY_TIMEOUT_MS = 5_000;

/** §4: WAL auto-checkpoint threshold, pages (default 1000, tunable). */
export const WAL_AUTOCHECKPOINT_DEFAULT_PAGES = 1_000;

export interface OpenQueueDbOptions {
  /** WAL auto-checkpoint threshold in pages (default 1000). */
  readonly walAutocheckpointPages?: number;
  /** Open without creating the file (reader-only probes). */
  readonly mustExist?: boolean;
}

/**
 * Open a job-queue connection with the §4 discipline applied. The
 * caller owns the connection: one per thread, closed by the same
 * thread that opened it (`SqliteJobQueue.close()`).
 */
export function openQueueDb(file: string, opts?: OpenQueueDbOptions): Database.Database {
  const pages: number = opts?.walAutocheckpointPages ?? WAL_AUTOCHECKPOINT_DEFAULT_PAGES;
  if (!Number.isInteger(pages) || pages < 0) {
    throw new Error(`wal_autocheckpoint pages must be an integer ≥ 0, got ${String(pages)}`);
  }
  const db: Database.Database = new Database(file, {
    // §4 discipline: file creation only for writer connections.
    fileMustExist: opts?.mustExist ?? false,
  });
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  db.pragma('journal_mode = WAL');
  db.pragma(`wal_autocheckpoint = ${String(pages)}`);
  // WAL + NORMAL: consistent on commit (no torn transactions), durable
  // at checkpoints; POWER loss safety is the checkpoint boundary, and
  // the crash-recovery drill covers the application-level contract.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Create the `job` table if absent — the §9 columns verbatim plus the
 * documented queue-runtime columns (attempts / claim bookkeeping) the
 * watchdogs (§4) read. The remaining §9 tables belong to the db story.
 */
export function ensureJobSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job (
      id              INTEGER PRIMARY KEY,
      type            TEXT    NOT NULL CHECK (type IN ('info','download','update','sync')),
      module_id       TEXT,
      payload         TEXT    NOT NULL,
      state           TEXT    NOT NULL CHECK (state IN ('queued','running','retry','done','failed','cancelled')),
      priority        INTEGER NOT NULL DEFAULT 0,
      progress        TEXT,
      failure         TEXT    CHECK (failure IS NULL OR failure IN ('worker_stalled','engine_oom','net','pack')),
      error           TEXT,
      idempotency_key TEXT UNIQUE,
      idempotency_fp  TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      claimed_by      TEXT,
      claimed_at      INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_type_state ON job (type, state);
    CREATE INDEX IF NOT EXISTS job_retention  ON job (state, updated_at);
  `);
}

/** Valid checkpoint modes (`PRAGMA wal_checkpoint(<mode>)`). */
export type CheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';

/** One completed (or stalled) checkpoint observation. */
export interface CheckpointOutcome {
  readonly mode: CheckpointMode;
  /** true: the checkpoint could NOT finish (a reader pinned the WAL). */
  readonly busy: boolean;
  /** Frames in the WAL at call time. */
  readonly log: number;
  /** Frames the checkpoint managed to move into the main db. */
  readonly checkpointed: number;
  readonly durationMs: number;
  /** busy OR slower than the stall threshold (§4 "stalls monitored"). */
  readonly stalled: boolean;
}

export interface CheckpointStats {
  readonly runs: number;
  readonly stalls: number;
  readonly lastDurationMs: number;
  readonly maxDurationMs: number;
}

/**
 * Checkpoint runner + stall monitor (§4 "checkpoint stalls monitored").
 * Every explicit checkpoint is timed and classified: `busy` (a reader
 * pinned frames) or duration above the threshold counts as a stall.
 * Writers NEVER fail because of a checkpoint — the monitor exists so
 * the stall is visible, not fatal (the drill test proves both halves).
 */
export class CheckpointMonitor {
  private runs = 0;
  private stalls = 0;
  private lastDurationMs = 0;
  private maxDurationMs = 0;
  private readonly stallThresholdMs: number;

  public constructor(stallThresholdMs: number = 500) {
    if (!Number.isFinite(stallThresholdMs) || stallThresholdMs <= 0) {
      throw new Error('stallThresholdMs must be > 0');
    }
    this.stallThresholdMs = stallThresholdMs;
  }

  /**
   * Run `PRAGMA wal_checkpoint(mode)` against `db` (must be the SAME
   * thread's connection — one connection per thread, §4) and record
   * the outcome. Returns the observation; never throws.
   *
   * Stall classification (measured against real SQLite behavior):
   * PASSIVE never waits and never reports `busy` when it quietly
   * leaves frames behind a reader — the observable of a stall is
   * `checkpointed < log`. `busy` and a duration above the threshold
   * count as stalls too.
   */
  public run(db: Database.Database, mode: CheckpointMode = 'PASSIVE'): CheckpointOutcome {
    const started: number = performance.now();
    // better-sqlite3 surfaces the (busy, log, checkpointed) triple as
    // `unknown` from pragma() — cast at the boundary, then guard.
    const rows = db.pragma(`wal_checkpoint(${mode})`) as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const durationMs: number = performance.now() - started;
    const first: { busy: number; log: number; checkpointed: number } | undefined = rows[0];
    const busy: boolean = (first?.busy ?? 0) !== 0;
    const log: number = first?.log ?? 0;
    const checkpointed: number = first?.checkpointed ?? 0;
    const stalled: boolean = busy || checkpointed < log || durationMs > this.stallThresholdMs;
    this.runs += 1;
    this.lastDurationMs = durationMs;
    this.maxDurationMs = Math.max(this.maxDurationMs, durationMs);
    if (stalled) {
      this.stalls += 1;
    }
    return {
      mode,
      busy,
      log,
      checkpointed,
      durationMs,
      stalled,
    };
  }

  public stats(): CheckpointStats {
    return {
      runs: this.runs,
      stalls: this.stalls,
      lastDurationMs: this.lastDurationMs,
      maxDurationMs: this.maxDurationMs,
    };
  }
}

/** Current size of the `-wal` sidecar in bytes (0 when absent). */
export function walSizeBytes(dbFile: string): number {
  try {
    return fs.statSync(`${dbFile}-wal`).size;
  } catch {
    return 0;
  }
}

/** Typed guard for failure-kind columns read back from SQLite. */
export function parseFailureKind(raw: string | null): JobFailureKind | undefined {
  if (raw === null) {
    return undefined;
  }
  switch (raw) {
    case 'worker_stalled':
    case 'engine_oom':
    case 'net':
    case 'pack':
      return raw;
    default:
      throw new Error(`corrupt job row: unknown failure kind ${JSON.stringify(raw)}`);
  }
}
