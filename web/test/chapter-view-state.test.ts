/**
 * Chapter-view state machine (MangaPage toolbar, FMD2 pmChapterList
 * parity): pure composition tests — filter × hide-downloaded ×
 * asc/desc orderings, invert-on-visible semantics, select-new against
 * the downloaded ledger, and case-insensitive membership everywhere.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAPTER_VIEW_OPTIONS,
  chapterMatchesFilter,
  invertSelection,
  isDownloadedChapter,
  selectNewIndices,
  toDownloadedSet,
  visibleChapterIndices,
} from '../src/state/chapter-view-state';

const NAMES = ['Chapter 10', 'Chapter 11', 'Extra 12', 'Chapter 13'];
const LINKS = ['/m/ch-10', '/m/ch-11', '/m/extra-12', '/m/ch-13'];

describe('chapterMatchesFilter (pas:1939)', (): void => {
  it('case-insensitive substring over name OR link; empty query matches all', (): void => {
    expect(chapterMatchesFilter('Chapter 10', '/m/ch-10', 'chap')).toBe(true);
    expect(chapterMatchesFilter('Chapter 10', '/m/ch-10', 'CH-10')).toBe(true);
    expect(chapterMatchesFilter('Nope', '/m/extra-12', 'EXTRA')).toBe(true);
    expect(chapterMatchesFilter('Chapter 10', '/m/ch-10', 'ch-11')).toBe(false);
    expect(chapterMatchesFilter('Anything', '/anything', '')).toBe(true);
  });
});

describe('visibleChapterIndices compositions', (): void => {
  it('defaults: site order, nothing filtered or hidden', (): void => {
    expect(
      visibleChapterIndices({
        chapterNames: NAMES,
        chapterLinks: LINKS,
        downloaded: toDownloadedSet([]),
        options: DEFAULT_CHAPTER_VIEW_OPTIONS,
      }),
    ).toEqual([0, 1, 2, 3]);
  });

  it('substring filter narrows before ordering', (): void => {
    expect(
      visibleChapterIndices({
        chapterNames: NAMES,
        chapterLinks: LINKS,
        downloaded: toDownloadedSet([]),
        options: { ...DEFAULT_CHAPTER_VIEW_OPTIONS, query: 'chapter 1' },
      }),
    ).toEqual([0, 1, 3]);
  });

  it('hide-downloaded drops ledger members (case-insensitive)', (): void => {
    expect(
      visibleChapterIndices({
        chapterNames: NAMES,
        chapterLinks: LINKS,
        downloaded: toDownloadedSet(['/M/CH-11']),
        options: { ...DEFAULT_CHAPTER_VIEW_OPTIONS, hideDownloaded: true },
      }),
    ).toEqual([0, 2, 3]);
  });

  it('descending reverses the filtered+hidden view, not the underlying indices', (): void => {
    expect(
      visibleChapterIndices({
        chapterNames: NAMES,
        chapterLinks: LINKS,
        downloaded: toDownloadedSet(['/m/extra-12']),
        options: { ...DEFAULT_CHAPTER_VIEW_OPTIONS, hideDownloaded: true, ascending: false },
      }),
    ).toEqual([3, 1, 0]);
  });

  it('the full composition: filter + hide + descending', (): void => {
    // 'chapter 1' names: Chapter 10 (0), Chapter 11 (1), Chapter 13 (3);
    // ledger hides 0 and 3 → [1]; descending keeps the singleton.
    expect(
      visibleChapterIndices({
        chapterNames: NAMES,
        chapterLinks: LINKS,
        downloaded: toDownloadedSet(['/m/ch-10', '/m/ch-13']),
        options: { query: 'chapter 1', hideDownloaded: true, ascending: false },
      }),
    ).toEqual([1]);
  });

  it('mismatched name/link lengths clamp to the shorter array', (): void => {
    expect(
      visibleChapterIndices({
        chapterNames: [...NAMES, 'Ghost'],
        chapterLinks: LINKS,
        downloaded: toDownloadedSet([]),
        options: DEFAULT_CHAPTER_VIEW_OPTIONS,
      }),
    ).toEqual([0, 1, 2, 3]);
  });
});

describe('invertSelection (pmChapterList check/uncheck selected)', (): void => {
  it('flips exactly the visible rows; out-of-view selections survive', (): void => {
    // 0 hidden by filter, 1 selected outside the view
    expect(invertSelection([1], [2, 3])).toEqual([1, 2, 3]);
    // 2 visible-and-selected flips OFF, 3 visible flips ON, 1 survives
    expect(invertSelection([1, 2], [2, 3])).toEqual([1, 3]);
    expect(invertSelection([], [])).toEqual([]);
  });
});

describe('selectNewIndices (newer than the favorite\'s downloaded list)', (): void => {
  it('selects chapters absent from the ledger, case-insensitively', (): void => {
    expect(selectNewIndices(LINKS, toDownloadedSet(['/M/CH-10', '/m/ch-13']), true)).toEqual([1, 2]);
  });

  it('selects nothing when the manga is not favorited (FMD2 needs the favorite list)', (): void => {
    expect(selectNewIndices(LINKS, toDownloadedSet([]), false)).toEqual([]);
  });
});

describe('isDownloadedChapter (pas:3156 tinting)', (): void => {
  it('membership is ASCII-case-insensitive', (): void => {
    const set = toDownloadedSet(['/m/Ch-10']);
    expect(isDownloadedChapter('/m/ch-10', set)).toBe(true);
    expect(isDownloadedChapter('/M/CH-10', set)).toBe(true);
    expect(isDownloadedChapter('/m/ch-11', set)).toBe(false);
  });
});
