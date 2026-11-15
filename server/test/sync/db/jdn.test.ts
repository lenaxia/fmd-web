import { describe, expect, it } from 'vitest';
import { dateToJdn, isoDateToJdn, jdnToDate, jdnToIsoDate } from '../../../src/sync/db/jdn.js';

/**
 * §6.7 JDN helper — parity with `uBaseUnit.pas:2740 DateToJDN` and
 * `:2752 JDNToDate`, verified on an externally anchored boundary
 * fixture set: the Pascal TDateTime epoch (1899-12-30), the Julian-day
 * epoch anchors (JDN 2451545 == 2000-01-01, JDN 2440588 == 1970-01-01),
 * leap years (including the divisible-by-100/400 split: 1900 not leap,
 * 2000 leap, 2100 not leap) and round-trips.
 */
describe('jdn helper (§6.7, Pascal DateToJDN parity)', () => {
  // Externally anchored fixtures (well-known Julian day numbers).
  const ANCHORS: readonly (readonly [string, number])[] = [
    ['1899-12-30', 2_415_019], // Pascal TDateTime epoch (0 == 1899-12-30)
    ['1899-12-31', 2_415_020],
    ['1900-01-01', 2_415_021],
    ['1900-02-28', 2_415_079], // 1900: century, NOT a leap year
    ['1900-03-01', 2_415_080], // day after 1900-02-28 (no 02-29)
    ['1904-02-29', 2_416_540], // 1904: leap year
    ['1970-01-01', 2_440_588], // Unix epoch anchor
    ['1999-12-31', 2_451_544],
    ['2000-01-01', 2_451_545], // J2000 anchor
    ['2000-02-28', 2_451_603],
    ['2000-02-29', 2_451_604], // 2000: leap (divisible by 400)
    ['2000-03-01', 2_451_605],
    ['2024-02-29', 2_460_370], // modern leap year
    ['2026-11-13', 2_461_358],
    ['2100-02-28', 2_488_128], // 2100: century, NOT a leap year
    ['2100-03-01', 2_488_129],
  ];

  it('matches the anchored DateToJDN fixtures', () => {
    for (const [iso, jdn] of ANCHORS) {
      expect(isoDateToJdn(iso), iso).toBe(jdn);
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
      expect(dateToJdn({ year: y, month: m, day: d }), iso).toBe(jdn);
    }
  });

  it('round-trips every anchor through JDNToDate (Pascal :2752)', () => {
    for (const [iso, jdn] of ANCHORS) {
      expect(jdnToIsoDate(jdn), String(jdn)).toBe(iso);
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
      expect(jdnToDate(jdn)).toEqual({ year: y, month: m, day: d });
    }
  });

  it('is strictly monotonic across the 1899→1900 leap boundary', () => {
    let prev: number = isoDateToJdn('1899-12-29');
    for (let i = 0; i < 800; i += 1) {
      // walk from 1899-12-30 through 1902-03-07
      const next: number = prev + 1;
      const back: string = jdnToIsoDate(next);
      expect(isoDateToJdn(back), back).toBe(next);
      prev = next;
    }
    expect(jdnToIsoDate(isoDateToJdn('1899-12-30') + 1)).toBe('1899-12-31');
    expect(jdnToIsoDate(isoDateToJdn('1900-02-28') + 1)).toBe('1900-03-01');
  });

  it('is strictly monotonic across the 2099→2100 non-leap boundary', () => {
    expect(jdnToIsoDate(isoDateToJdn('2100-02-28') + 1)).toBe('2100-03-01');
    expect(isoDateToJdn('2100-02-29')).toBe(isoDateToJdn('2100-03-01'));
  });

  it('rejects malformed ISO dates (catalog data bug, not tolerable)', () => {
    expect(() => isoDateToJdn('not-a-date')).toThrow(/invalid ISO date/);
    expect(() => isoDateToJdn('2024-2-9')).toThrow(/invalid ISO date/);
    expect(() => isoDateToJdn('')).toThrow(/invalid ISO date/);
  });
});
