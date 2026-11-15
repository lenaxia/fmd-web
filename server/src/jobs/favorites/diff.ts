/**
 * New-chapter diff — `TFavoriteThread.DoCheck` parity
 * (uFavoritesManager.pas:364-370, §7.2/D8).
 *
 * Ground truth: the stored `DownloadedChapterList` text is loaded into a
 * `TStringList` with `Sorted := True` (default `CaseSensitive := False`)
 * and every live `ChapterLinks[i]` is membership-tested with `IndexOf`,
 * whose binary search compares with `AnsiCompareText` — ASCII-only
 * case-insensitive equality. A live chapter NOT found in the stored
 * list yields its live-list INDEX in `NewMangaInfoChaptersPos`, so the
 * new-chapter set is the ordered set-difference (live order preserved,
 * duplicates in the live list stay distinct positions).
 */

import { hasChapter } from '../library/merge.js';

/** One new chapter: its live-list position plus the projected name. */
export interface NewChapter {
  /** Index into the live `chapterLinks` (ascending, order preserved). */
  readonly position: number;
  /** The post-§5.8-normalized live link. */
  readonly link: string;
  /** The live chapter name at the same position ('' when absent). */
  readonly name: string;
}

/**
 * `NewMangaInfoChaptersPos` parity — the positions of live chapters the
 * stored list does not contain (case-insensitive `IndexOf` membership,
 * :364-370). Positions ascend; live order is preserved verbatim.
 */
export function newChapterPositions(
  liveChapterLinks: readonly string[],
  storedDownloadedList: string,
): number[] {
  const positions: number[] = [];
  for (let i = 0; i < liveChapterLinks.length; i += 1) {
    const link = liveChapterLinks[i] ?? '';
    if (!hasChapter(storedDownloadedList, link)) {
      positions.push(i);
    }
  }
  return positions;
}

/** The diff projected onto {position, link, name} records. */
export function newChapters(
  liveChapterLinks: readonly string[],
  liveChapterNames: readonly string[],
  storedDownloadedList: string,
): NewChapter[] {
  return newChapterPositions(liveChapterLinks, storedDownloadedList).map((position) => ({
    position,
    link: liveChapterLinks[position] ?? '',
    name: liveChapterNames[position] ?? '',
  }));
}
