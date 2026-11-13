import type { JobState, LaneId } from '@fmd/contract';

/**
 * Job queue lanes placeholder (DESIGN.md §4, §7.1).
 * SQLite-backed queue with 4 lanes and independent concurrency; the
 * real queue engine lands in the jobs stories.
 */

export const LANES: readonly LaneId[] = ['info', 'download', 'update', 'sync'];

/** Persisted state machine (§7.1). */
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running', 'cancelled'],
  running: ['retry', 'done', 'failed', 'cancelled'],
  retry: ['running', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Progress writes are coalesced: flushed <= 1/sec/job (§4). */
export const PROGRESS_FLUSH_INTERVAL_MS: number = 1_000;
