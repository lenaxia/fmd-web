/**
 * Progress write coalescing (DESIGN.md §4): job progress updates land
 * in an in-memory buffer and reach SQLite at most ONE flush per second
 * per job, regardless of how hot the producer is. The in-memory
 * snapshot is always current for readers (`SqliteJobQueue.progressOf`),
 * so consumers see ≤1 s of persistence latency while the database
 * write volume stays bounded — the write-amount budget that keeps the
 * WAL small and checkpoint pressure low (§4 SQLite discipline).
 *
 * The flush loop runs on an injected {@link SyncClock}: production
 * passes `systemClock`, tests pass a {@link FakeClock} and prove the
 * cadence deterministically (no sleeps).
 */
import { PROGRESS_FLUSH_INTERVAL_MS } from '../lanes.js';
import type { SyncClock } from '../../sync/db/rate-budget.js';

/** Progress values are JSON scalars — the §9 `job.progress` object. */
export type JobProgressValue = string | number | boolean | null;

/** Typed progress snapshot (replace semantics: the newest wins). */
export type JobProgress = { readonly [key: string]: JobProgressValue };

export interface ProgressCoalescerOptions {
  /** The durable write (one UPDATE per flush). Must not throw except on db failure. */
  readonly write: (jobId: string, progress: JobProgress) => void;
  readonly clock: SyncClock;
  /** Minimum spacing between durable writes per job (default 1000 ms, §4). */
  readonly flushIntervalMs?: number;
}

export interface CoalescerStats {
  /** update() calls absorbed. */
  readonly updates: number;
  /** Durable writes performed (≤1/sec/job while the job is live). */
  readonly flushes: number;
  /** Snapshots dropped because a newer one superseded them pre-flush. */
  readonly coalescedAway: number;
}

interface LoopSignal {
  readonly promise: Promise<void>;
  resolve: () => void;
}

export class ProgressCoalescer {
  private readonly write: (jobId: string, progress: JobProgress) => void;
  private readonly clock: SyncClock;
  private readonly flushIntervalMs: number;
  private readonly pending = new Map<string, JobProgress>();
  /** Earliest time each pending job may flush (≤1 flush per interval, §4). */
  private readonly dueAt = new Map<string, number>();
  private updates = 0;
  private flushes = 0;
  private stopped = false;
  private loopSignal: LoopSignal | undefined;
  private loopPromise: Promise<void> | undefined;

  public constructor(opts: ProgressCoalescerOptions) {
    this.write = opts.write;
    this.clock = opts.clock;
    const interval: number = opts.flushIntervalMs ?? PROGRESS_FLUSH_INTERVAL_MS;
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new Error(`flushIntervalMs must be a positive integer, got ${String(interval)}`);
    }
    this.flushIntervalMs = interval;
  }

  /** Buffer an update for `jobId` (replace semantics — newest snapshot wins). */
  public update(jobId: string, progress: JobProgress): void {
    this.updates += 1;
    const hadPending: boolean = this.pending.delete(jobId);
    if (hadPending) {
      this.pending.set(jobId, progress);
      return; // absorbed: the due deadline stays, write count does not grow
    }
    this.pending.set(jobId, progress);
    this.dueAt.set(jobId, this.clock.now() + this.flushIntervalMs);
    this.ensureLoop();
  }

  /** Durably write `jobId`'s buffered snapshot NOW (terminal transitions, close). */
  public flush(jobId: string): void {
    const snapshot: JobProgress | undefined = this.pending.get(jobId);
    if (snapshot === undefined) {
      return;
    }
    this.pending.delete(jobId);
    this.dueAt.delete(jobId);
    this.flushes += 1;
    this.write(jobId, snapshot);
  }

  /**
   * Remove the buffered snapshot for `jobId` WITHOUT writing it — the
   * caller carries it inside its own atomic UPDATE (terminal
   * transitions). Counts as a durable write (it did reach SQLite).
   */
  public take(jobId: string): JobProgress | undefined {
    const snapshot: JobProgress | undefined = this.pending.get(jobId);
    if (snapshot === undefined) {
      return undefined;
    }
    this.pending.delete(jobId);
    this.dueAt.delete(jobId);
    this.flushes += 1;
    return snapshot;
  }

  /** Flush every buffered snapshot (graceful close, §4 shutdown order). */
  public flushAll(): void {
    for (const jobId of [...this.pending.keys()]) {
      this.flush(jobId);
    }
  }

  /** Live (unflushed) snapshot — instant read visibility for consumers. */
  public peek(jobId: string): JobProgress | undefined {
    return this.pending.get(jobId);
  }

  public pendingCount(): number {
    return this.pending.size;
  }

  public stats(): CoalescerStats {
    const absorbed: number = this.updates - this.pending.size;
    return {
      updates: this.updates,
      flushes: this.flushes,
      coalescedAway: Math.max(0, absorbed - this.flushes),
    };
  }

  /** Stop the loop and durably flush everything (idempotent). */
  public async dispose(): Promise<void> {
    this.stopped = true;
    this.loopSignal?.resolve();
    await this.loopPromise;
    this.flushAll();
  }

  private ensureLoop(): void {
    if (this.loopPromise !== undefined) {
      return;
    }
    let resolve: () => void = (): void => {
      /* rebound synchronously by the executor below */
    };
    const promise: Promise<void> = new Promise<void>((res) => {
      resolve = res;
    });
    const signal: LoopSignal = { promise, resolve };
    this.loopSignal = signal;
    this.loopPromise = this.loop(signal);
  }

  private async loop(signal: LoopSignal): Promise<void> {
    while (!this.stopped) {
      const waitMs: number = this.nextWaitMs();
      await Promise.race([this.clock.delay(waitMs), signal.promise]);
      if (this.stopped) {
        break;
      }
      this.drainDue();
    }
  }

  /** Delay until the earliest due snapshot (idle: one interval). */
  private nextWaitMs(): number {
    const now: number = this.clock.now();
    let earliest: number = Number.POSITIVE_INFINITY;
    for (const due of this.dueAt.values()) {
      if (due < earliest) {
        earliest = due;
      }
    }
    if (earliest === Number.POSITIVE_INFINITY) {
      return this.flushIntervalMs;
    }
    return Math.max(0, earliest - now);
  }

  /** Durable-write every snapshot whose ≤1 s window has elapsed. */
  private drainDue(): void {
    const now: number = this.clock.now();
    for (const [jobId, due] of this.dueAt) {
      if (due > now) {
        continue;
      }
      const snapshot: JobProgress | undefined = this.pending.get(jobId);
      this.dueAt.delete(jobId);
      this.pending.delete(jobId);
      if (snapshot !== undefined) {
        this.flushes += 1;
        this.write(jobId, snapshot);
      }
    }
  }
}
