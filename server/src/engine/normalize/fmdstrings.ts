/**
 * Pascal-parity string helpers ported from FMD2's uBaseUnit.pas through the
 * FPC ground-truth replication `corpus/harness/fmdstrings.pas` (FPC 3.2.2
 * oracle, byte-for-byte behavior — see corpus/meta.json provenance pins and
 * the harness self-test gates).
 *
 * FMD2 provenance (uBaseUnit.pas @ 97c903b): StringOfString :1507,
 * TrimLeftChar :2177 / TrimRightChar :2193 / TrimChar :2171, StringFilter
 * table :62-98, HTMLEntitiesChar table :101-190, StringFilter :2056,
 * HTMLEntitiesFilter :2088, CommonStringFilter :2119, CleanString :1928,
 * CleanMultilinedString :1940, FixWhiteSpace :1913, RemoveStringBreaks
 * :2153, CleanURL :1964, RemoveHostFromURL :969, RemoveHostFromURLsPair
 * :983.
 *
 * FPC AnsiString semantics kept exactly: all operations are byte-wise over
 * UTF-8 (opaque data), `LowerCase`/`SameText`/`StringReplace[rfIgnoreCase]`
 * fold ASCII A-Z ONLY (FPC without the cwstring widestring manager), and
 * `Pos` is 1-based. JS strings hold the same text; indexes are code units —
 * equivalent for every operation here because all patterns are ASCII except
 * the entity tables, which are compared byte-exactly (case-sensitively for
 * HTMLEntitiesFilter, ASCII-case-insensitively for StringFilter).
 */

import { splitURL } from '../lua/pascal-strings.js';

/** FPC SysUtils.LowerCase: folds ASCII A-Z only. */
export function pascalLowerCase(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** FPC SameText (CompareText = 0): ASCII-case-insensitive equality. */
export function sameText(a: string, b: string): boolean {
  return pascalLowerCase(a) === pascalLowerCase(b);
}

/** FPC SysUtils.Trim: chars <= #32 from both ends. */
function pascalTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 32) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 32) end -= 1;
  return s.slice(start, end);
}

/** uBaseUnit.pas:2193 TrimRightChar with the ',' set (used by uData). */
export function trimRightCharComma(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 44) end -= 1;
  return s.slice(0, end);
}

/** FPC Pos(probe, s) > 0 probe helper (ASCII-case-insensitive haystack fold). */
function containsCI(haystackLowered: string, probe: string): boolean {
  if (probe === '') return true; // Pascal Pos('') returns 1
  return haystackLowered.includes(pascalLowerCase(probe));
}

/** FPC StringReplace(rfIgnoreCase, rfReplaceAll) — ASCII-case-insensitive. */
function ciReplaceAll(s: string, from: string, to: string): string {
  if (from === '') return s;
  let out = '';
  let i = 0;
  const needleLower = pascalLowerCase(from);
  while (i < s.length) {
    const slice = s.slice(i, i + from.length);
    if (slice.length === from.length && pascalLowerCase(slice) === needleLower) {
      out += to;
      i += from.length;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** FPC StringReplace(rfReplaceAll) — case-sensitive. */
function replaceAll(s: string, from: string, to: string): string {
  if (from === '') return s;
  return s.split(from).join(to);
}

// ---------------------------------------------------------------------------
// uBaseUnit.pas:62-98 StringFilterChar — exact table (incl. the FMD2
// &euro;→© / &copy;→€ swap, :89-90, and &ndash;→ASCII '-' :183)
// ---------------------------------------------------------------------------
const STRING_FILTER_CHAR: readonly (readonly [string, string])[] = [
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['&#x27;', "'"],
  ['&#33;', '!'],
  ['&#36;', '$'],
  ['&#37;', '%'],
  ['&#38;', '&'],
  ['&#39;', "'"],
  ['&#033;', '!'],
  ['&#036;', '$'],
  ['&#037;', '%'],
  ['&#038;', '&'],
  ['&#039;', "'"],
  ['&#8211;', '-'],
  ['&gt;', '>'],
  ['&lt;', '<'],
  ['&amp;', '&'],
  ['&ldquo;', '"'],
  ['&rdquo;', '"'],
  ['&quot;', '"'],
  ['&lsquo;', "'"],
  ['&rsquo;', "'"],
  ['&nbsp;', ' '],
  ['&cent;', '¢'],
  ['&pound;', '£'],
  ['&yen;', '¥'],
  ['&euro;', '©'],
  ['&copy;', '€'],
  ['&reg;', '®'],
  ['［', '['],
  ['］', ']'],
  ['（', '('],
  ['）', ')'],
  ['&frac12;', '½'],
  ['&deg;', '°'],
  ['&sup2;', '²'],
];

// ---------------------------------------------------------------------------
// uBaseUnit.pas:101-190 HTMLEntitiesChar — exact table (UTF-8 bytes rendered
// as the code points they encode; &Etilde/&etilde are U+1EB8/U+1EB9)
// ---------------------------------------------------------------------------
const HTML_ENTITIES_CHAR: readonly (readonly [string, string])[] = [
  ['&#171;', '«'],
  ['&#176;', '°'],
  ['&Agrave;', 'À'],
  ['&#192;', 'À'],
  ['&Aacute;', 'Á'],
  ['&#193;', 'Á'],
  ['&Acirc;', 'Â'],
  ['&#194;', 'Â'],
  ['&Atilde;', 'Ã'],
  ['&ccedil;', 'ç'],
  ['&Egrave;', 'È'],
  ['&Eacute;', 'É'],
  ['&Ecirc;', 'Ê'],
  ['&#202;', 'Ê'],
  ['&Etilde;', 'Ẹ'],
  ['&Igrave;', 'Ì'],
  ['&Iacute;', 'Í'],
  ['&Itilde;', 'Ỉ'],
  ['&ETH;', 'Đ'],
  ['&Ograve;', 'Ò'],
  ['&Oacute;', 'Ó'],
  ['&Ocirc;', 'Ô'],
  ['&#212;', 'Ô'],
  ['&Otilde;', 'Õ'],
  ['&Ugrave;', 'Ù'],
  ['&Uacute;', 'Ú'],
  ['&Yacute;', 'Ý'],
  ['&#221;', 'Ý'],
  ['&agrave;', 'à'],
  ['&#224;', 'à'],
  ['&aacute;', 'á'],
  ['&#225;', 'á'],
  ['&acirc;', 'â'],
  ['&#226;', 'â'],
  ['&atilde;', 'ã'],
  ['&#227;', 'ã'],
  ['&#231;', 'ç'],
  ['&egrave;', 'è'],
  ['&#232;', 'è'],
  ['&eacute;', 'é'],
  ['&#233;', 'é'],
  ['&etilde;', 'ẹ'],
  ['&ecirc;', 'ê'],
  ['&#234;', 'ê'],
  ['&igrave;', 'ì'],
  ['&#236;', 'ì'],
  ['&iacute;', 'í'],
  ['&#237;', 'í'],
  ['&itilde;', 'ỉ'],
  ['&#238;', 'î'],
  ['&eth;', 'đ'],
  ['&ograve;', 'ò'],
  ['&#242;', 'ò'],
  ['&oacute;', 'ó'],
  ['&#243;', 'ó'],
  ['&ocirc;', 'ô'],
  ['&#244;', 'ô'],
  ['&otilde;', 'õ'],
  ['&#245;', 'õ'],
  ['&ugrave;', 'ù'],
  ['&#249;', 'ù'],
  ['&uacute;', 'ú'],
  ['&#250;', 'ú'],
  ['&yacute;', 'ý'],
  ['&#253;', 'ý'],
  ['&#8217;', "'"],
  ['&#8220;', '"'],
  ['&#8221;', '"'],
  ['&#8230;', '...'],
  ['&Auml;', 'Ä'],
  ['&auml;', 'ä'],
  ['&Ouml;', 'Ö'],
  ['&ouml;', 'ö'],
  ['&Uuml;', 'Ü'],
  ['&uuml;', 'ü'],
  ['&szlig;', 'ß'],
  ['&mu;', 'μ'],
  ['&#956;', 'μ'],
  ['&raquo;', '»'],
  ['&laquo;', '«'],
  ['&#8216;', '‘'],
  ['&ndash;', '-'],
  ['&gamma;', 'γ'],
];

/**
 * uBaseUnit.pas:2056 StringFilter: case-insensitive replace pass over the
 * full entities (probe = Pos on LowerCase), then the broken-entity pass
 * (entities missing their trailing ';' replaced the same way).
 */
export function stringFilter(source: string): string {
  let result = source;
  if (source.length === 0) return result;

  const lowered = pascalLowerCase(result);
  for (const [from, to] of STRING_FILTER_CHAR) {
    if (containsCI(lowered, from)) {
      result = ciReplaceAll(result, from, to);
    }
  }
  // broken entities (no trailing ';')
  for (const [from, to] of STRING_FILTER_CHAR) {
    if (from.length > 1 && from[from.length - 1] === ';') {
      const broken = from.slice(0, -1);
      if (containsCI(pascalLowerCase(result), broken)) {
        result = ciReplaceAll(result, broken, to);
      }
    }
  }
  return result;
}

/**
 * uBaseUnit.pas:2088 HTMLEntitiesFilter: same two-pass shape but the Pos
 * probes are case-SENSITIVE (only StringReplace is case-insensitive).
 */
export function htmlEntitiesFilter(source: string): string {
  let result = source;
  if (source.length === 0) return result;

  for (const [from, to] of HTML_ENTITIES_CHAR) {
    if (result.includes(from)) {
      result = replaceAll(result, from, to);
    }
  }
  // broken entities (no trailing ';')
  for (const [from, to] of HTML_ENTITIES_CHAR) {
    if (from.length > 1 && from[from.length - 1] === ';') {
      const broken = from.slice(0, -1);
      if (result.includes(broken)) {
        result = replaceAll(result, broken, to);
      }
    }
  }
  return result;
}

/** uBaseUnit.pas:2119 CommonStringFilter. */
export function commonStringFilter(source: string): string {
  if (source === '') return source;
  return pascalTrim(htmlEntitiesFilter(stringFilter(pascalTrim(source))));
}

/** uBaseUnit.pas:1928 CleanString: line breaks → spaces, whitespace runs collapsed. */
export function cleanString(s: string): string {
  let result = pascalTrim(s);
  if (result === '') return result;
  result = replaceAll(result, '\r', ' ');
  result = replaceAll(result, '\n', ' ');
  result = replaceAll(result, '\t', ' ');
  while (result.includes('  ')) {
    result = replaceAll(result, '  ', ' ');
  }
  return pascalTrim(result);
}

/** uBaseUnit.pas:1507 StringOfString. */
function stringOf(s: string, n: number): string {
  return n < 1 ? '' : s.repeat(n);
}

/** uBaseUnit.pas:1940 CleanMultilinedString: collapse CRLF (then LF) runs to `max`. */
export function cleanMultilinedString(s: string, maxLineEnding = 1): string {
  let result = pascalTrim(s);
  if (result === '') return result;
  const max = maxLineEnding < 1 ? 1 : maxLineEnding;

  const rn = stringOf('\r\n', max);
  const rnp = rn + '\r\n';
  while (result.includes(rnp)) {
    result = replaceAll(result, rnp, rn);
  }

  const n = stringOf('\n', max);
  const np = n + '\n';
  while (result.includes(np)) {
    result = replaceAll(result, np, n);
  }
  return result;
}

/** uBaseUnit.pas:1913 FixWhiteSpace: strip U+00A0 (NBSP) and U+FEFF (BOM). */
export function fixWhiteSpace(s: string): string {
  if (s === '') return s;
  return replaceAll(replaceAll(s, ' ', ''), '﻿', '');
}

/** uBaseUnit.pas:2153 RemoveStringBreaks: real CRLF/LF + literal "\n"/"\r". */
export function removeStringBreaks(source: string): string {
  if (source.length === 0) return source;
  let result = replaceAll(source, '\n', '');
  result = replaceAll(result, '\r', '');
  result = replaceAll(result, '\\n', '');
  result = replaceAll(result, '\\r', '');
  return result;
}

/**
 * uBaseUnit.pas:1964 CleanURL: protocol-preserving duplicate-slash collapse
 * via the same FPC RegExpr call FMD2 makes
 * (`ReplaceRegExpr('([^:])[\/]{2,}', …, '$1/', True)` — all occurrences).
 */
export function cleanURL(url: string): string {
  let result = pascalTrim(url);
  if (result === '') return result;
  if (result[0] === ':') result = result.slice(1);
  if (result.slice(0, 2) === '//') result = result.slice(2);
  let p = '';
  const x = result.indexOf('://');
  if (x > -1) {
    const after = x + 2;
    p = result.slice(0, after + 1);
    result = result.slice(after + 1);
    while (result[0] === '/') result = result.slice(1);
  }
  result = result.replace(/([^:])\/{2,}/g, '$1/');
  return p + result;
}

/** uBaseUnit.pas:969 RemoveHostFromURL (SplitURL wrapper — path only). */
export function removeHostFromURL(url: string): string {
  return splitURL(url).path;
}

/**
 * uBaseUnit.pas:983 RemoveHostFromURLsPair — strips hosts pairwise; entries
 * whose link reduces to '' are deleted from BOTH lists in place.
 */
export function removeHostFromURLsPair(urls: string[], names: string[]): void {
  if (urls.length !== names.length || urls.length === 0) return;
  let i = 0;
  while (i < urls.length) {
    urls[i] = removeHostFromURL(urls[i] ?? '');
    if (urls[i] !== '') {
      i += 1;
    } else {
      urls.splice(i, 1);
      names.splice(i, 1);
    }
  }
}
