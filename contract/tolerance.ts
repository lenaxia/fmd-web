/**
 * Shared staged-sync failure tolerance (bootstrap launch defects, D20):
 * the registry SWEEP has always been per-file isolated (a broken file is
 * recorded, every other file still registers), but the staged sync gate
 * was zero-tolerance — and the real FMD2 tree permanently carries a
 * handful of upstream-broken files, so a first sync on the real tree
 * could never pass. This module is the ONE tolerance policy both
 * surfaces share (sweep summary annotation + staged sync gate) — no
 * second opinion anywhere else in the repository.
 *
 * Policy (both conditions must hold, plus the regression guard):
 *   1. failing files <= SYNC_FAILURE_TOLERANCE.maxFiles (absolute cap), AND
 *   2. failing files <= ceil(moduleFiles × ratio) — whole-file rounding:
 *      you cannot tolerate 4.17 files; the real tree (417 module files,
 *      5 upstream-broken) is exactly the boundary case this encodes.
 *   3. REGRESSION GUARD: a failing file that was previously registered
 *      (its sourceFile appears in the previous inventory) refuses the
 *      sync — upstream may ship new broken files, it may not silently
 *      drop modules that used to work.
 */

/** The single source of tolerance truth — used by sweep AND sync. */
export const SYNC_FAILURE_TOLERANCE = {
  /** Absolute cap on tolerated failing files per sync. */
  maxFiles: 5,
  /** Maximum fraction of module files that may fail (whole-file rounding below). */
  ratio: 0.01,
} as const;

/** One tolerated/observed sync failure, normalized for reports. */
export interface ToleratedSyncFailure {
  /** Tree-relative file path (e.g. `modules/JapScan.lua`). */
  readonly file: string;
  /** First error line — the report surface keeps one line per file. */
  readonly firstError: string;
}

/** Previous-inventory shape the regression guard needs (subset of the sync report inventory). */
export interface TolerancePreviousModule {
  /** Tree-relative source file the module registered from. */
  readonly sourceFile: string;
}

export type ToleranceRefusalReason =
  /** A failing file was previously registered (regression guard). */
  | 'regression'
  /** Too many failing files (absolute cap or ratio). */
  | 'over-threshold';

export type ToleranceDecision =
  | {
      readonly decision: 'proceed';
      /** The tolerated failures (file + first error), for the sync report. */
      readonly tolerated: readonly ToleratedSyncFailure[];
    }
  | {
      readonly decision: 'refuse';
      readonly reason: ToleranceRefusalReason;
      readonly tolerated: [];
      /** Files that triggered the refusal, with their first error. */
      readonly offenders: readonly ToleratedSyncFailure[];
    };

/**
 * How many failing files `moduleFiles` total files admit: `ceil(n × ratio)`
 * (whole-file rounding — 417 files × 1% = 4.17 → 5), at least one file for
 * any non-empty tree, capped at `maxFiles`. An empty tree admits none.
 */
export function maxToleratedSyncFailures(moduleFiles: number): number {
  if (!Number.isFinite(moduleFiles) || moduleFiles <= 0) {
    return 0;
  }
  const byRatio = Math.max(1, Math.ceil(moduleFiles * SYNC_FAILURE_TOLERANCE.ratio));
  return Math.min(SYNC_FAILURE_TOLERANCE.maxFiles, byRatio);
}

/**
 * Decide whether a staged sync may proceed despite failing files.
 * Pure — no IO, no clock; unit-tested against matrices of first-sync,
 * regression and over-threshold cases.
 */
export const TolerancePolicy = {
  decide(
    failures: readonly ToleratedSyncFailure[],
    moduleFiles: number,
    previousInventory: readonly TolerancePreviousModule[] = [],
  ): ToleranceDecision {
    const normalized = failures.map((failure) => ({
      file: failure.file,
      firstError: failure.firstError !== '' ? failure.firstError : 'unknown error',
    }));
    if (normalized.length === 0) {
      return { decision: 'proceed', tolerated: [] };
    }

    // Regression guard FIRST: a previously-registered file going broken
    // is never tolerated, however few the failures are.
    const previouslyRegistered = new Set(previousInventory.map((entry) => entry.sourceFile));
    const regressions = normalized.filter((failure) => previouslyRegistered.has(failure.file));
    if (regressions.length > 0) {
      return { decision: 'refuse', reason: 'regression', tolerated: [], offenders: regressions };
    }

    if (normalized.length > maxToleratedSyncFailures(moduleFiles)) {
      return { decision: 'refuse', reason: 'over-threshold', tolerated: [], offenders: normalized };
    }

    return { decision: 'proceed', tolerated: normalized };
  },
} as const;
