import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TRIES,
  mergeWeek,
  updateEntry,
  weekOutcome,
  type LivenessEntry,
} from '../../../tools/sitecheck/state.js';

describe('sitecheck weekOutcome (try policy)', () => {
  it('first ok wins, later attempts ignored', () => {
    const r = weekOutcome([
      { series: 'a', ok: false, error: 'x' },
      { series: 'b', ok: true },
      { series: 'c', ok: false },
    ]);
    expect(r.outcome).toBe('ok');
    expect(r.successfulSeries).toBe('b');
    expect(r.attempts).toBe(3);
  });

  it('all failures → warn with the LAST error', () => {
    const r = weekOutcome([
      { series: 'a', ok: false, error: 'e1' },
      { series: 'b', ok: false, error: 'e2' },
      { series: 'c', ok: false, error: 'e3' },
    ]);
    expect(r.outcome).toBe('warn');
    expect(r.lastError).toBe('e3');
    expect(r.successfulSeries).toBe('');
  });

  it('attempts beyond maxTries never flip a warn', () => {
    const r = weekOutcome(
      [
        { series: 'a', ok: false },
        { series: 'b', ok: false },
        { series: 'c', ok: false },
        { series: 'd', ok: true },
      ],
      DEFAULT_MAX_TRIES,
    );
    expect(r.outcome).toBe('warn');
  });

  it('fewer attempts than maxTries is still a valid warn', () => {
    const r = weekOutcome([{ series: 'only', ok: false, error: 'dead' }]);
    expect(r).toMatchObject({ outcome: 'warn', attempts: 1, lastError: 'dead' });
  });
});

describe('sitecheck updateEntry (week-over-week folding)', () => {
  const T = (n: number): string => `2026-01-${String(n).padStart(2, '0')}T06:00:00Z`;
  const warn = (error = 'upstream') =>
    ({ outcome: 'warn', attempts: 3, lastError: error }) as const;
  const ok = (series: string) => ({ outcome: 'ok', attempts: 1, successfulSeries: series }) as const;

  it('fresh ok entry', () => {
    const e = updateEntry(undefined, ok('s1'), T(1));
    expect(e).toMatchObject({ status: 'ok', consecutiveWarnings: 0, lastOutcome: 'ok', successfulSeries: 's1' });
  });

  it('one warn week → warn', () => {
    const e = updateEntry(undefined, warn(), T(1));
    expect(e.status).toBe('warn');
    expect(e.consecutiveWarnings).toBe(1);
  });

  it('two warn weeks → warn; third consecutive → failed', () => {
    let e: LivenessEntry | undefined;
    e = updateEntry(e, warn(), T(1));
    e = updateEntry(e, warn(), T(8));
    expect(e?.status).toBe('warn');
    e = updateEntry(e, warn(), T(15));
    expect(e?.status).toBe('failed');
    expect(e?.consecutiveWarnings).toBe(3);
  });

  it('an ok week between warns resets the counter', () => {
    let e: LivenessEntry | undefined;
    e = updateEntry(e, warn(), T(1));
    e = updateEntry(e, warn(), T(8));
    e = updateEntry(e, ok('s'), T(15));
    expect(e?.status).toBe('ok');
    expect(e?.consecutiveWarnings).toBe(0);
    e = updateEntry(e, warn(), T(22));
    expect(e?.status).toBe('warn');
    expect(e?.consecutiveWarnings).toBe(1);
  });

  it('failed self-heals on a later ok week', () => {
    let e: LivenessEntry | undefined;
    for (const d of [1, 8, 15]) e = updateEntry(e, warn(), T(d));
    expect(e?.status).toBe('failed');
    e = updateEntry(e, ok('recovered'), T(22));
    expect(e?.status).toBe('ok');
    expect(e?.consecutiveWarnings).toBe(0);
  });

  it('skipped weeks never move counters (even past the threshold)', () => {
    let e: LivenessEntry | undefined;
    e = updateEntry(e, warn(), T(1));
    e = updateEntry(e, warn(), T(8));
    e = updateEntry(e, { outcome: 'skipped', attempts: 0 }, T(15));
    expect(e?.status).toBe('warn');
    expect(e?.consecutiveWarnings).toBe(2);
    expect(e?.lastOutcome).toBe('skipped');
  });

  it('mergeWeek keys entries by module id and preserves other sites', () => {
    const entries = mergeWeek({}, 'm1', ok('s'), T(1));
    const next = mergeWeek(entries, 'm2', warn(), T(1));
    expect(Object.keys(next).sort()).toEqual(['m1', 'm2']);
    expect(next['m1']?.status).toBe('ok');
    expect(next['m2']?.status).toBe('warn');
    // original map untouched (pure)
    expect(entries['m2']).toBeUndefined();
  });
});
