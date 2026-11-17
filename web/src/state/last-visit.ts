/**
 * Last-visit stamp (R5 arrival — 'While you were away'): localStorage
 * records WHEN the app was last opened. On load, if the PREVIOUS stamp
 * is ≥ 1 h stale the landing view may surface the away summary; the
 * stamp is then rewritten to now ("updated on each visit" — the 1 h
 * clock measures session gaps, not idle time inside one).
 *
 * Dismissal is per NEWS BATCH (id = the newest item timestamp): once
 * dismissed, that batch never re-renders the card — a newer batch
 * (something else finished later) gets a fresh id and may show again.
 *
 * Keys sit beside the theme store's (`fmd-web-*`) with the same
 * storage-unavailable tolerance (private mode etc. — the card simply
 * never deems the visit stale).
 */

/** Session gap before the away summary may appear. */
export const AWAY_THRESHOLD_MS = 60 * 60 * 1000;

const LAST_VISIT_KEY = 'fmd-web-last-visit';
const AWAY_DISMISSED_KEY = 'fmd-web-away-dismissed';

/** Read the previous visit stamp (undefined on first run / no storage). */
export function readLastVisit(): string | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_VISIT_KEY);
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Rewrite the stamp to now — called once per app load. */
export function stampVisit(date: Date = new Date()): void {
  try {
    globalThis.localStorage?.setItem(LAST_VISIT_KEY, date.toISOString());
  } catch {
    /* storage unavailable — the next load is a first run again */
  }
}

/** Is the previous stamp ≥ 1 h before `now`? (No stamp → not stale.) */
export function isStaleVisit(previous: string | undefined, now: Date = new Date()): boolean {
  if (previous === undefined) {
    return false;
  }
  const then = Date.parse(previous);
  if (Number.isNaN(then)) {
    return false;
  }
  return now.getTime() - then >= AWAY_THRESHOLD_MS;
}

/** Batch id the caller last dismissed (undefined = never). */
export function readAwayDismissed(): string | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(AWAY_DISMISSED_KEY);
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One-shot visit evaluation (idempotent — the FIRST call per JS
 * context wins): reads the previous stamp, rewrites it to now, and
 * hands the previous value to every consumer. The app shell calls it
 * on mount; the away summary consumes the cached previous so a route
 * away-and-back never re-derives a different gap.
 */
let visitBegan = false;
let previousVisitStamp: string | undefined;

export function beginVisit(now: Date = new Date()): { readonly previous: string | undefined } {
  if (!visitBegan) {
    previousVisitStamp = readLastVisit();
    stampVisit(now);
    visitBegan = true;
  }
  return { previous: previousVisitStamp };
}

/** Dismiss one news batch forever (id = the batch's newest item ts). */
export function writeAwayDismissed(batchId: string): void {
  try {
    globalThis.localStorage?.setItem(AWAY_DISMISSED_KEY, batchId);
  } catch {
    /* storage unavailable — dismissal lasts this mount only */
  }
}
