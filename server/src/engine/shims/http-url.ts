/**
 * URL massaging helpers (DESIGN §5.4): a faithful port of FMD2's
 * `httpsendthread.pas` URL pipeline (:152-281 SplitURL, :394-400
 * MaybeEncodeURL, :612-616 request-URL normalization) and synapse's
 * `synacode.pas` EncodeURL/DecodeURL (:494-497 + URLSpecialChar :93-94).
 */

const URL_SPECIAL_ASCII = new Set<string>([...'<>"%{}|\\^[]`']);

const HEX = '0123456789ABCDEF';

function isHexDigit(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

/**
 * synacode.pas EncodeURL (:494-497): %XX-encode the URLSpecialChar set,
 * byte-oriented like the Pascal AnsiString (each byte #0..#20, the
 * ASCII specials, and #127..#255 becomes one %XX triplet).
 */
export function encodeURL(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';
  for (const b of bytes) {
    if (b <= 0x20 || b >= 0x7f || URL_SPECIAL_ASCII.has(String.fromCharCode(b))) {
      out += `%${HEX[(b >> 4) & 0xf]}${HEX[b & 0xf]}`;
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

/** synacode.pas DecodeURL/DecodeTriplet ('%', :470-486): decode %XX bytes. */
export function decodeURL(value: string): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < value.length) {
    const ch = value[i] ?? '';
    const h1 = value[i + 1] ?? '';
    const h2 = value[i + 2] ?? '';
    if (ch === '%' && isHexDigit(h1) && isHexDigit(h2)) {
      bytes.push(parseInt(h1 + h2, 16));
      i += 3;
      continue;
    }
    for (const b of Buffer.from(ch, 'utf8')) {
      bytes.push(b);
    }
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** httpsendthread.pas MaybeEncodeURL (:394-400): encode unless already encoded. */
export function maybeEncodeURL(value: string): string {
  const trimmed = trim(value);
  if (trimmed === '') {
    return '';
  }
  if (decodeURL(trimmed).length >= trimmed.length) {
    return encodeURL(trimmed);
  }
  return trimmed;
}

/**
 * Request-URL normalization (httpsendthread.pas:612-616): strip leading
 * ':', '/', control chars and spaces, MaybeEncodeURL, prepend https://
 * when no scheme is present. Empty result ⇒ the caller fails the
 * request like the Pascal `Exit` (:613-614).
 */
export function massageUrl(url: string): string {
  // TrimLeftSet(URL, [':', '/', #0..' ']) — leading ':', '/', #0..#32
  let i = 0;
  while (i < url.length) {
    const c = url.charCodeAt(i);
    if (c === 0x3a || c === 0x2f || c <= 0x20) {
      i++;
      continue;
    }
    break;
  }
  let out = url.slice(i);
  // TrimRight — trailing whitespace
  let end = out.length;
  while (end > 0 && (out.charCodeAt(end - 1) <= 0x20)) {
    end--;
  }
  out = out.slice(0, end);
  if (out === '') {
    return '';
  }
  out = maybeEncodeURL(out);
  if (!out.includes('://')) {
    out = `https://${out}`;
  }
  return out;
}

/** SplitURL result (httpsendthread.pas:152-281): origin (+port) and path. */
export interface SplitURLResult {
  readonly host: string;
  readonly path: string;
}

/** poschar (httpsendthread.pas:176-186): 1-based find, breaking at escapeChars. */
function posChar(s: string, c: string, offset: number, escapeChars: string): number {
  for (let i = offset; i <= s.length; i++) {
    const ch = s[i - 1] ?? '';
    if (escapeChars.includes(ch)) {
      break;
    }
    if (ch === c) {
      return i;
    }
  }
  return 0;
}

/** cleanuri (:168-172): strip leading '.', ':' and '/' characters. */
function cleanUri(u: string): string {
  let out = u;
  while (out.length !== 0 && ('.:/'.includes(out[0] ?? ''))) {
    out = out.slice(1);
  }
  return out;
}

/**
 * SplitURL (httpsendthread.pas:191-281, AIncludeProtocol/AIncludePort
 * true — the redirect call's defaults): splits a URL into
 * `scheme://host[:port]` and a '/'-prefixed path. Relative input loses
 * directory context (the FMD2 `cleanuri` quirk); the scheme defaults to
 * https://.
 */
export function splitURL(aurl: string): SplitURLResult {
  let iurl = trim(aurl);
  let ihost = '';
  let ipath = '';
  let iproto = '';
  let iport = '';
  if (iurl === '') {
    return { host: '', path: '' };
  }
  if (iurl[0] === '/') {
    if (iurl.length === 1) {
      return { host: '', path: '' };
    }
    if (iurl[1] !== '/') {
      return { host: '', path: iurl };
    }
  }
  let p = posChar(iurl, ':', 1, '/');
  if (p !== 0 && p + 2 < iurl.length && (iurl[p] ?? '') === '/' && (iurl[p + 1] ?? '') === '/') {
    iproto = iurl.slice(0, p - 1);
    iurl = iurl.slice(p + 2);
    p = posChar(iurl, ':', 1, '/');
  }
  let q = 0;
  if (p !== 0 && p < iurl.length && isDigit(iurl[p] ?? '')) {
    for (q = p + 1; q <= iurl.length; q++) {
      if (!isDigit(iurl[q - 1] ?? '')) {
        break;
      }
    }
    if (q === iurl.length) {
      q++;
    }
    iport = iurl.slice(p, q - 1);
    iurl = iurl.slice(0, p - 1) + iurl.slice(q - 1);
  }
  iurl = cleanUri(iurl);
  p = posChar(iurl, '.', 1, '/');
  q = posChar(iurl, '/', 1, '');
  if (p !== 0 && p < iurl.length) {
    if (p < q) {
      ihost = iurl.slice(0, q - 1);
      iurl = iurl.slice(q - 1);
      iurl = cleanUri(iurl);
    } else if (q === 0) {
      q = posChar(iurl, '.', p + 1, '');
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
  if (ihost !== '') {
    ihost = iproto !== '' ? `${iproto}://${ihost}` : `https://${ihost}`;
    if (iport !== '') {
      ihost += `:${iport}`;
    }
  }
  if (iurl !== '') {
    ipath = `/${iurl}`;
  }
  return { host: ihost, path: ipath };
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function trim(s: string): string {
  // strip ASCII control chars (#0..#32) and whitespace at both ends —
  // eslint-disable-next-line no-control-regex
  return s.replace(/^[\u0000-\u0020]+/, '').replace(/[\u0000-\u0020]+$/, '');
}

/**
 * Redirect Location resolution (httpsendthread.pas:649-671): an absolute
 * Location wins; a path-only Location merges onto the current URL's
 * origin; an empty Location re-requests the current URL.
 */
export function resolveRedirectLocation(currentUrl: string, location: string): string {
  const loc = trim(location);
  if (loc === '') {
    return currentUrl;
  }
  const locSplit = splitURL(loc);
  let host = locSplit.host;
  const path = locSplit.path;
  if (host === '') {
    host = splitURL(currentUrl).host;
  }
  return host + path;
}
