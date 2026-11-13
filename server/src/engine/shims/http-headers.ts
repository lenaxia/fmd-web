/**
 * Header-set composition + the case-insensitive name/value map (DESIGN
 * §5.4): the `Reset`/`ResetBasic`/`AcceptImage` default sets of
 * `httpsendthread.pas:919-954` (Accept-Encoding per D13 — `zstd`
 * omitted: documented header divergence from :953) and the POST
 * Content-Type move (:730-745).
 */

const RESET_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
const RESET_ACCEPT_LANGUAGE = 'en-US,en;q=0.5';
const RESET_ACCEPT_CHARSET = 'utf-8';

/** `AcceptImage` (httpsendthread.pas:919-922): the image-download phase Accept. */
export const ACCEPT_IMAGE_VALUE = 'image/webp,*/*';

/** D13 (DESIGN §5.4): zstd is omitted from the advertised encodings. */
export const ACCEPT_ENCODING_NO_ZSTD = 'gzip, deflate, br';

export const POST_MIME_REWRITE = 'application/x-www-form-urlencoded; charset=UTF-8';

/** Case-insensitive name/value map backing the Headers/Cookies facades. */
export class NameValueMap {
  /** lower(name) → [written name, value]; first-written casing is kept. */
  private readonly map = new Map<string, [string, string]>();

  get size(): number {
    return this.map.size;
  }

  /** Case-insensitive get — missing names read as '' (TStrings.Values). */
  get(name: string): string {
    return this.map.get(name.toLowerCase())?.[1] ?? '';
  }

  /** Case-insensitive set (last writer wins; first casing is kept). */
  set(name: string, value: string): void {
    const key = name.toLowerCase();
    const existing = this.map.get(key);
    if (existing !== undefined) {
      existing[1] = value;
      return;
    }
    this.map.set(key, [name, value]);
  }

  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  remove(name: string): void {
    this.map.delete(name.toLowerCase());
  }

  clear(): void {
    this.map.clear();
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [written, value] of this.map.values()) {
      out[written] = value;
    }
    return out;
  }

  entries(): Array<[string, string]> {
    return [...this.map.values()].map(([written, value]) => [written, value]);
  }
}

/**
 * `ResetBasic` header side (httpsendthread.pas:944-954): clears the
 * headers; `Compress` on ⇒ `Accept-Encoding: gzip, deflate, br` (D13:
 * the Pascal `gzip, deflate, br, zstd` loses `zstd` — documented
 * divergence). Document/MimeType side effects live on the pipeline
 * state, not here.
 */
export function composeResetBasic(headers: NameValueMap, compress: boolean): void {
  headers.clear();
  if (compress) {
    headers.set('Accept-Encoding', ACCEPT_ENCODING_NO_ZSTD);
  }
}

/**
 * `Reset` (httpsendthread.pas:924-932): ResetBasic plus the five browser
 * default headers with their exact values.
 */
export function composeReset(headers: NameValueMap, compress: boolean): void {
  composeResetBasic(headers, compress);
  headers.set('DNT', '1');
  headers.set('Upgrade-Insecure-Requests', '1');
  headers.set('Accept', RESET_ACCEPT);
  headers.set('Accept-Language', RESET_ACCEPT_LANGUAGE);
  headers.set('Accept-Charset', RESET_ACCEPT_CHARSET);
}

/** `AcceptImage` (httpsendthread.pas:919-922). */
export function applyAcceptImage(headers: NameValueMap): void {
  headers.set('Accept', ACCEPT_IMAGE_VALUE);
}

/**
 * POST Content-Type move (httpsendthread.pas:730-745): when the request
 * headers carry `Content-Type`, it moves into `MimeType` (deleting the
 * header); a MimeType of exactly `text/html` is rewritten to
 * `application/x-www-form-urlencoded; charset=UTF-8`. Returns the new
 * MimeType.
 */
export function moveContentTypeToMimeType(headers: NameValueMap, mimeType: string): string {
  let result = mimeType;
  const headerType = headers.get('Content-Type');
  if (headerType !== '') {
    result = headerType;
    headers.remove('Content-Type');
  }
  if (result === 'text/html') {
    result = POST_MIME_REWRITE;
  }
  return result;
}
