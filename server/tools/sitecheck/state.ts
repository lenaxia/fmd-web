/**
 * Site-liveness state (weekly sitecheck harness): per-site ok/warn/failed
 * flags folded week over week.
 *
 * Semantics (the sitecheck contract):
 * - A site's WEEK is 'ok' when at least one of up to `maxTries` random
 *   series downloaded a chapter successfully; otherwise 'warn'.
 * - 'warn' increments consecutiveWarnings; three consecutive warn weeks
 *   (default) mark the site 'failed'.
 * - 'failed' is a flag only — nothing gates on it. A later ok week
 *   self-heals the site back to 'ok' (counters reset).
 * - 'skipped' weeks (known-broken exclusion, no directory, not run
 *   within the budget) record the outcome but never move counters.
 */

export type LivenessStatus = 'ok' | 'warn' | 'failed';
export type WeekOutcome = 'ok' | 'warn' | 'skipped';

export interface LivenessEntry {
  readonly status: LivenessStatus;
  /** Consecutive warn weeks (drives the 3-week escalation). */
  readonly consecutiveWarnings: number;
  /** ISO timestamp of the last run that touched this site. */
  readonly lastChecked: string;
  readonly lastOutcome: WeekOutcome | 'not-run';
  /** Last error of the final attempt of the last warn week ('' on ok). */
  readonly lastError: string;
  /** The series that validated the site on the last ok week. */
  readonly successfulSeries: string;
  /** Attempts used in the last run week (1..maxTries). */
  readonly attempts: number;
}

export interface LivenessState {
  readonly updatedAt: string;
  readonly entries: Readonly<Record<string, LivenessEntry>>;
}

export const DEFAULT_MAX_TRIES = 3;
export const DEFAULT_WEEKS_TO_FAILED = 3;

/** One series attempt: which series, whether its chapter downloaded. */
export interface SeriesAttempt {
  readonly series: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface WeekResult {
  readonly outcome: 'ok' | 'warn';
  readonly attempts: number;
  readonly successfulSeries: string;
  readonly lastError: string;
}

/**
 * Fold one site's series attempts (already executed, in try order) into
 * the week result: the FIRST ok stops the tries; a warn carries the
 * LAST attempt's error. Attempts beyond an ok are ignored (the runner
 * never executes them, but the fold is defensive).
 */
export function weekOutcome(
  attempts: readonly SeriesAttempt[],
  maxTries: number = DEFAULT_MAX_TRIES,
): WeekResult {
  const used = attempts.slice(0, maxTries);
  for (const a of used) {
    if (a.ok) {
      return { outcome: 'ok', attempts: used.length, successfulSeries: a.series, lastError: '' };
    }
  }
  const last = used[used.length - 1];
  return {
    outcome: 'warn',
    attempts: used.length,
    successfulSeries: '',
    lastError: last?.error ?? 'no attempts',
  };
}

/**
 * Fold a week into the persistent entry. `week.outcome === 'skipped'`
 * keeps every counter; ok resets; warn escalates to failed at
 * `weeksToFailed` consecutive warns.
 */
export function updateEntry(
  prev: LivenessEntry | undefined,
  week: { outcome: WeekOutcome; attempts: number; successfulSeries?: string; lastError?: string },
  now: string,
  weeksToFailed: number = DEFAULT_WEEKS_TO_FAILED,
): LivenessEntry {
  const base: LivenessEntry = prev ?? {
    status: 'ok',
    consecutiveWarnings: 0,
    lastChecked: now,
    lastOutcome: 'not-run',
    lastError: '',
    successfulSeries: '',
    attempts: 0,
  };
  if (week.outcome === 'skipped') {
    return { ...base, lastChecked: now, lastOutcome: 'skipped' };
  }
  if (week.outcome === 'ok') {
    return {
      status: 'ok',
      consecutiveWarnings: 0,
      lastChecked: now,
      lastOutcome: 'ok',
      lastError: '',
      successfulSeries: week.successfulSeries ?? '',
      attempts: week.attempts,
    };
  }
  const consecutive = base.consecutiveWarnings + 1;
  return {
    status: consecutive >= weeksToFailed ? 'failed' : 'warn',
    consecutiveWarnings: consecutive,
    lastChecked: now,
    lastOutcome: 'warn',
    lastError: week.lastError ?? '',
    successfulSeries: '',
    attempts: week.attempts,
  };
}

export function emptyState(now: string): LivenessState {
  return { updatedAt: now, entries: {} };
}

/** Merge a week result into the state map (pure — returns a new map). */
export function mergeWeek(
  entries: Readonly<Record<string, LivenessEntry>>,
  moduleId: string,
  week: Parameters<typeof updateEntry>[1],
  now: string,
  weeksToFailed: number = DEFAULT_WEEKS_TO_FAILED,
): Record<string, LivenessEntry> {
  return { ...entries, [moduleId]: updateEntry(entries[moduleId], week, now, weeksToFailed) };
}
