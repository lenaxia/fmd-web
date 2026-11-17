import type { JobFailureKind } from '@fmd/contract';
import type { EventDispatchResult } from '../contract.js';
import { DEFAULT_RSS_BUDGET_BYTES, WORKER_STALL_TOLERANCE } from '../lua/worker-pool.js';

/**
 * Wedged-worker watchdog + engine robustness policy (DESIGN.md §4, §5.12,
 * D6):
 *
 * - per-event wall-clock deadline with HTTP-abort: a miss the abort handle
 *   could interrupt is a normal timeout — the event fails, the worker is
 *   fine;
 * - a worker missing its deadline TWICE with a non-HTTP hang (`wedged`,
 *   i.e. the abort could not unblock it) is RECYCLED (engine disposed +
 *   rebuilt) and its job fails `worker_stalled`;
 * - WASM OOM (`LUA_ERRMEM`): engine quarantine + rebuild, the job is
 *   retried ONCE on the fresh engine; a second OOM fails `engine_oom` (D6);
 * - the engine RSS budget is 2 GB for the pool, engines recycled at 25 %
 *   over budget (probe-injectable; the pool wiring passes its live RSS).
 *
 * The supervisor is engine-agnostic: `SupervisorEngine` is the seam the
 * real worker adapter (and the fault-injection fake tests) implement.
 */

/** One dispatch attempt against one engine, classified for the policy. */
export type AttemptOutcome =
  | { readonly kind: 'completed'; readonly result: EventDispatchResult }
  | {
      readonly kind: 'deadline-missed';
      /** true = non-HTTP hang: the HTTP-abort could not unblock the event (§4 wedged worker). */
      readonly wedged: boolean;
      readonly reason: string;
    }
  | { readonly kind: 'engine-oom'; readonly reason: string }
  | { readonly kind: 'error'; readonly reason: string };

/** One engine (worker) the supervisor drives; the recycle/quarantine seam. */
export interface SupervisorEngine {
  readonly id: string;
  /** One event dispatch attempt (deadline + abort are the caller's). */
  run(): AttemptOutcome;
  /** Engine memory footprint for the pool RSS budget (§5.12). */
  rssBytes(): number;
  /** Release the engine's resources (dispose on recycle/quarantine). */
  dispose(): void;
}

export interface SupervisorEvent {
  readonly type:
    | 'deadline-missed'
    | 'worker-recycled'
    | 'engine-quarantined'
    | 'engine-rebuilt'
    | 'rss-recycle';
  readonly engineId: string;
  readonly detail: string;
}

export interface SupervisorOptions {
  /** Pool RSS budget (§5.12: 2 GB default). */
  readonly rssBudgetBytes: number;
  /** Recycling threshold factor over budget (§5.12: 25 % over). */
  readonly rssRecycleFactor: number;
  /** Consecutive wedged deadline misses tolerated before recycling (§4: 2). */
  readonly stallTolerance: number;
  /** OOM retries on a fresh engine before failing `engine_oom` (D6: 1). */
  readonly oomRetries: number;
}

export const DEFAULT_SUPERVISOR_OPTIONS: SupervisorOptions = {
  rssBudgetBytes: DEFAULT_RSS_BUDGET_BYTES,
  rssRecycleFactor: 1.25,
  stallTolerance: WORKER_STALL_TOLERANCE,
  oomRetries: 1,
};

/** §5.12: engines recycled at 25 % over the 2 GB pool budget. */
export function rssRecycleThresholdBytes(options: Pick<SupervisorOptions, 'rssBudgetBytes' | 'rssRecycleFactor'>): number {
  return Math.floor(options.rssBudgetBytes * options.rssRecycleFactor);
}

/** Terminal outcome of a supervised job execution (§7.1 failure kinds). */
export type SupervisedExecution =
  | { readonly status: 'done'; readonly result: EventDispatchResult; readonly attempts: number }
  | {
      readonly status: 'failed';
      readonly failureKind: JobFailureKind;
      readonly reason: string;
      readonly attempts: number;
    };

export class EngineSupervisor {
  private current: SupervisorEngine;
  private currentDisposed = false;
  private wedgedStrikes = 0;
  private readonly events: SupervisorEvent[] = [];
  private nextEngineId = 1;

  constructor(
    private readonly createEngine: (id: string) => SupervisorEngine,
    private readonly options: SupervisorOptions = DEFAULT_SUPERVISOR_OPTIONS,
    /** Live pool RSS probe; defaults to the current engine's footprint. */
    private readonly poolRssBytes: () => number = () => this.current.rssBytes(),
  ) {
    this.current = createEngine(this.nextEngineIdLabel());
  }

  /** The live engine (job runners dispatch their events through it). */
  get engine(): SupervisorEngine {
    this.ensureLive();
    return this.current;
  }

  /** Observability feed (recycles, quarantines, strikes). */
  get log(): readonly SupervisorEvent[] {
    return this.events;
  }

  get strikeCount(): number {
    return this.wedgedStrikes;
  }

  /**
   * RSS pre-check (§5.12): recycle the engine when the pool is 25 % over
   * budget. Returns true when a recycle happened.
   */
  enforceRssBudget(): boolean {
    this.ensureLive();
    const threshold = rssRecycleThresholdBytes(this.options);
    if (this.poolRssBytes() <= threshold) {
      return false;
    }
    const id = this.current.id;
    this.current.dispose();
    this.events.push({
      type: 'rss-recycle',
      engineId: id,
      detail: `pool rss over threshold ${String(threshold)} bytes`,
    });
    this.rebuild('rss budget exceeded');
    return true;
  }

  /**
   * Run one event attempt under the robustness policy. This is the
   * wedged-worker watchdog entry point (§4): strike on wedged
   * deadline misses, recycle at the tolerance, quarantine+retry on OOM.
   */
  runAttempt(): SupervisedExecution {
    this.ensureLive();
    // RSS budget gate before every attempt.
    this.enforceRssBudget();

    const attempt = this.current.run();
    switch (attempt.kind) {
      case 'completed':
        this.wedgedStrikes = 0;
        return { status: 'done', result: attempt.result, attempts: 1 };

      case 'deadline-missed': {
        this.events.push({
          type: 'deadline-missed',
          engineId: this.current.id,
          detail: attempt.reason + (attempt.wedged ? ' (non-HTTP hang)' : ''),
        });
        if (!attempt.wedged) {
          // HTTP-aborted timeout: the abort unblocked the worker — the
          // event fails (job-level retry policy decides), worker survives.
          return { status: 'failed', failureKind: 'net', reason: attempt.reason, attempts: 1 };
        }
        this.wedgedStrikes += 1;
        if (this.wedgedStrikes < this.options.stallTolerance) {
          return { status: 'failed', failureKind: 'net', reason: attempt.reason, attempts: 1 };
        }
        // Double wedged miss → recycle worker, job fails worker_stalled (§4).
        const stalledId = this.current.id;
        this.current.dispose();
        this.events.push({
          type: 'worker-recycled',
          engineId: stalledId,
          detail: `${String(this.wedgedStrikes)} consecutive non-HTTP deadline misses`,
        });
        this.rebuild('worker stalled');
        this.wedgedStrikes = 0;
        return {
          status: 'failed',
          failureKind: 'worker_stalled',
          reason: `worker missed its deadline ${String(this.options.stallTolerance)} times (non-HTTP hang); worker recycled`,
          attempts: this.options.stallTolerance,
        };
      }

      case 'engine-oom':
        return this.quarantineAndRetry(attempt.reason);

      case 'error':
        return { status: 'failed', failureKind: 'net', reason: attempt.reason, attempts: 1 };
    }
  }

  /**
   * D6: LUA_ERRMEM → engine quarantine + rebuild, job retried once on the
   * fresh engine; a second OOM fails `engine_oom`.
   */
  private quarantineAndRetry(firstReason: string): SupervisedExecution {
    const deadId = this.current.id;
    this.current.dispose();
    this.events.push({
      type: 'engine-quarantined',
      engineId: deadId,
      detail: firstReason,
    });
    this.rebuild(firstReason);

    let totalAttempts = 1; // the initial OOM attempt
    let retriesLeft = this.options.oomRetries;
    let lastReason = firstReason;
    while (retriesLeft > 0) {
      const retry = this.current.run();
      totalAttempts += 1;
      retriesLeft -= 1;
      if (retry.kind === 'completed') {
        return { status: 'done', result: retry.result, attempts: totalAttempts };
      }
      if (retry.kind === 'engine-oom') {
        const quarantinedId = this.current.id;
        this.current.dispose();
        this.events.push({
          type: 'engine-quarantined',
          engineId: quarantinedId,
          detail: retry.reason,
        });
        lastReason = retry.reason;
        if (retriesLeft > 0) {
          this.rebuild(retry.reason);
        } else {
          // Terminal OOM: the job fails engine_oom; the supervisor stays
          // lazy — a fresh engine is built only when the next job arrives.
          this.currentDisposed = true;
        }
        continue;
      }
      // The retry surfaced a non-OOM outcome: classify it normally.
      return { status: 'failed', failureKind: 'net', reason: retry.reason, attempts: totalAttempts };
    }
    return {
      status: 'failed',
      failureKind: 'engine_oom',
      reason: `WASM OOM persisted after ${String(this.options.oomRetries)} retry on a rebuilt engine: ${lastReason}`,
      attempts: totalAttempts,
    };
  }

  /** Dispose-time hook for pool shutdown. */
  dispose(): void {
    if (!this.currentDisposed) {
      this.current.dispose();
      this.currentDisposed = true;
    }
  }

  /** A quarantined terminal engine is rebuilt lazily on next use. */
  private ensureLive(): void {
    if (this.currentDisposed) {
      this.rebuild('rebuild after terminal quarantine');
    }
  }

  private rebuild(reason: string): void {
    this.current = this.createEngine(this.nextEngineIdLabel());
    this.currentDisposed = false;
    this.events.push({
      type: 'engine-rebuilt',
      engineId: this.current.id,
      detail: reason,
    });
  }

  private nextEngineIdLabel(): string {
    const label = `engine-${String(this.nextEngineId)}`;
    this.nextEngineId += 1;
    return label;
  }
}
