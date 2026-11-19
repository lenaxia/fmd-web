/**
 * SQLite-backed job queue (DESIGN.md §4/§9) — the production
 * `JobQueue` behind the four lanes (info/download/update/sync), each
 * with independent concurrency.
 *
 * §4 SQLite discipline honored end-to-end:
 * - one connection per thread (`openQueueDb`, §connection.ts); nothing
 *   crosses a `worker_threads` boundary;
 * - claiming is a single-writer transaction: `BEGIN IMMEDIATE` +
 *   `UPDATE ... WHERE id = (SELECT ... state IN ('queued','retry') ...)
 *   RETURNING` — a losing claimant waits on `busy_timeout=5000`, then
 *   re-evaluates against the NEW row states, so a job can never be
 *   claimed twice (the stress drill proves this under 16 threads);
 * - WAL auto-checkpoint sized (default 1000 pages, tunable);
 * - progress writes coalesced ≤1 flush/sec/job (`ProgressCoalescer`);
 * - retention prunes terminal jobs after 30 days (§9), injectable
 *   clock for deterministic tests.
 *
 * §7.1: the persisted state machine is enforced by
 * {@link assertJobTransition} — invalid transitions THROW; jobs are
 * resumable across restarts (progress survives in `job.progress`,
 * orphaned `running` rows re-enter the pool as `retry` at recovery).
 */
import type { JobFailureKind, JobId, JobState, LaneId } from '@fmd/contract';
import type Database from 'better-sqlite3';
import { systemClock, type SyncClock } from '../../sync/db/rate-budget.js';
import {
  ensureJobSchema,
  openQueueDb,
  parseFailureKind,
  type OpenQueueDbOptions,
} from './connection.js';
import { ProgressCoalescer, type JobProgress, type CoalescerStats } from './coalesce.js';
import {
  assertJobTransition,
  InvalidJobTransitionError,
  type JobTransitionDetail,
} from './state-machine.js';
import { resolveRetryBackoffPolicy, retryBackoffMs, type RetryBackoffPolicy } from './backoff.js';
import {
  laneForPayload,
  parseJobPayload,
  payloadFingerprint,
  type JobPayload,
} from './payloads.js';

/** §9 retention: terminal job history pruned after 30 days. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const JOB_STATES: readonly JobState[] = [
  'queued',
  'running',
  'retry',
  'done',
  'failed',
  'cancelled',
];

function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly unknown[]).includes(value);
}

/** The queue's typed view of one job row (§9 `job`). */
export interface QueueJob {
  readonly id: JobId;
  readonly lane: LaneId;
  readonly payload: JobPayload;
  readonly state: JobState;
  readonly priority: number;
  readonly progress: JobProgress | undefined;
  readonly failureKind: JobFailureKind | undefined;
  readonly error: string | undefined;
  readonly attempts: number;
  /**
   * cbAddAsStopped parity: a live (queued/retry) row the claim
   * transaction must SKIP until the resume endpoint lifts the hold.
   */
  readonly paused: boolean;
  /**
   * The §10 idempotency key this row was enqueued under (the chained
   * re-enqueue paths — resume/retry/redownload — probe `<key>#<n>`
   * slots with it; undefined for keyless rows).
   */
  readonly idempotencyKey: string | undefined;
  /**
   * [pipe-health] Retry backoff due stamp (epoch ms): a `retry` row
   * with a future stamp is NOT claimable until then (the claim
   * transaction enforces it). Undefined = claimable immediately.
   */
  readonly nextAttemptAt: number | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EnqueueOptions {
  /** §10 idempotency: same key + same payload ⇒ original job replayed. */
  readonly idempotencyKey?: string;
  /** Higher claims first (ORDER BY priority DESC, id ASC). Default 0. */
  readonly priority?: number;
  /** Add-as-stopped hold: the row is queued but not claimable until resume. */
  readonly paused?: boolean;
}

export interface EnqueueResult {
  readonly job: QueueJob;
  readonly replayed: boolean;
}

export interface ClaimOptions {
  /** Claim bookkeeping (§4 watchdog input: `claimed_by`). */
  readonly workerId?: string;
}

export interface QueueListOptions {
  readonly state?: JobState;
  readonly lane?: LaneId;
  readonly limit?: number;
}

/** The lane-agnostic port. `SqliteJobQueue` is the §4 implementation. */
export interface JobQueue {
  enqueue(payload: JobPayload, opts?: EnqueueOptions): EnqueueResult;
  claim(lane: LaneId, opts?: ClaimOptions): QueueJob | undefined;
  transition(jobId: JobId, to: JobState, detail?: JobTransitionDetail): QueueJob;
  cancel(jobId: JobId): QueueJob;
  /**
   * Lift the add-as-stopped hold (cbAddAsStopped parity): the paused
   * row becomes claimable again. Terminal rows and unknown ids throw
   * (the API service maps both onto the typed envelope).
   */
  resume(jobId: JobId): QueueJob;
  /**
   * Set the hold (downloads-parity pause/disable): the live row becomes
   * un-claimable (`paused = 1`). Terminal rows and unknown ids throw;
   * holding an already-held row returns it unchanged.
   */
  hold(jobId: JobId): QueueJob;
  /**
   * Delete the row (downloads-parity delete task): any state, returns
   * the pre-delete snapshot. Unknown ids throw. In-flight progress
   * buffers drop with the row.
   */
  remove(jobId: JobId): QueueJob;
  /** The job row last enqueued under `key`, or undefined (§10 lookup). */
  byIdempotencyKey(key: string): QueueJob | undefined;
  /** Coalesced progress (≤1 durable flush/sec/job, §4). */
  updateProgress(jobId: JobId, progress: JobProgress): void;
  /** Current progress: live in-memory snapshot, else the persisted one. */
  progressOf(jobId: JobId): JobProgress | undefined;
  get(jobId: JobId): QueueJob | undefined;
  list(opts?: QueueListOptions): QueueJob[];
  counts(lane?: LaneId): Record<JobState, number>;
  /** §9: prune terminal jobs older than 30 days. Returns rows removed. */
  pruneRetention(now?: number): number;
  /** Crash recovery (§7.1 "resumable across restarts"): orphaned
   * `running` rows (no live claim in THIS instance) → `retry`,
   * progress preserved. Returns rows recovered. */
  recoverOrphans(now?: number): number;
  /** §4 watchdog input: `running` rows whose claim went quiet. */
  staleRunningJobs(olderThanMs: number, now?: number): QueueJob[];
  /** Flush buffered progress, then close THIS thread's connection. */
  close(): void;
}

export interface SqliteJobQueueOptions {
  readonly file: string;
  readonly clock?: SyncClock;
  /** Progress flush cadence (default 1000 ms, §4 ≤1/sec/job). */
  readonly flushIntervalMs?: number;
  /** WAL auto-checkpoint pages (default 1000, §4 tunable). */
  readonly walAutocheckpointPages?: number;
  /** Run `recoverOrphans()` at construction (boot-time recovery). */
  readonly recoverOnOpen?: boolean;
  readonly openDbOptions?: OpenQueueDbOptions;
  /**
   * [parity-sweep] M2: terminal-job retention window, read LIVE at
   * every prune (PUT /api/settings/retention applies without restart).
   * Returning ≤ 0 disables pruning (keep forever); absent = the §9
   * fixed 30-day default.
   */
  readonly retentionMs?: () => number;
}

interface JobRow {
  readonly id: number;
  readonly type: JobPayload['type'];
  readonly payload: string;
  readonly state: JobState;
  readonly priority: number;
  readonly progress: string | null;
  readonly failure: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly paused: number;
  readonly idempotency_key: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly next_attempt_at: number | null;
}

/** Replay lookup also carries the fingerprint (§10 conflict check). */
type JobRowWithFp = JobRow & { readonly idempotency_fp: string | null };

/** The §10 key a row was enqueued under (undefined when keyless). */
function idempotencyKeyOf(row: JobRow): string | undefined {
  return row.idempotency_key ?? undefined;
}

function parseProgress(raw: string | null): JobProgress | undefined {
  if (raw === null) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('corrupt job row: progress is not a JSON object');
  }
  return parsed as JobProgress;
}

function toQueueJob(row: JobRow): QueueJob {
  if (!isJobState(row.state)) {
    throw new Error(`corrupt job row: unknown state ${JSON.stringify(row.state)}`);
  }
  return {
    id: String(row.id),
    lane: row.type,
    payload: parseJobPayload(row.payload),
    state: row.state,
    priority: row.priority,
    progress: parseProgress(row.progress),
    failureKind: parseFailureKind(row.failure),
    error: row.error ?? undefined,
    attempts: row.attempts,
    paused: row.paused !== 0,
    idempotencyKey: idempotencyKeyOf(row),
    nextAttemptAt: row.next_attempt_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Thrown when an idempotency key is reused with a DIFFERENT payload (§10). */
export class IdempotencyConflictError extends Error {
  public readonly key: string;

  public constructor(key: string) {
    super(
      `idempotency key ${JSON.stringify(key)} was already used with a different payload`,
    );
    this.name = 'IdempotencyConflictError';
    this.key = key;
  }
}

function moduleIdOf(payload: JobPayload): string | null {
  if (payload.type === 'download' || payload.type === 'info') {
    return payload.moduleId;
  }
  if (payload.type === 'update' && payload.moduleId !== undefined) {
    return payload.moduleId;
  }
  return null;
}

/** Structural cross-checks zod cannot express per-member. */
function validatePayloadSemantics(payload: JobPayload): void {
  if (payload.type === 'sync' && payload.target === 'catalog' && payload.catalogId === undefined) {
    throw new Error("sync job with target 'catalog' requires catalogId");
  }
}

const SELECT_COLUMNS =
  'id, type, payload, state, priority, progress, failure, error, attempts, paused, idempotency_key, created_at, updated_at, next_attempt_at';

export class SqliteJobQueue implements JobQueue {
  private readonly db: Database.Database;
  private readonly clock: SyncClock;
  private readonly coalescer: ProgressCoalescer;
  /** [parity-sweep] M2: live retention window (≤ 0 = keep forever). */
  private readonly retentionMs?: () => number;
  private closed = false;

  private readonly stmtClaim: Database.Statement;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtByIdempotencyKey: Database.Statement;
  private readonly stmtTransition: Database.Statement;
  private readonly stmtResume: Database.Statement;
  private readonly stmtHold: Database.Statement;
  private readonly stmtRemove: Database.Statement;
  private readonly stmtRecover: Database.Statement;
  private readonly stmtPrune: Database.Statement;
  private readonly stmtGet: Database.Statement;
  private readonly stmtStale: Database.Statement;
  private readonly stmtCountsAll: Database.Statement;
  private readonly stmtCountsLane: Database.Statement;
  private readonly stmtProgress: Database.Statement;

  /** Single-writer claim: IMMEDIATE grabs the write lock up front, so
   * the subquery+UPDATE evaluate atomically against committed state. */
  private readonly claimTx: (lane: LaneId, workerId: string, now: number) => JobRow | undefined;
  private readonly enqueueTx: (input: {
    readonly payload: JobPayload;
    readonly moduleId: string | null;
    readonly fingerprint: string;
    readonly priority: number;
    readonly paused: number;
    readonly now: number;
    readonly idempotencyKey: string | null;
  }) => { readonly row: JobRow; readonly replayed: boolean };

  public constructor(opts: SqliteJobQueueOptions) {
    this.clock = opts.clock ?? systemClock;
    if (opts.retentionMs !== undefined) {
      this.retentionMs = opts.retentionMs;
    }
    this.db = openQueueDb(opts.file, opts.openDbOptions ?? {});
    ensureJobSchema(this.db);
    this.coalescer = new ProgressCoalescer({
      write: (jobId, progress): void => {
        this.db
          .prepare('UPDATE job SET progress = @progress, updated_at = @now WHERE id = @id')
          .run({ progress: JSON.stringify(progress), now: this.clock.now(), id: Number(jobId) });
      },
      clock: this.clock,
      ...(opts.flushIntervalMs !== undefined
        ? { flushIntervalMs: opts.flushIntervalMs }
        : {}),
    });

    this.stmtClaim = this.db.prepare(
      `UPDATE job SET
         state = 'running',
         claimed_by = @worker,
         claimed_at = @now,
         attempts = attempts + 1,
         next_attempt_at = NULL,
         updated_at = @now
       WHERE id = (
         SELECT id FROM job
         WHERE type = @lane AND state IN ('queued', 'retry') AND paused = 0
           AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
         ORDER BY priority DESC, id ASC
         LIMIT 1
       )
       RETURNING ${SELECT_COLUMNS}`,
    );
    this.stmtInsert = this.db.prepare(
      `INSERT INTO job
         (type, module_id, payload, state, priority, idempotency_key, idempotency_fp, paused, created_at, updated_at)
       VALUES
         (@type, @moduleId, @payload, 'queued', @priority, @key, @fp, @paused, @now, @now)
       RETURNING ${SELECT_COLUMNS}`,
    );
    this.stmtResume = this.db.prepare(
      `UPDATE job SET paused = 0, updated_at = @now
       WHERE id = @id AND paused = 1
       RETURNING ${SELECT_COLUMNS}`,
    );
    this.stmtHold = this.db.prepare(
      `UPDATE job SET paused = 1, updated_at = @now
       WHERE id = @id AND paused = 0
       RETURNING ${SELECT_COLUMNS}`,
    );
    this.stmtRemove = this.db.prepare(`DELETE FROM job WHERE id = @id RETURNING ${SELECT_COLUMNS}`);
    this.stmtByIdempotencyKey = this.db.prepare(
      `SELECT ${SELECT_COLUMNS}, idempotency_fp FROM job WHERE idempotency_key = @key`,
    );
    this.stmtTransition = this.db.prepare(
      `UPDATE job SET
         state = @to,
         failure = @failure,
         error = @error,
         progress = COALESCE(@progress, progress),
         next_attempt_at = @nextAttempt,
         updated_at = @now
       WHERE id = @id AND state = @from`,
    );
    this.stmtRecover = this.db.prepare(
      `UPDATE job SET state = 'retry', claimed_by = NULL, claimed_at = NULL, updated_at = @now
       WHERE state = 'running'`,
    );
    this.stmtPrune = this.db.prepare(
      `DELETE FROM job
       WHERE state IN ('done', 'failed', 'cancelled') AND updated_at < @cutoff`,
    );
    this.stmtGet = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM job WHERE id = @id`);
    this.stmtStale = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM job
       WHERE state = 'running' AND claimed_at IS NOT NULL AND claimed_at < @cutoff`,
    );
    this.stmtCountsAll = this.db.prepare('SELECT state, COUNT(*) AS n FROM job GROUP BY state');
    this.stmtCountsLane = this.db.prepare(
      "SELECT state, COUNT(*) AS n FROM job WHERE type = @lane GROUP BY state",
    );
    this.stmtProgress = this.db.prepare('SELECT progress FROM job WHERE id = @id');

    this.claimTx = this.db.transaction(
      (lane: LaneId, workerId: string, now: number): JobRow | undefined => {
        const row: JobRow | undefined = this.stmtClaim.get({
          worker: workerId,
          now,
          lane,
        }) as JobRow | undefined;
        return row;
      },
    );

    this.enqueueTx = this.db.transaction((input): { row: JobRow; replayed: boolean } => {
      if (input.idempotencyKey !== null) {
        const existing = this.stmtByIdempotencyKey.get({ key: input.idempotencyKey }) as
          | JobRowWithFp
          | undefined;
        if (existing !== undefined) {
          if (existing.idempotency_fp !== input.fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { row: existing, replayed: true };
        }
      }
      const row: JobRow = this.stmtInsert.get({
        type: input.payload.type,
        moduleId: input.moduleId,
        payload: JSON.stringify(input.payload),
        priority: input.priority,
        key: input.idempotencyKey,
        fp: input.fingerprint,
        paused: input.paused,
        now: input.now,
      }) as JobRow;
      return { row, replayed: false };
    });

    if (opts.recoverOnOpen === true) {
      this.recoverOrphans();
    }
  }

  public enqueue(payload: JobPayload, opts?: EnqueueOptions): EnqueueResult {
    this.assertOpen();
    validatePayloadSemantics(payload);
    laneForPayload(payload); // discriminant ≡ lane; unreachable throw keeps routing honest
    const priority: number = opts?.priority ?? 0;
    if (!Number.isInteger(priority)) {
      throw new Error(`priority must be an integer, got ${String(priority)}`);
    }
    const { row, replayed } = this.enqueueTx({
      payload,
      moduleId: moduleIdOf(payload),
      fingerprint: payloadFingerprint(payload),
      priority,
      paused: opts?.paused === true ? 1 : 0,
      now: this.clock.now(),
      idempotencyKey: opts?.idempotencyKey ?? null,
    });
    return { job: toQueueJob(row), replayed };
  }

  /** cbAddAsStopped parity: clear the hold; unknown/terminal rows throw. */
  public resume(jobId: JobId): QueueJob {
    this.assertOpen();
    const current: QueueJob | undefined = this.get(jobId);
    if (current === undefined) {
      throw new Error(`resume target not found: job ${jobId}`);
    }
    if (current.state === 'done' || current.state === 'failed' || current.state === 'cancelled') {
      throw new Error(`job ${jobId} is ${current.state} — nothing to resume`);
    }
    if (!current.paused) {
      return current; // idempotent no-op: hold already lifted
    }
    const row = this.stmtResume.get({ id: Number(jobId), now: this.clock.now() }) as
      | JobRow
      | undefined;
    if (row === undefined) {
      // Raced a concurrent resume/cancel — surface the fresh row.
      const fresh: QueueJob | undefined = this.get(jobId);
      if (fresh === undefined) {
        throw new Error(`job ${jobId} vanished after resume (db corruption)`);
      }
      return fresh;
    }
    return toQueueJob(row);
  }

  /** Downloads-parity hold: live row → paused=1; unknown/terminal throw. */
  public hold(jobId: JobId): QueueJob {
    this.assertOpen();
    const current: QueueJob | undefined = this.get(jobId);
    if (current === undefined) {
      throw new Error(`hold target not found: job ${jobId}`);
    }
    if (current.state === 'done' || current.state === 'failed' || current.state === 'cancelled') {
      throw new Error(`job ${jobId} is ${current.state} — cannot hold a terminal row`);
    }
    if (current.paused) {
      return current; // idempotent no-op: hold already set
    }
    const row = this.stmtHold.get({ id: Number(jobId), now: this.clock.now() }) as
      | JobRow
      | undefined;
    if (row === undefined) {
      // Raced a concurrent hold/resume — surface the fresh row.
      const fresh: QueueJob | undefined = this.get(jobId);
      if (fresh === undefined) {
        throw new Error(`job ${jobId} vanished after hold (db corruption)`);
      }
      return fresh;
    }
    return toQueueJob(row);
  }

  /** Downloads-parity delete: any state; returns the pre-delete snapshot. */
  public remove(jobId: JobId): QueueJob {
    this.assertOpen();
    const row = this.stmtRemove.get({ id: Number(jobId) }) as JobRow | undefined;
    if (row === undefined) {
      throw new Error(`remove target not found: job ${jobId}`);
    }
    this.coalescer.take(jobId); // drop any buffered progress with the row
    return toQueueJob(row);
  }

  public claim(lane: LaneId, opts?: ClaimOptions): QueueJob | undefined {
    this.assertOpen();
    const row = this.claimTx(lane, opts?.workerId ?? 'worker', this.clock.now());
    return row === undefined ? undefined : toQueueJob(row);
  }

  public transition(jobId: JobId, to: JobState, detail?: JobTransitionDetail): QueueJob {
    this.assertOpen();
    const current: QueueJob | undefined = this.get(jobId);
    if (current === undefined) {
      throw new Error(`transition target not found: job ${jobId}`);
    }
    assertJobTransition(current.state, to, detail);
    // Terminal transitions carry the coalesced snapshot atomically
    // (single UPDATE), then the buffer drops it.
    const pendingProgress: JobProgress | undefined =
      to === 'done' || to === 'failed' || to === 'cancelled'
        ? this.coalescer.take(jobId)
        : undefined;
    const pendingProgressJson: string | null =
      pendingProgress === undefined ? null : JSON.stringify(pendingProgress);
    const result = this.stmtTransition.run({
      to,
      from: current.state,
      id: Number(jobId),
      failure: to === 'failed' ? (detail?.failureKind ?? null) : null,
      error: detail?.error ?? null,
      progress: pendingProgressJson,
      // [pipe-health] retry rows carry the backoff due stamp; every
      // other transition clears it (claim clears it again as a belt-
      // and-braces for raw-SQL claim paths).
      nextAttempt: to === 'retry' ? (detail?.nextAttemptAt ?? null) : null,
      now: this.clock.now(),
    });
    if (result.changes !== 1) {
      // Raced: another thread moved the row between our read and write.
      const actual: QueueJob | undefined = this.get(jobId);
      throw new InvalidJobTransitionError(actual?.state ?? current.state, to);
    }
    const updated: QueueJob | undefined = this.get(jobId);
    if (updated === undefined) {
      throw new Error(`job ${jobId} vanished after transition (db corruption)`);
    }
    return updated;
  }

  public cancel(jobId: JobId): QueueJob {
    return this.transition(jobId, 'cancelled');
  }

  public updateProgress(jobId: JobId, progress: JobProgress): void {
    this.assertOpen();
    this.coalescer.update(jobId, progress);
  }

  public progressOf(jobId: JobId): JobProgress | undefined {
    this.assertOpen();
    const live: JobProgress | undefined = this.coalescer.peek(jobId);
    if (live !== undefined) {
      return live;
    }
    const row = this.stmtProgress.get({ id: Number(jobId) }) as
      | { progress: string | null }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return parseProgress(row.progress);
  }

  public get(jobId: JobId): QueueJob | undefined {
    this.assertOpen();
    const row = this.stmtGet.get({ id: Number(jobId) }) as JobRow | undefined;
    return row === undefined ? undefined : toQueueJob(row);
  }

  /**
   * The newest job row holding `key` (§10 idempotent re-enqueue support:
   * a TERMINAL replay may be superseded by a fresh attempt whose key is
   * chained off the original — the API adapter probes this to pick the
   * chain slot). `undefined` when the key was never used.
   */
  public byIdempotencyKey(key: string): QueueJob | undefined {
    this.assertOpen();
    const row = this.stmtByIdempotencyKey.get({ key }) as JobRowWithFp | undefined;
    return row === undefined ? undefined : toQueueJob(row);
  }

  public list(opts?: QueueListOptions): QueueJob[] {
    this.assertOpen();
    const fragments: string[] = [];
    const params: Record<string, string | number> = {};
    if (opts?.state !== undefined) {
      fragments.push('state = @state');
      params.state = opts.state;
    }
    if (opts?.lane !== undefined) {
      fragments.push('type = @lane');
      params.lane = opts.lane;
    }
    const where: string = fragments.length === 0 ? '' : ` WHERE ${fragments.join(' AND ')}`;
    const limit: number = opts?.limit ?? 200;
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM job${where} ORDER BY updated_at DESC, id DESC LIMIT @limit`,
      )
      .all({ ...params, limit }) as JobRow[];
    return rows.map(toQueueJob);
  }

  public counts(lane?: LaneId): Record<JobState, number> {
    this.assertOpen();
    const counts: Record<JobState, number> = {
      queued: 0,
      running: 0,
      retry: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    const rows = (
      lane === undefined
        ? this.stmtCountsAll.all()
        : this.stmtCountsLane.all({ lane })
    ) as Array<{ state: string; n: number }>;
    for (const row of rows) {
      if (isJobState(row.state)) {
        counts[row.state] = row.n;
      }
    }
    return counts;
  }

  public pruneRetention(now: number = this.clock.now()): number {
    this.assertOpen();
    // [parity-sweep] M2: the live provider wins (PUT /api/settings/retention
    // applies on the NEXT sweep); ≤ 0 keeps every terminal row forever.
    const windowMs: number = this.retentionMs !== undefined ? this.retentionMs() : RETENTION_MS;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      return 0;
    }
    const result = this.stmtPrune.run({ cutoff: now - windowMs });
    return result.changes;
  }

  public recoverOrphans(now: number = this.clock.now()): number {
    this.assertOpen();
    const result = this.stmtRecover.run({ now });
    return result.changes;
  }

  public staleRunningJobs(olderThanMs: number, now: number = this.clock.now()): QueueJob[] {
    this.assertOpen();
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new Error('olderThanMs must be ≥ 0');
    }
    const rows = this.stmtStale.all({ cutoff: now - olderThanMs }) as JobRow[];
    return rows.map(toQueueJob);
  }

  /** Coalescer observability (write-count assertions in the drill). */
  public coalescerStats(): CoalescerStats {
    return this.coalescer.stats();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // §4 shutdown order: flush coalesced progress, then close the
    // connection this thread owns.
    this.coalescer.flushAll();
    void this.coalescer.dispose();
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('job queue is closed');
    }
  }
}

// ── lane runner: independent per-lane concurrency (§4) ──────────────

/** What a lane handler decided for its job (typed — no throw-based flow). */
export type LaneHandlerOutcome =
  | { readonly type: 'done' }
  | {
      /** Request another attempt (§7.1 running → retry). */
      readonly type: 'retry';
      readonly error?: string;
      /** Failure kind if this was the last allowed attempt (default `net`). */
      readonly exhaustedKind?: JobFailureKind;
    }
  | { readonly type: 'failed'; readonly kind: JobFailureKind; readonly error?: string };

export type LaneHandler = (
  job: QueueJob,
  ctx: { setProgress(progress: JobProgress): void },
) => Promise<LaneHandlerOutcome>;

export interface LaneRunnerLaneOptions {
  /** Concurrent in-flight jobs for THIS lane only (§4 independence). */
  readonly concurrency: number;
  readonly handler: LaneHandler;
  /** Backoff between empty-poll claims (default 250 ms). */
  readonly pollIntervalMs?: number;
}

export interface LaneRunnerOptions {
  readonly clock?: SyncClock;
  readonly lanes: Partial<Record<LaneId, LaneRunnerLaneOptions>>;
  /** Total claims allowed per job before `retry` exhausts (default 3). */
  readonly maxAttempts?: number;
  readonly workerIdPrefix?: string;
  /**
   * [pipe-health] Retry backoff policy (exponential + jitter, 24 h
   * cap — see `backoff.ts`): a retrying job's `next_attempt_at` is
   * stamped `now + backoff(attempts)`, the lane slot is freed
   * immediately, and the claim transaction holds the row out of the
   * pool until the stamp elapses. Partial overrides merge over the
   * conservative defaults; inject a deterministic `jitter` in tests
   * to pin the curve.
   */
  readonly retryBackoff?: Partial<RetryBackoffPolicy>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Drives the four lanes with independent concurrency: each lane has
 * its own claim loop × `concurrency` slots; a busy download lane never
 * starves the info lane (they share only the queue's single-writer
 * claim discipline, which serializes the claim microseconds, not the
 * handler work). Default clock = wall clock; tests inject FakeClock.
 */
export class LaneRunner {
  private readonly queue: JobQueue;
  private readonly clock: SyncClock;
  private readonly lanes: Partial<Record<LaneId, LaneRunnerLaneOptions>>;
  private readonly maxAttempts: number;
  private readonly retryBackoff: RetryBackoffPolicy;
  private readonly workerIdPrefix: string;
  private readonly active = new Map<LaneId, number>();
  private readonly loopPromises: Promise<void>[] = [];
  private stopping = false;
  private stopSignal: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;

  public constructor(queue: JobQueue, opts: LaneRunnerOptions) {
    this.queue = queue;
    this.clock = opts.clock ?? systemClock;
    this.lanes = opts.lanes;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryBackoff = resolveRetryBackoffPolicy(opts.retryBackoff);
    this.workerIdPrefix = opts.workerIdPrefix ?? 'lane';
    for (const [lane, laneOpts] of Object.entries(this.lanes) as Array<[LaneId, LaneRunnerLaneOptions]>) {
      if (!Number.isInteger(laneOpts.concurrency) || laneOpts.concurrency < 1) {
        throw new Error(`lane ${lane}: concurrency must be an integer ≥ 1`);
      }
      this.active.set(lane, 0);
    }
  }

  /** Spawn every lane's slots (idempotent-free: call once). */
  public start(): void {
    if (this.stopSignal !== undefined) {
      throw new Error('LaneRunner already started');
    }
    let resolve: () => void = (): void => {
      /* rebound synchronously by the executor below */
    };
    const signal: Promise<void> = new Promise<void>((res) => {
      resolve = res;
    });
    this.stopSignal = signal;
    this.resolveStop = resolve;
    for (const [lane, laneOpts] of Object.entries(this.lanes) as Array<
      [LaneId, LaneRunnerLaneOptions]
    >) {
      for (let slot = 0; slot < laneOpts.concurrency; slot += 1) {
        this.loopPromises.push(this.runSlot(lane, laneOpts, slot, signal));
      }
    }
  }

  /** Concurrent in-flight handler count for one lane (watchdog/test input). */
  public activeCount(lane: LaneId): number {
    return this.active.get(lane) ?? 0;
  }

  /** Stop claiming; in-flight handlers run to completion, then loops exit. */
  public async stop(): Promise<void> {
    if (this.resolveStop === undefined) {
      return;
    }
    this.stopping = true;
    this.resolveStop();
    await Promise.all(this.loopPromises);
  }

  private async runSlot(
    lane: LaneId,
    laneOpts: LaneRunnerLaneOptions,
    slot: number,
    stopPromise: Promise<void>,
  ): Promise<void> {
    const workerId: string = `${this.workerIdPrefix}-${lane}-${String(slot)}`;
    const pollIntervalMs: number = laneOpts.pollIntervalMs ?? 250;
    while (!this.stopping) {
      const job: QueueJob | undefined = this.queue.claim(lane, { workerId });
      if (job === undefined) {
        await Promise.race([this.clock.delay(pollIntervalMs), stopPromise]);
        continue;
      }
      this.active.set(lane, (this.active.get(lane) ?? 0) + 1);
      try {
        const outcome: LaneHandlerOutcome = await laneOpts.handler(job, {
          setProgress: (progress: JobProgress): void => {
            this.queue.updateProgress(job.id, progress);
          },
        });
        this.applyOutcome(job, outcome);
        // [pipe-health] No retry dwell: a retry outcome stamps
        // `next_attempt_at` (exponential backoff — applyOutcome) and
        // the slot frees immediately; the claim transaction holds the
        // row out until the stamp elapses, so the 'retry' state stays
        // observable on the API/WS surface the whole backoff long and
        // OTHER work (different jobs, different hosts) proceeds in
        // parallel instead of waiting out a held slot.
      } catch (cause: unknown) {
        // Handler escaped without an outcome: the worker misbehaved —
        // §4 semantics classify that as worker_stalled.
        this.applyOutcome(job, {
          type: 'failed',
          kind: 'worker_stalled',
          error: `unhandled handler error: ${messageOf(cause)}`,
        });
      } finally {
        this.active.set(lane, Math.max(0, (this.active.get(lane) ?? 0) - 1));
      }
    }
  }

  private applyOutcome(job: QueueJob, outcome: LaneHandlerOutcome): void {
    try {
      switch (outcome.type) {
        case 'done':
          this.queue.transition(job.id, 'done');
          break;
        case 'retry': {
          if (job.attempts < this.maxAttempts) {
            // [pipe-health] exponential+jitter backoff (24 h cap): the
            // row flips to 'retry' with a due stamp; the slot is freed
            // and the claim re-picks the job once the stamp elapses.
            this.queue.transition(
              job.id,
              'retry',
              outcome.error !== undefined
                ? {
                    error: outcome.error,
                    nextAttemptAt: this.clock.now() + retryBackoffMs(this.retryBackoff, job.attempts),
                  }
                : { nextAttemptAt: this.clock.now() + retryBackoffMs(this.retryBackoff, job.attempts) },
            );
          } else {
            this.queue.transition(job.id, 'failed', {
              failureKind: outcome.exhaustedKind ?? 'net',
              error: outcome.error ?? `retry attempts exhausted (${String(this.maxAttempts)})`,
            });
          }
          break;
        }
        case 'failed':
          this.queue.transition(
            job.id,
            'failed',
            outcome.error !== undefined
              ? { failureKind: outcome.kind, error: outcome.error }
              : { failureKind: outcome.kind },
          );
          break;
      }
    } catch (cause: unknown) {
      if (!(cause instanceof InvalidJobTransitionError)) {
        throw cause;
      }
      // Benign race: the job was cancelled/terminal while the handler
      // ran — its outcome no longer applies (cooperative cancellation).
    }
  }
}

