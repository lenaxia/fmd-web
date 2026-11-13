import {
  cleanMultilinedString,
  cleanString,
  cleanURL,
  commonStringFilter,
  fixWhiteSpace,
  removeHostFromURL,
  removeHostFromURLsPair,
  removeStringBreaks,
  sameText,
  trimRightCharComma,
} from './fmdstrings.js';

/**
 * §5.8 GetInfo post-processing pipeline — TypeScript port of FMD2's
 * TMangaInformation.GetInfoFromURL post-processing (uData.pas:85-207) via
 * the FPC ground-truth replication `corpus/harness/fmdnormalize.pas`
 * (FPC 3.2.2 oracle; statement-by-statement, inline citations kept).
 *
 * The function is PURE: raw module MANGAINFO (§5.1 facade shape) in,
 * normalized MANGAINFO out. uData.pas:85-207 never rewrites `status`, so it
 * is passed through untouched (fmdnormalize.pas header note).
 *
 * Deviations documented by the harness (fmdnormalize.pas header, kept here):
 *  1. GetBaseMangaInfo/FillBaseMangaInfo (uData.pas:95,140) is a provable
 *     no-op for a fresh post-OnGetInfo snapshot — omitted.
 *  2. Field arrays (altTitles/authors/artists/genres) are FMD2 modules'
 *     `table.concat(t, ', ')` shape before assignment — a string is taken
 *     verbatim, an array is joined with ', ', null/missing → ''.
 *  3. isRemoveHostFromChapterLinks defaults True (uData.pas:64 ctor);
 *     OptionRemoveMangaNameFromChapter defaults False (FMDOptions.pas:168).
 *
 * EXACT step order (uData.pas): link fallback :111-113 → info cleanup
 * :115-127 → fix info :129-139 → pad/prune + Trim :142-152 →
 * case-insensitive dedup deleting the EARLIER index j, last survives
 * :154-173 → RemoveHostFromURLsPair :175-179 → chapter-name cleanup
 * :180-183 → optional manga-name prefix strip :185-202 → NumChapter :205.
 */

export interface NormalizeFlags {
  /** uData.pas:64 constructor default True. */
  readonly isRemoveHostFromChapterLinks: boolean;
  /** FMDOptions.pas:168 default False. */
  readonly OptionRemoveMangaNameFromChapter: boolean;
}

export const DEFAULT_NORMALIZE_FLAGS: NormalizeFlags = {
  isRemoveHostFromChapterLinks: true,
  OptionRemoveMangaNameFromChapter: false,
};

/** The normalized MANGAINFO shape the oracle emits, in emit order. */
export interface NormalizedMangaInfo {
  title: string;
  altTitles: string;
  authors: string;
  artists: string;
  genres: string;
  status: string;
  summary: string;
  coverLink: string;
  url: string;
  link: string;
  chapterLinks: string[];
  chapterNames: string[];
  numChapter: number;
}

/**
 * fmdnormalize.pas ScalarField: string verbatim; array joined ', ' (Lua
 * table.concat semantics; null entries skipped, other non-strings emitted as
 * compact JSON); null/missing → ''; other scalars emitted as compact JSON
 * (fpjson AsJSON).
 */
function scalarField(raw: Record<string, unknown>, name: string): string {
  const value = raw[name];
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      if (i > 0) out += ', ';
      if (typeof item === 'string') out += item;
      else if (item !== null && item !== undefined) out += JSON.stringify(item);
    }
    return out;
  }
  return JSON.stringify(value);
}

/**
 * fmdnormalize.pas GetList: array → one entry per element (non-string → ''),
 * single string → one entry per LINE (TStrings Text-splitting: CRLF, LF and
 * lone CR are breaks; a trailing break adds no empty item).
 */
function getList(raw: Record<string, unknown>, name: string): string[] {
  const value = raw[name];
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : ''));
  }
  if (typeof value === 'string') {
    return textSplit(value);
  }
  return [];
}

/** FPC TStrings.SetTextStr line splitting (#13, #10, CRLF; trailing → no item). */
export function textSplit(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    const start = i;
    while (i < value.length && value.charCodeAt(i) !== 10 && value.charCodeAt(i) !== 13) {
      i += 1;
    }
    out.push(value.slice(start, i));
    if (value.charCodeAt(i) === 13) i += 1;
    if (value.charCodeAt(i) === 10) i += 1;
  }
  return out;
}

/**
 * The uData.pas:85-207 pipeline. Input is the RAW module MANGAINFO (plain
 * object, §5.1 facade shape read back host-side); the returned object is the
 * normalized state in the oracle's field emit order. `flags` missing keys
 * keep the documented defaults.
 */
export function normalizeMangaInfo(
  raw: Readonly<Record<string, unknown>>,
  flags: Partial<NormalizeFlags> = {},
): NormalizedMangaInfo {
  const f: NormalizeFlags = {
    isRemoveHostFromChapterLinks: flags.isRemoveHostFromChapterLinks ?? true,
    OptionRemoveMangaNameFromChapter: flags.OptionRemoveMangaNameFromChapter ?? false,
  };

  const url = scalarField(raw, 'url');
  let title = scalarField(raw, 'title');
  let altTitles = scalarField(raw, 'altTitles');
  let link = scalarField(raw, 'link');
  let coverLink = scalarField(raw, 'coverLink');
  let authors = scalarField(raw, 'authors');
  let artists = scalarField(raw, 'artists');
  let genres = scalarField(raw, 'genres');
  const status = scalarField(raw, 'status');
  let summary = scalarField(raw, 'summary');
  const chapterLinks = getList(raw, 'chapterLinks');
  const chapterNames = getList(raw, 'chapterNames');

  // uData.pas:111-113 — Link fallback from URL
  if (link === '') link = removeHostFromURL(url);

  // uData.pas:115-127 — cleanup info
  coverLink = cleanURL(coverLink);
  title = pascalTrimChain(title);
  altTitles = pascalTrimChain(altTitles);
  authors = pascalTrim(fixWhiteSpace(removeStringBreaks(pascalTrim(authors))));
  artists = pascalTrim(fixWhiteSpace(removeStringBreaks(pascalTrim(artists))));
  genres = pascalTrim(fixWhiteSpace(removeStringBreaks(pascalTrim(genres))));

  authors = trimRightCharComma(pascalTrim(fixWhiteSpace(authors)));
  artists = trimRightCharComma(pascalTrim(fixWhiteSpace(artists)));
  genres = trimRightCharComma(pascalTrim(fixWhiteSpace(genres)));

  summary = cleanMultilinedString(fixWhiteSpace(summary));

  // uData.pas:129-139 — fix info
  if (authors[0] === '<' || authors === '-' || authors === ':') authors = '';
  if (artists[0] === '<' || artists === '-' || artists === ':') artists = '';
  if (summary === '-' || summary === ':') summary = '';
  if (title === '') title = 'N/A';
  if (altTitles[0] === '<' || altTitles === '-' || altTitles === ':') altTitles = '';

  // uData.pas:142-152 — pad/prune chapter names to match links, then Trim
  if (chapterLinks.length > 0) {
    while (chapterNames.length < chapterLinks.length) chapterNames.push('');
    while (chapterLinks.length < chapterNames.length) chapterNames.pop();
    for (let j = 0; j < chapterLinks.length; j += 1) {
      chapterLinks[j] = (chapterLinks[j] ?? '').trim();
      chapterNames[j] = (chapterNames[j] ?? '').trim();
    }
  }

  // uData.pas:154-173 — case-insensitive duplicate removal deleting the
  // EARLIER index j, so the LAST occurrence's link+name survive
  if (chapterLinks.length > 0) {
    let j = 0;
    while (j < chapterLinks.length - 1) {
      let del = false;
      if (j + 1 < chapterLinks.length) {
        for (let k = j + 1; k < chapterLinks.length; k += 1) {
          if (sameText(chapterLinks[j] ?? '', chapterLinks[k] ?? '')) {
            chapterLinks.splice(j, 1);
            chapterNames.splice(j, 1);
            del = true;
            break;
          }
        }
      }
      if (!del) j += 1;
    }
  }

  if (chapterLinks.length > 0) {
    // uData.pas:175-179 — remove host from chapter links (pair)
    if (f.isRemoveHostFromChapterLinks) {
      removeHostFromURLsPair(chapterLinks, chapterNames);
    }
    // uData.pas:180-183 — fixing chapter name
    for (let j = 0; j < chapterNames.length; j += 1) {
      chapterNames[j] = cleanString(
        removeStringBreaks(commonStringFilter(chapterNames[j] ?? '')),
      ).trim();
    }

    // uData.pas:185-202 — remove manga name from chapter
    if (f.OptionRemoveMangaNameFromChapter && title !== '') {
      const s = pascalLowerCaseLen(title);
      for (let k = 0; k < chapterNames.length; k += 1) {
        const s2 = pascalLowerCaseLen(chapterNames[k] ?? '');
        if (s2.length > s.length && s2.startsWith(s)) {
          let stripped = (chapterNames[k] ?? '').slice(s.length);
          stripped = stripped.trim();
          if (stripped.slice(0, 2) === '- ') stripped = stripped.slice(2);
          chapterNames[k] = stripped;
        }
      }
    }
  }

  // uData.pas:205
  const numChapter = chapterLinks.length;

  return {
    title,
    altTitles,
    authors,
    artists,
    genres,
    status,
    summary,
    coverLink,
    url,
    link,
    chapterLinks,
    chapterNames,
    numChapter,
  };
}

// Trim(FixWhiteSpace(RemoveStringBreaks(CommonStringFilter(x)))) — uData.pas:116-117
function pascalTrimChain(x: string): string {
  return pascalTrim(fixWhiteSpace(removeStringBreaks(commonStringFilter(x))));
}

/** SysUtils.Trim over ASCII <= #32. */
function pascalTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 32) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 32) end -= 1;
  return s.slice(start, end);
}

/** FPC LowerCase: ASCII A-Z only (uData.pas:186-202 uses byte-wise lower). */
function pascalLowerCaseLen(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}
