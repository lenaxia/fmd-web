import type { JobState, LaneId } from '@fmd/contract';
import type {
  EnqueueOptions,
  ClaimOptions,
  JobQueue,
  QueueJob,
  QueueListOptions,
} from '../jobs/queue/queue.js';
import type { JobTransitionDetail } from '../jobs/queue/state-machine.js';
import type { JobPayload } from '../jobs/queue/payloads.js';
import type { JobProgress } from '../jobs/queue/coalesce.js';
import { LANES } from '../jobs/lanes.js';
import { FmdMetrics, MetricsRegistry, declareFmdFamilies } from './metrics.js';

/**
 * Instrumented queue wrapper (§4 observability): delegates every call
 * to the inner queue unchanged (claim discipline, coalescing, retention
 * are untouched) and mirrors the mutations into the metrics registry:
 *
 * - enqueue/claim counters (`fmd_jobs_enqueued_total{lane}`,
 *   `fmd_jobs_claimed_total{lane}`);
 * - terminal counters + failure kinds (`fmd_jobs_terminal_total{lane,state}`,
 *   `fmd_job_failures_total{lane,kind}`);
 * - depth/state gauges refreshed at scrape (`fmd_queue_depth{lane}`,
 *   `fmd_jobs_state{lane,state}` — the scrape hook reads the LIVE queue,
 *   so the gauge is exact even for rows mutated by other threads).
 */
export class InstrumentedJobQueue implements JobQueue {
  private readonly inner: JobQueue;
  readonly metrics: FmdMetrics;

  constructor(
    inner: JobQueue,
    metrics?: FmdMetrics,
    /** Pre-declared registry support (default: declare the §4 families). */
    registry?: MetricsRegistry,
  ) {
    this.inner = inner;
    this.metrics = metrics ?? new FmdMetrics(registry ?? declareFmdFamilies(new MetricsRegistry()));
    this.metrics.registry.onScrape((): void => {
      this.metrics.snapshotQueueStates(this.countsByLane());
    });
  }

  /** All four lanes' current per-state row counts (one SELECT each). */
  countsByLane(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const lane of LANES) {
      out[lane] = this.inner.counts(lane) as unknown as Record<string, number>;
    }
    return out;
  }

  enqueue(payload: JobPayload, opts?: EnqueueOptions): { job: QueueJob; replayed: boolean } {
    const result = this.inner.enqueue(payload, opts);
    if (!result.replayed) {
      this.metrics.recordJobEnqueued(payload.type);
    }
    return result;
  }

  claim(lane: LaneId, opts?: ClaimOptions): QueueJob | undefined {
    const job = this.inner.claim(lane, opts);
    if (job !== undefined) {
      this.metrics.recordJobClaimed(lane);
    }
    return job;
  }

  transition(jobId: string, to: JobState, detail?: JobTransitionDetail): QueueJob {
    const job = this.inner.transition(jobId, to, detail);
    if (isTerminalState(to)) {
      this.metrics.recordJobTerminal(job.lane, to, detail?.failureKind);
    }
    return job;
  }

  cancel(jobId: string): QueueJob {
    const job = this.inner.cancel(jobId);
    if (isTerminalState(job.state)) {
      this.metrics.recordJobTerminal(job.lane, job.state);
    }
    return job;
  }

  /** cbAddAsStopped parity: hold lift passthrough (non-terminal — no counter). */
  resume(jobId: string): QueueJob {
    return this.inner.resume(jobId);
  }

  /** Downloads-parity hold set (non-terminal — no counter). */
  hold(jobId: string): QueueJob {
    return this.inner.hold(jobId);
  }

  /** Downloads-parity row delete (out of band — no terminal counter). */
  remove(jobId: string): QueueJob {
    return this.inner.remove(jobId);
  }

  byIdempotencyKey(key: string): QueueJob | undefined {
    return this.inner.byIdempotencyKey(key);
  }

  updateProgress(jobId: string, progress: JobProgress): void {
    this.inner.updateProgress(jobId, progress);
  }

  progressOf(jobId: string): JobProgress | undefined {
    return this.inner.progressOf(jobId);
  }

  get(jobId: string): QueueJob | undefined {
    return this.inner.get(jobId);
  }

  list(opts?: QueueListOptions): QueueJob[] {
    return this.inner.list(opts);
  }

  counts(lane?: LaneId): Record<JobState, number> {
    return this.inner.counts(lane);
  }

  pruneRetention(now?: number): number {
    return this.inner.pruneRetention(now);
  }

  recoverOrphans(now?: number): number {
    return this.inner.recoverOrphans(now);
  }

  staleRunningJobs(olderThanMs: number, now?: number): QueueJob[] {
    return this.inner.staleRunningJobs(olderThanMs, now);
  }

  close(): void {
    this.inner.close();
  }
}

function isTerminalState(state: JobState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled';
}
