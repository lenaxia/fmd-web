/**
 * Lua worker pool placeholders (DESIGN.md §5.12, §4).
 * Real worker_threads + wasmoon engine-per-worker lands in Phase 1.
 */

export interface WorkerPoolOptions {
  /** Pool size: min(cpu_count, 8) by default (§5.12). */
  readonly size: number;
  /** RSS budget for the whole pool (§5.12: 2 GB default). */
  readonly rssBudgetBytes: number;
}

export const DEFAULT_RSS_BUDGET_BYTES: number = 2 * 1024 ** 3;

/** Per-event wall-clock deadline (§4), overridden per module. */
export const DEFAULT_EVENT_DEADLINE_MS: number = 60_000;

/** A worker missing its deadline twice is recycled and its job fails `worker_stalled` (§4). */
export const WORKER_STALL_TOLERANCE: number = 2;

export function defaultPoolSize(cpuCount: number): number {
  return Math.min(cpuCount, 8);
}

export function defaultPoolOptions(cpuCount: number): WorkerPoolOptions {
  return {
    size: defaultPoolSize(cpuCount),
    rssBudgetBytes: DEFAULT_RSS_BUDGET_BYTES,
  };
}
