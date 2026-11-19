// @vitest-environment node
/**
 * Per-site failure coalescing tests (webhook story): the pinned digest
 * semantics — "a dead site with 50 favorites produces ONE entry per
 * digest window, never 50" — under a manually-driven window timer:
 *
 * - N failures on ONE site within the 15-minute window → ONE digest
 *   entry carrying failureCount N (never N entries);
 * - failures on DISTINCT sites coalesce independently (one entry per
 *   site, each in its own window);
 * - a failure after the window closed opens a FRESH window (the next
 *   digest), keyed on that failure's time;
 * - dispose drops open windows silently (shutdown, lossy-tolerated).
 */
import { describe, expect, it } from 'vitest';
import type { FailureDigestData } from '@fmd/contract';
import {
  FAILURE_DIGEST_SAMPLE_CAP,
  FAILURE_DIGEST_WINDOW_MS,
  type ScheduleFlush,
  SiteFailureCoalescer,
} from '../../src/webhook/digest.js';

/** Manual flush scheduler: tests fire armed windows at chosen clock times. */
function manualSchedule(): { armed: Set<() => void>; schedule: ScheduleFlush } {
  const armed = new Set<() => void>();
  const schedule: ScheduleFlush = (fire: () => void): { cancel(): void } => {
    armed.add(fire);
    return {
      cancel: (): void => {
        armed.delete(fire);
      },
    };
  };
  return { armed, schedule };
}

interface Harness {
  coalescer: SiteFailureCoalescer;
  digests: FailureDigestData[];
  armed: Set<() => void>;
}

function makeCoalescer(windowMs = FAILURE_DIGEST_WINDOW_MS): Harness {
  const manual = manualSchedule();
  const digests: FailureDigestData[] = [];
  const coalescer = new SiteFailureCoalescer({
    windowMs,
    schedule: manual.schedule,
    onDigest: (entry): void => {
      digests.push(entry);
    },
  });
  return { coalescer, digests, armed: manual.armed };
}

/** Fire every armed window timer (the clock reaching window end). */
function fireAll(h: Harness, at: number): void {
  for (const fire of [...h.armed.values()]) {
    fire();
  }
  void at;
}

const SITE = 'a'.repeat(32);
const OTHER_SITE = 'b'.repeat(32);
const key = (i: number): string => `lowercase(site+link)${String(i)}`;

describe('SiteFailureCoalescer (failure.digest windows)', (): void => {
  it('50 failures on ONE site inside the window → exactly ONE digest entry with failureCount 50', (): void => {
    const h = makeCoalescer();
    let t = 0;
    for (let i = 0; i < 50; i += 1) {
      h.coalescer.record(SITE, key(i), new Error('site is dead'), t);
      t += 10_000; // 10 s apart — all within the 15-minute window
    }
    expect(h.digests.length).toBe(0); // nothing before the window closes
    fireAll(h, FAILURE_DIGEST_WINDOW_MS);
    expect(h.digests.length).toBe(1);
    const entry = h.digests[0]!;
    expect(entry.moduleId).toBe(SITE);
    expect(entry.failureCount).toBe(50);
    expect(entry.affectedFavoritesCount).toBe(50);
    expect(entry.affectedFavoritesSample.length).toBe(FAILURE_DIGEST_SAMPLE_CAP);
    expect(entry.firstError).toBe('site is dead');
    expect(entry.lastError).toBe('site is dead');
    expect(h.coalescer.openSites()).toEqual([]);
  });

  it('failures on DISTINCT sites coalesce independently — one entry per site', (): void => {
    const h = makeCoalescer();
    h.coalescer.record(SITE, key(1), new Error('a down'), 0);
    h.coalescer.record(OTHER_SITE, key(2), new Error('b down'), 5_000);
    h.coalescer.record(OTHER_SITE, key(3), new Error('b still down'), 6_000);
    fireAll(h, FAILURE_DIGEST_WINDOW_MS + 1);
    expect(h.digests.length).toBe(2);
    const bySite = new Map(h.digests.map((e): [string, FailureDigestData] => [e.moduleId, e]));
    expect(bySite.get(SITE)!.failureCount).toBe(1);
    expect(bySite.get(OTHER_SITE)!.failureCount).toBe(2);
    expect(bySite.get(OTHER_SITE)!.affectedFavoritesCount).toBe(2);
  });

  it('a failure AFTER the window closed opens a fresh window (next digest)', (): void => {
    const h = makeCoalescer();
    h.coalescer.record(SITE, key(1), new Error('first wave'), 0);
    fireAll(h, FAILURE_DIGEST_WINDOW_MS); // window 1 closes
    expect(h.digests.length).toBe(1);
    h.coalescer.record(SITE, key(2), new Error('second wave'), FAILURE_DIGEST_WINDOW_MS + 60_000);
    expect(h.coalescer.openSites()).toEqual([SITE]); // new window open
    fireAll(h, 2 * FAILURE_DIGEST_WINDOW_MS + 60_000);
    expect(h.digests.length).toBe(2);
    expect(h.digests[1]!.failureCount).toBe(1);
    expect(h.digests[1]!.firstError).toBe('second wave');
  });

  it('the window is keyed on the FIRST failure — later failures never extend it', (): void => {
    const h = makeCoalescer();
    h.coalescer.record(SITE, key(1), new Error('early'), 0);
    // arrives at minute 14 — inside the window opened at t=0
    h.coalescer.record(SITE, key(2), new Error('late but inside'), 14 * 60_000);
    fireAll(h, FAILURE_DIGEST_WINDOW_MS); // closes at t=15min from t=0
    expect(h.digests.length).toBe(1);
    expect(h.digests[0]!.failureCount).toBe(2);
    expect(h.digests[0]!.lastError).toBe('late but inside');
  });

  it('non-Error failures stringify; messages cap at 500 chars', (): void => {
    const h = makeCoalescer();
    h.coalescer.record(SITE, key(1), 'plain string failure', 0);
    h.coalescer.record(SITE, key(2), new Error('x'.repeat(900)), 1_000);
    fireAll(h, FAILURE_DIGEST_WINDOW_MS);
    expect(h.digests[0]!.firstError).toBe('plain string failure');
    expect(h.digests[0]!.lastError.length).toBe(500);
  });

  it('window stamps render RFC 3339', (): void => {
    const h = makeCoalescer();
    h.coalescer.record(SITE, key(1), new Error('e'), 0);
    h.coalescer.flush(SITE, FAILURE_DIGEST_WINDOW_MS);
    const entry = h.digests[0]!;
    expect(entry.windowStartedAt).toBe(new Date(0).toISOString());
    expect(entry.windowEndedAt).toBe(new Date(FAILURE_DIGEST_WINDOW_MS).toISOString());
  });

  it('dispose drops open windows WITHOUT emitting (shutdown path)', (): void => {
    const h = makeCoalescer();
    h.coalescer.record(SITE, key(1), new Error('never delivered'), 0);
    h.coalescer.dispose();
    expect(h.digests.length).toBe(0);
    expect(h.coalescer.openSites()).toEqual([]);
    expect(h.armed.size).toBe(0); // timer cancelled
  });
});
