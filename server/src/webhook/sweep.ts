/**
 * Favorites sweep accumulator for `favorites.digest` (charter: ONE
 * summary per check sweep). A "sweep" is the scheduler's contiguous
 * busy period — checks run back-to-back while favorites are due; the
 * sweep ends when the running set drains AND nothing is due at the
 * current clock time (the scheduler's onSweepIdle seam). The
 * accumulator tallies per-check outcomes between those boundaries and
 * `take()` hands back the digest payload exactly once per sweep.
 *
 * Scheduled sweeps only, by design: manual check-now and batch checks
 * surface in the API response + UI already (the exceptions surface);
 * the digest is the headless pipe's summary (D1 §1 — the happy path
 * is hands-off).
 */

import type { FavoritesDigestData } from '@fmd/contract';
import type { FavoriteCheckResult } from '../jobs/favorites/engine.js';

/** Mutable tally — one sweep's worth of check outcomes. */
interface SweepTally {
  startedAt: number;
  endedAt: number;
  favoritesChecked: number;
  newChaptersFound: number;
  downloadsQueued: number;
  checkFailures: number;
}

export class SweepAccumulator {
  private tally: SweepTally | undefined;

  /** Record one completed check (called from the wrapped scheduler check). */
  public recordCheck(result: FavoriteCheckResult, at: number = Date.now()): void {
    const tally = (this.tally ??= {
      startedAt: at,
      endedAt: at,
      favoritesChecked: 0,
      newChaptersFound: 0,
      downloadsQueued: 0,
      checkFailures: 0,
    });
    tally.endedAt = at;
    // 'skipped' outcomes (link-less favorites) are not checks.
    if (result.outcome === 'checked') {
      tally.favoritesChecked += 1;
    }
    tally.newChaptersFound += result.newChapters.length;
    tally.downloadsQueued += result.queuedDownloads;
  }

  /** Record one failed check (count only — detail rides failure.digest). */
  public recordFailure(at: number = Date.now()): void {
    const tally = (this.tally ??= {
      startedAt: at,
      endedAt: at,
      favoritesChecked: 0,
      newChaptersFound: 0,
      downloadsQueued: 0,
      checkFailures: 0,
    });
    tally.endedAt = at;
    tally.checkFailures += 1;
  }

  /**
   * Close the sweep: returns the digest payload when the sweep checked
   * or attempted anything, else null (a no-op wake emits nothing).
   * Resets the accumulator — the next due favorite opens a fresh sweep.
   */
  public take(): FavoritesDigestData | null {
    const tally = this.tally;
    this.tally = undefined;
    if (tally === undefined) {
      return null;
    }
    if (tally.favoritesChecked === 0 && tally.checkFailures === 0) {
      return null;
    }
    return {
      startedAt: new Date(tally.startedAt).toISOString(),
      endedAt: new Date(tally.endedAt).toISOString(),
      favoritesChecked: tally.favoritesChecked,
      newChaptersFound: tally.newChaptersFound,
      downloadsQueued: tally.downloadsQueued,
      checkFailures: tally.checkFailures,
    };
  }
}
