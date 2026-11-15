/**
 * Julian day number helpers (DESIGN.md §6.7) — exact parity with FMD2's
 * `uBaseUnit.pas:2740 DateToJDN` / `:2752 JDNToDate` (proleptic Gregorian).
 *
 * The catalog `jdn` column stores the integer Julian day number of the
 * last-update date; `latest` browsing (§6.6) orders by it DESC. The
 * Pascal TDateTime epoch (0 == 1899-12-30) is relevant only upstream of
 * these helpers (FMD2 encodes TDateTime values); JDNs themselves are
 * epoch-independent Gregorian integers — e.g. 1899-12-30 → 2415019,
 * 2000-01-01 → 2451545.
 */

/** One calendar date (proleptic Gregorian). */
export interface CalendarDate {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
}

/** `uBaseUnit.pas:2740` — the standard Gregorian-date-to-JDN algorithm
 * (`a/y/m` form). Integer-exact; `Round(x - 0.5)` in the Pascal source
 * is a no-op on the integral inner sum. */
export function dateToJdn(date: CalendarDate): number {
  const { year, month, day }: CalendarDate = date;
  const a: number = Math.floor((14 - month) / 12);
  const y: number = year + 4800 - a;
  const m: number = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/** `uBaseUnit.pas:2752` — inverse of {@link dateToJdn}. */
export function jdnToDate(jdn: number): CalendarDate {
  const a: number = Math.floor(jdn + 32044.5);
  const b: number = Math.floor((4 * a + 3) / 146097);
  const c: number = a - Math.floor((146097 * b) / 4);
  const d: number = Math.floor((4 * c + 3) / 1461);
  const e: number = c - Math.floor((1461 * d) / 4);
  const m: number = Math.floor((5 * e + 2) / 153);
  const day: number = e - Math.floor((153 * m + 2) / 5) + 1;
  const month: number = m + 3 - 12 * Math.floor(m / 10);
  const year: number = 100 * b + d - 4800 + Math.floor(m / 10);
  return { year, month, day };
}

/** `ISO-8601` date (`YYYY-MM-DD`) → JDN. Throws on malformed input —
 * catalog columns are written by FMD2's fixed-width date math and a
 * malformed fixture is a data bug, not a tolerable value. */
export function isoDateToJdn(iso: string): number {
  const m: RegExpMatchArray | null = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) {
    throw new Error(`invalid ISO date: ${iso}`);
  }
  return dateToJdn({
    year: Number(m[1] as string),
    month: Number(m[2] as string),
    day: Number(m[3] as string),
  });
}

/** JDN → `YYYY-MM-DD` (inverse of {@link isoDateToJdn}). */
export function jdnToIsoDate(jdn: number): string {
  const { year, month, day }: CalendarDate = jdnToDate(jdn);
  const mm: string = String(month).padStart(2, '0');
  const dd: string = String(day).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${mm}-${dd}`;
}
