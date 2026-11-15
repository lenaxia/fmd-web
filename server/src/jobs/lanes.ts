import type { JobState, LaneId } from '@fmd/contract';

/**
 * Job queue lanes (DESIGN.md §4, §7.1).
 * SQLite-backed queue with 4 lanes and independent concurrency — the
 * engine lives in `jobs/queue/` and shares THIS transition table as
 * the single source of truth for the persisted §7.1 state machine.
 */

export const LANES: readonly LaneId[] = ['info', 'download', 'update', 'sync'];

/** Persisted state machine (§7.1) — exported for the typed enforcer. */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
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
