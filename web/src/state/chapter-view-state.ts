/**
 * Chapter-view state machine (MangaPage toolbar, FMD2 pmChapterList
 * parity — frmMain.lfm:1649-1703): pure functions so filter + hide +
 * sort compositions are unit-testable without React. Selection is by
 * chapter INDEX into the site-order arrays; every view transform
 * (filter, hide-downloaded, asc/desc) only reorders/narrows what is
 * rendered, never the underlying indices.
 *
 * FMD2 ground truth mirrored here:
 * - case-insensitive substring Filter box (frmMain.pas:1939);
 * - Ascending/Descending presentation toggle (frmMain.pas:1552);
 * - HIDE-downloaded toggle + in-list downloaded tinting
 *   (frmMain.pas:3156) — membership is CASE-INSENSITIVE, matching the
 *   server's MergeCaseInsensitive ledger semantics;
 * - invert acts on the VISIBLE (filtered) rows only;
 * - select-new = chapters newer than the favorite's downloaded list
 *   (absent from the ledger set); requires the manga to be favorited.
 */

/** Toolbar state (one object — compositions in this module only). */
export interface ChapterViewOptions {
  /** Case-insensitive substring over chapter name OR link ('' = all). */
  readonly query: string;
  /** Hide chapters the downloaded-chapters ledger already records. */
  readonly hideDownloaded: boolean;
  /** true = site order (§5.8 emit order); false = reversed (FMD2 Desc). */
  readonly ascending: boolean;
}

export const DEFAULT_CHAPTER_VIEW_OPTIONS: ChapterViewOptions = {
  query: '',
  hideDownloaded: false,
  ascending: true,
};

/** ASCII-case-insensitive membership key (Pascal LowerCase parity). */
function chapterKey(link: string): string {
  let out = '';
  for (let i = 0; i < link.length; i += 1) {
    const c = link.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : link.charAt(i);
  }
  return out;
}

/** Build the case-insensitive downloaded-membership set (ledger links). */
export function toDownloadedSet(links: readonly string[]): ReadonlySet<string> {
  return new Set(links.map(chapterKey));
}

/** Case-insensitive substring test over name OR link (pas:1939). */
export function chapterMatchesFilter(
  name: string,
  link: string,
  query: string,
): boolean {
  const needle = query.toLowerCase();
  return name.toLowerCase().includes(needle) || link.toLowerCase().includes(needle);
}

/**
 * The rendered row order: filter → hide-downloaded → asc/desc.
 * Site-order indices in, presentation order out.
 */
export function visibleChapterIndices(input: {
  readonly chapterNames: readonly string[];
  readonly chapterLinks: readonly string[];
  readonly downloaded: ReadonlySet<string>;
  readonly options: ChapterViewOptions;
}): number[] {
  const count = Math.min(input.chapterNames.length, input.chapterLinks.length);
  const rows: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (input.options.query !== '' && !chapterMatchesFilter(input.chapterNames[i] ?? '', input.chapterLinks[i] ?? '', input.options.query)) {
      continue;
    }
    if (input.options.hideDownloaded && input.downloaded.has(chapterKey(input.chapterLinks[i] ?? ''))) {
      continue;
    }
    rows.push(i);
  }
  return input.options.ascending ? rows : rows.reverse();
}

/**
 * Invert the check state of the VISIBLE rows (pmChapterList
 * check/uncheck selected): visible members flip, rows outside the
 * current view keep their state. Result sorted ascending.
 */
export function invertSelection(selected: readonly number[], visible: readonly number[]): number[] {
  const current = new Set(selected);
  for (const index of visible) {
    if (current.has(index)) {
      current.delete(index);
    } else {
      current.add(index);
    }
  }
  return [...current].sort((a, b): number => a - b);
}

/**
 * Select-new (favorited manga only): every chapter whose link is
 * ABSENT from the downloaded ledger — the FMD2 "new chapters" diff
 * against the favorite's stored list. Returns [] when not favorited
 * (FMD2 selects nothing without the favorite's downloaded list).
 */
export function selectNewIndices(
  chapterLinks: readonly string[],
  downloaded: ReadonlySet<string>,
  favorited: boolean,
): number[] {
  if (!favorited) {
    return [];
  }
  const out: number[] = [];
  for (let i = 0; i < chapterLinks.length; i += 1) {
    if (!downloaded.has(chapterKey(chapterLinks[i] ?? ''))) {
      out.push(i);
    }
  }
  return out;
}

/** Downloaded tint test for one row (case-insensitive, pas:3156). */
export function isDownloadedChapter(link: string, downloaded: ReadonlySet<string>): boolean {
  return downloaded.has(chapterKey(link));
}
