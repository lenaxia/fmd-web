/**
 * Pascal-parity string helpers (§5.1 base globals) ported from FMD2:
 * `Trim` (LuaBaseUnit.pas:20-24 over SysUtils/synautil), `GetBetween`,
 * `SeparateLeft`, `SeparateRight` (synapse/synautil.pas:1156-1180, 1671-1727),
 * `MaybeFillHost` (uBaseUnit.pas:943 over httpsendthread.pas:191-268
 * `SplitURL`) and `MangaInfoStatusIfPos` (uBaseUnit.pas:2793-2852).
 *
 * Ports keep FMD2's exact edge cases — modules depend on them
 * (e.g. `MangaInfoStatusIfPos` output constants across 128 modules).
 */

/** Trim chars <= ' ' from both ends (SysUtils.Trim semantics). */
export function pascalTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 32) {
    start += 1;
  }
  while (end > start && s.charCodeAt(end - 1) <= 32) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** Trim any of the given chars from both ends (SysUtils.Trim with a set). */
export function pascalTrimChars(s: string, chars: string): string {
  const set = new Set(chars.split(''));
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start] ?? '')) {
    start += 1;
  }
  while (end > start && set.has(s[end - 1] ?? '')) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** Lua-callable Trim(s[, chars]) (LuaBaseUnit.pas:20-24). */
export function trimLua(s: string, chars?: string): string {
  if (chars !== undefined) {
    return pascalTrimChars(s, chars);
  }
  return pascalTrim(s);
}

/** synautil SeparateLeft: text before the first delimiter (whole if absent). */
export function separateLeft(value: string, delimiter: string): string {
  const x = value.indexOf(delimiter);
  if (x < 0) {
    return value;
  }
  return value.slice(0, x);
}

/** synautil SeparateRight: text after the first delimiter (whole if absent). */
export function separateRight(value: string, delimiter: string): string {
  const x = value.indexOf(delimiter);
  if (x < 0) {
    return value;
  }
  return value.slice(x + delimiter.length);
}

/**
 * synautil GetBetween (synautil.pas:1671-1727), nesting-aware port with
 * the original fallback branches.
 */
export function getBetween(pairBegin: string, pairEnd: string, value: string): string {
  const lenBegin = pairBegin.length;
  const lenEnd = pairEnd.length;
  if (value === pairBegin + pairEnd) {
    return '';
  }
  if (value.length < lenBegin + lenEnd) {
    return value;
  }
  const s = separateRight(value, pairBegin);
  if (s === value) {
    return value;
  }
  if (s.indexOf(pairEnd) === -1) {
    return value;
  }
  let result = '';
  let depth = 1;
  const max = s.length - lenEnd + 1;
  for (let n = 0; n < max; n += 1) {
    if (s.slice(n, n + lenEnd) === pairEnd) {
      depth -= 1;
      if (depth <= 0) {
        break;
      }
    }
    if (s.slice(n, n + lenBegin) === pairBegin) {
      depth += 1;
    }
    result += s[n];
  }
  return result;
}

/** httpsendthread.pas cleanuri: strip leading '.', ':' and '/'. */
function cleanUri(u: string): string {
  let i = 0;
  while (i < u.length && (u[i] === '.' || u[i] === ':' || u[i] === '/')) {
    i += 1;
  }
  return u.slice(i);
}

/** 1-based charAt (Pascal s[i]); out of range = ''. */
function charAt1(s: string, i: number): string {
  return i >= 1 && i <= s.length ? (s[i - 1] ?? '') : '';
}

/**
 * httpsendthread.pas:179 poschar: 1-based first occurrence of char `c`
 * from `offset1`, stopping before any escape char; 0 when absent.
 */
function poschar1(c: string, s: string, offset1: number, escapeChars: string): number {
  for (let i = offset1; i <= s.length; i += 1) {
    const ch = charAt1(s, i);
    if (ch !== '' && escapeChars.includes(ch)) {
      break;
    }
    if (ch === c) {
      return i;
    }
  }
  return 0;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

export interface SplitURLResult {
  readonly host: string;
  readonly path: string;
}

/**
 * httpsendthread.pas:191-268 SplitURL port (host/path extraction with the
 * same protocol/port/cleanuri steps, 1-based indices kept internally);
 * `MaybeFillHost` only reads host and path, so only those are returned.
 */
export function splitURL(url: string): SplitURLResult {
  let iurl = pascalTrim(url);
  let ihost = '';
  let ipath = '';
  let iproto = '';
  let iport = '';
  if (iurl === '') {
    return { host: '', path: '' };
  }
  if (charAt1(iurl, 1) === '/') {
    if (iurl.length === 1) {
      return { host: '', path: '' };
    }
    if (charAt1(iurl, 2) !== '/') {
      return { host: '', path: iurl };
    }
  }
  let p = poschar1(':', iurl, 1, '/');
  if (p !== 0 && p + 2 < iurl.length && charAt1(iurl, p + 1) + charAt1(iurl, p + 2) === '//') {
    iproto = iurl.slice(0, p - 1);
    iurl = iurl.slice(p + 2);
    p = poschar1(':', iurl, 1, '/');
  }
  let q = 0;
  if (p !== 0 && p < iurl.length && isDigit(charAt1(iurl, p + 1))) {
    for (q = p + 1; q <= iurl.length; q += 1) {
      if (!isDigit(charAt1(iurl, q))) {
        break;
      }
    }
    if (q === iurl.length) {
      q += 1;
    }
    iport = iurl.slice(p, q - 1);
    iurl = iurl.slice(0, p - 1) + iurl.slice(q - 1);
  }
  iurl = cleanUri(iurl);
  p = poschar1('.', iurl, 1, '/');
  q = poschar1('/', iurl, 1, '');
  if (p !== 0 && p < iurl.length) {
    if (p < q) {
      ihost = iurl.slice(0, q - 1);
      iurl = iurl.slice(q - 1);
      iurl = cleanUri(iurl);
    } else if (q === 0) {
      q = poschar1('.', iurl, p + 1, '');
      if (q !== 0 && q < iurl.length) {
        ihost = iurl;
        iurl = '';
      }
    }
  }
  if (ihost === '' && iurl !== '' && (iproto !== '' || iport !== '')) {
    ihost = iurl;
    iurl = '';
  }
  if (iurl !== '') {
    ipath = `/${iurl}`;
  }
  return { host: ihost, path: ipath };
}

/** uBaseUnit.pas:2003 RemoveURLDelim: trim trailing '/'. */
export function removeURLDelim(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end -= 1;
  }
  return url.slice(0, end);
}

/** uBaseUnit.pas:943 MaybeFillHost: prefix the host only for host-less URLs. */
export function maybeFillHost(host: string, url: string): string {
  const { host: h, path: p } = splitURL(url);
  if (h === '' && p !== '') {
    return removeURLDelim(host) + p;
  }
  return url;
}

/** uBaseUnit.pas:230-233 status output constants. */
export const MANGAINFO_STATUS_COMPLETED = '0';
export const MANGAINFO_STATUS_ONGOING = '1';
export const MANGAINFO_STATUS_HIATUS = '2';
export const MANGAINFO_STATUS_CANCELLED = '3';
export const MANGAINFO_STATUS_UNKNOWN = 'Unknown';

function searchMany(target: string, haystack: string): boolean {
  if (target === '') {
    return false;
  }
  if (!target.includes('|')) {
    return haystack.includes(target);
  }
  return target.split('|').some((part) => haystack.includes(part));
}

/**
 * uBaseUnit.pas:2793-2852 MangaInfoStatusIfPos port: case-insensitive
 * keyword search ( '|'-alternatives), priority ongoing → completed →
 * hiatus → cancelled, exact output constants.
 */
export function mangaInfoStatusIfPos(
  searchStr: string,
  ongoingStr = '',
  completedStr = '',
  hiatusStr = '',
  cancelledStr = '',
): string {
  if (searchStr === '') {
    return '';
  }
  const s = searchStr.toLowerCase();
  if (searchMany(ongoingStr.toLowerCase(), s)) {
    return MANGAINFO_STATUS_ONGOING;
  }
  if (searchMany(completedStr.toLowerCase(), s)) {
    return MANGAINFO_STATUS_COMPLETED;
  }
  if (searchMany(hiatusStr.toLowerCase(), s)) {
    return MANGAINFO_STATUS_HIATUS;
  }
  if (searchMany(cancelledStr.toLowerCase(), s)) {
    return MANGAINFO_STATUS_CANCELLED;
  }
  return MANGAINFO_STATUS_UNKNOWN;
}
