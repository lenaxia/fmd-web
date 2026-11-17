import { describe, expect, it } from 'vitest';
import {
  maxToleratedSyncFailures,
  SYNC_FAILURE_TOLERANCE,
  TolerancePolicy,
  type ToleratedSyncFailure,
} from '../tolerance.js';

/**
 * TolerancePolicy matrices (shared sweep+sync tolerance): first-sync
 * admission, whole-file ratio rounding (the real 417-file tree is the
 * boundary case), the absolute cap, the regression guard and their
 * precedence.
 */

function failures(files: readonly string[]): ToleratedSyncFailure[] {
  return files.map((file) => ({ file, firstError: `broken: ${file}` }));
}

describe('maxToleratedSyncFailures (whole-file rounding)', (): void => {
  it('ceil-rounds the ratio: the real tree boundary (417 files → 5 tolerated)', (): void => {
    // 417 × 1% = 4.17 → ceil = 5 — exactly the D3 known-broken count.
    expect(maxToleratedSyncFailures(417)).toBe(5);
    // 5 failing of 417 is the real-tree admission this module exists for.
    expect(failures(['a', 'b', 'c', 'd', 'e']).length).toBeLessThanOrEqual(maxToleratedSyncFailures(417));
  });

  it('sub-boundary trees round up to one tolerated file, never zero', (): void => {
    expect(maxToleratedSyncFailures(1)).toBe(1);
    expect(maxToleratedSyncFailures(99)).toBe(1);
    expect(maxToleratedSyncFailures(100)).toBe(1);
    expect(maxToleratedSyncFailures(101)).toBe(2);
  });

  it('the absolute cap binds large trees', (): void => {
    expect(maxToleratedSyncFailures(1000)).toBe(SYNC_FAILURE_TOLERANCE.maxFiles);
    expect(maxToleratedSyncFailures(1_000_000)).toBe(5);
  });

  it('an empty (or invalid) module-file count admits nothing', (): void => {
    expect(maxToleratedSyncFailures(0)).toBe(0);
    expect(maxToleratedSyncFailures(-3)).toBe(0);
    expect(maxToleratedSyncFailures(Number.NaN)).toBe(0);
  });
});

describe('TolerancePolicy.decide — matrices', (): void => {
  const inv = (files: readonly string[]): { sourceFile: string }[] =>
    files.map((sourceFile) => ({ sourceFile }));

  it('first sync (empty inventory): zero failures proceeds with an empty tolerated set', (): void => {
    const outcome = TolerancePolicy.decide([], 417, []);
    expect(outcome).toEqual({ decision: 'proceed', tolerated: [] });
  });

  it('first sync: 5 failures of 417 module files proceeds (the real-tree case)', (): void => {
    const real = failures([
      'modules/JapScan.lua',
      'modules/MangaPlus.lua',
      'modules/Shakai.lua',
      'modules/acqqcom.lua',
      'modules/dm5.lua',
    ]);
    const outcome = TolerancePolicy.decide(real, 417, []);
    expect(outcome.decision).toBe('proceed');
    if (outcome.decision === 'proceed') {
      expect(outcome.tolerated).toEqual(real);
    }
  });

  it('first sync: over-threshold refuses (6 > 5 absolute cap, even on a huge tree)', (): void => {
    const outcome = TolerancePolicy.decide(failures(['a', 'b', 'c', 'd', 'e', 'f']), 10_000, []);
    expect(outcome).toMatchObject({ decision: 'refuse', reason: 'over-threshold' });
  });

  it('first sync: within the absolute cap but over the ratio refuses', (): void => {
    // 3 failures of 100 files: ratio admits ceil(1) = 1 → refuse.
    const outcome = TolerancePolicy.decide(failures(['a', 'b', 'c']), 100, []);
    expect(outcome).toMatchObject({ decision: 'refuse', reason: 'over-threshold' });
  });

  it('first sync: one failure of a tiny tree proceeds (min-of-one rounding)', (): void => {
    expect(TolerancePolicy.decide(failures(['modules/Broken.lua']), 8, []).decision).toBe('proceed');
  });

  it('REGRESSION GUARD: a previously-registered file going broken refuses, even alone', (): void => {
    const previous = inv(['modules/11Toon.lua', 'modules/AsuraScans.lua']);
    const outcome = TolerancePolicy.decide(failures(['modules/11Toon.lua']), 417, previous);
    expect(outcome).toMatchObject({ decision: 'refuse', reason: 'regression' });
    if (outcome.decision === 'refuse') {
      expect(outcome.offenders.map((o) => o.file)).toEqual(['modules/11Toon.lua']);
    }
  });

  it('regression guard outranks tolerance: known-broken set PLUS one regression refuses as regression', (): void => {
    const previous = inv(['modules/AsuraScans.lua']);
    const real = failures([
      'modules/JapScan.lua',
      'modules/MangaPlus.lua',
      'modules/Shakai.lua',
      'modules/acqqcom.lua',
      'modules/dm5.lua',
      'modules/AsuraScans.lua',
    ]);
    const outcome = TolerancePolicy.decide(real, 417, previous);
    expect(outcome).toMatchObject({ decision: 'refuse', reason: 'regression' });
  });

  it('re-sync over the same known-broken set proceeds: previously-broken files are not regressions', (): void => {
    // After a tolerant first sync the broken files are NOT in the inventory
    // (they registered nothing) — re-syncing the same tree stays admitted.
    const broken = ['modules/JapScan.lua', 'modules/dm5.lua'];
    const previous = inv(['modules/11Toon.lua', 'modules/AsuraScans.lua']);
    const outcome = TolerancePolicy.decide(failures(broken), 417, previous);
    expect(outcome.decision).toBe('proceed');
  });

  it('normalizes empty error strings and never emits them', (): void => {
    const outcome = TolerancePolicy.decide([{ file: 'modules/X.lua', firstError: '' }], 500, []);
    expect(outcome).toMatchObject({
      decision: 'proceed',
      tolerated: [{ file: 'modules/X.lua', firstError: 'unknown error' }],
    });
  });
});
