/**
 * `TFavoriteThread.DoCheck` outcome — pure computation over the favorite
 * row + the live §5.8-normalized info (uFavoritesManager.pas:329-395,
 * DESIGN §7.2/D8). The engine (`engine.ts`) owns the I/O: live GetInfo
 * fetch, immediate favorite persist, auto-download enqueue and the
 * :1131-1133 dual-write; this module pins the PARITY SEMANTICS:
 *
 * 1. empty favorite link → the check exits before anything (:332-334);
 * 2. on a successful GetInfo the favorite's `CurrentChapter` and
 *    `Status` update IMMEDIATELY (:346-348) — independent of the diff;
 * 3. tag-100 transfer favorite: the whole live chapter list becomes the
 *    stored downloaded list and the tag resets (:356-361) — no diff;
 * 4. otherwise the new-chapter set is the case-insensitive set-difference
 *    (see `diff.ts`, :364-370);
 * 5. `DateLastChecked := now` always (after a successful GetInfo);
 *    `DateLastUpdated := now` only when new chapters exist (:376-380);
 * 6. FMD2 drops the fetched info when there is nothing new and the
 *    series is not completed (:384-389) — surfaced here as
 *    `retainLiveInfo` so the engine can skip downstream work.
 */

import { linesToText } from '../library/merge.js';
import { newChapterPositions } from './diff.js';
import type { FavoriteRow } from '../library/store.js';

/** FMD2 `STATUS_CHECKING` (the favorite's transient state). */
export const FAVORITE_STATUS_CHECKING = 'checking';

/** FMD2 `MangaInfo_StatusCompleted` sentinel. */
export const MANGA_INFO_STATUS_COMPLETED = 'Completed';

/** The favorite as DoCheck consumes it (a snapshot — never mutated). */
export type DoCheckFavorite = Pick<
  FavoriteRow,
  'mangaKey' | 'moduleId' | 'url' | 'downloadedChapterList'
> & {
  /** Tag-100 transfer-favorite marker (:356-361). */
  readonly transferIngest?: boolean;
};

/** The live §5.8-normalized info slice DoCheck consumes. */
export interface DoCheckLiveInfo {
  readonly status: string;
  readonly chapterLinks: readonly string[];
  readonly chapterNames: readonly string[];
}

/** The outcome: what the favorite row must become + the new-chapter set. */
export interface DoCheckOutcome {
  /** Immediate `CurrentChapter` update (:346-347) = ChapterLinks.Count. */
  readonly currentChapter: number;
  /** Immediate `Status` update (:348) = the live info status. */
  readonly status: string;
  /** Stored list AFTER this check (transfer ingest rewrites it, :358). */
  readonly downloadedChapterList: string;
  /** New-chapter positions (empty for the transfer branch). */
  readonly newChapterPositions: readonly number[];
  /** `DateLastChecked := now` (:376). */
  readonly lastCheck: number;
  /** `DateLastUpdated := now` only when new chapters exist (:378-380). */
  readonly lastUpdated: number | undefined;
  /** true when the tag-100 transfer branch ran (:356-361). */
  readonly transferIngest: boolean;
  /**
   * FMD2 keeps the fetched info alive only for real new chapters or a
   * completed series (:384-389) — false means no downstream work.
   */
  readonly retainLiveInfo: boolean;
}

/**
 * The DoCheck semantics over one favorite + one live snapshot. `now` is
 * the wall/fake clock stamp (Pascal `Now` analog — epoch ms here).
 */
export function doCheck(
  favorite: DoCheckFavorite,
  live: DoCheckLiveInfo,
  now: number,
): DoCheckOutcome {
  const stored = favorite.downloadedChapterList ?? '';
  // Tag-100 transfer favorite (:356-361): mark EVERYTHING downloaded,
  // reset the tag, no diff runs.
  if (favorite.transferIngest === true) {
    const allChapters = linesToText([...live.chapterLinks]);
    return {
      currentChapter: live.chapterLinks.length,
      status: live.status,
      downloadedChapterList: allChapters,
      newChapterPositions: [],
      lastCheck: now,
      lastUpdated: undefined,
      transferIngest: true,
      retainLiveInfo: live.chapterLinks.length > 0,
    };
  }
  // Regular check: immediate count/status update, then the diff.
  const positions = newChapterPositions(live.chapterLinks, stored);
  return {
    currentChapter: live.chapterLinks.length,
    status: live.status,
    downloadedChapterList: stored,
    newChapterPositions: positions,
    lastCheck: now,
    lastUpdated: positions.length > 0 ? now : undefined,
    transferIngest: false,
    // :384-389 — keep the info only for new chapters or a completed series
    retainLiveInfo: positions.length > 0 || live.status === MANGA_INFO_STATUS_COMPLETED,
  };
}
