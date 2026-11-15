/**
 * Typed job state machine (DESIGN.md §7.1, enforced — not advisory).
 *
 * The legal-transition table is the one in `../lanes.ts` (single source
 * of truth for the persisted §7.1 machine):
 *
 *   queued  → running | cancelled
 *   running → retry | done | failed | cancelled
 *   retry   → running | cancelled
 *   done | failed | cancelled   (terminal — closed)
 *
 * Every state write goes through {@link assertJobTransition}: an
 * illegal transition THROWS {@link InvalidJobTransitionError} instead of
 * silently corrupting the row. `→ failed` additionally requires a
 * typed {@link JobFailureKind} (§4: worker_stalled | engine_oom |
 * net | pack) — an unclassified failure is a programming error.
 */
import type { JobFailureKind, JobState } from '@fmd/contract';
import { canTransition, TRANSITIONS } from '../lanes.js';

/** All failure kinds, runtime-checkable for non-TS callers. */
export const JOB_FAILURE_KINDS: readonly JobFailureKind[] = [
  'worker_stalled',
  'engine_oom',
  'net',
  'pack',
];

export function isJobFailureKind(value: unknown): value is JobFailureKind {
  return (
    typeof value === 'string' && (JOB_FAILURE_KINDS as readonly unknown[]).includes(value)
  );
}

/** Classification attached to a `→ failed` transition (§4/§7.3). */
export interface JobFailureDetail {
  readonly failureKind: JobFailureKind;
  readonly error?: string;
}

/** Extra context accepted on any transition (error text, worker id). */
export type JobTransitionDetail = Partial<JobFailureDetail>;

/** Thrown when a state write violates the §7.1 machine. */
export class InvalidJobTransitionError extends Error {
  public readonly from: JobState;
  public readonly to: JobState;

  public constructor(from: JobState, to: JobState) {
    super(`invalid job transition: ${from} → ${to} (legal: ${TRANSITIONS[from].join(', ') || 'none'})`);
    this.name = 'InvalidJobTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Thrown when `→ failed` lacks (or carries an unknown) failure kind. */
export class MissingJobFailureKindError extends Error {
  public constructor(found: unknown) {
    super(
      found === undefined
        ? "transition to 'failed' requires a failureKind (worker_stalled | engine_oom | net | pack)"
        : `unknown failureKind: ${String(found)}`,
    );
    this.name = 'MissingJobFailureKindError';
  }
}

/**
 * The typed transition function: validates `from → to` against the
 * §7.1 table and the failure-kind requirement, returning the target
 * state on success. Invalid transitions THROW.
 */
export function assertJobTransition(
  from: JobState,
  to: JobState,
  detail?: JobTransitionDetail,
): JobState {
  if (!canTransition(from, to)) {
    throw new InvalidJobTransitionError(from, to);
  }
  if (to === 'failed' && !isJobFailureKind(detail?.failureKind)) {
    throw new MissingJobFailureKindError(detail?.failureKind);
  }
  return to;
}

/** Terminal states — no outgoing edges. */
export function isTerminalJobState(state: JobState): boolean {
  return TRANSITIONS[state].length === 0;
}
