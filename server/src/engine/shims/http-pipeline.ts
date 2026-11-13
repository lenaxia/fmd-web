import * as zlib from 'node:zlib';
import { NameValueMap, applyAcceptImage, composeReset, composeResetBasic, moveContentTypeToMimeType } from './http-headers.js';
import { massageUrl, resolveRedirectLocation } from './http-url.js';
import { CookieStore } from './http-cookies.js';
import type { EgressPolicy } from './http-egress.js';
import type { HostGatePort } from './http-hostgate.js';
import type { HttpTransportPort, RawHttpRequest } from './http-transport.js';

/**
 * The §5.4 request pipeline: a faithful port of
 * `THTTPSendThread.DefaultHTTPRequest` (httpsendthread.pas:594-711) —
 * URL massaging (:612-616), the retry loop (`>500` when
 * AllowServerErrorResponse is off, bounded by RetryCount, no delay,
 * :623-629), the redirect loop (301/302/303/307 followed AS GET, max
 * MaxRedirect, Referer = pre-redirect URL, :642-674), response-side
 * state (Document/Headers/MimeType/cookies per hop), Content-Encoding
 * decompression (gzip/deflate/brotli, zstd per D13) and the success
 * rule (`Document.Size > 0`, :717).
 *
 * Divergences (documented): the Pascal unit-level `counter`/
 * `redirectcounter` globals are per-request here; `ResetBasic` keeps
 * the shared cookie jar (persistent per §5.3) where FMD2 clears the
 * per-request working set that its CookieManager re-seeds.
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
export const DEFAULT_TIMEOUT_MS = 15000;
const REDIRECT_CODES = new Set([301, 302, 303, 307]);

/** Stream facade backing (bytes; string views are UTF-8). */
export class HttpDocument {
  private content: Buffer = Buffer.alloc(0);

  /** Size in bytes; request success ⇔ Size > 0 (httpsendthread.pas:717). */
  get size(): number {
    return this.content.length;
  }

  /** Writable Size (FMD2 SetSize): truncate or zero-fill. */
  set size(value: number) {
    const target = Math.max(0, Math.trunc(value));
    if (target <= this.content.length) {
      this.content = this.content.subarray(0, target);
      return;
    }
    const grown = Buffer.alloc(target);
    this.content.copy(grown, 0);
    this.content = grown;
  }

  writeString(s: string): void {
    this.content = Buffer.concat([this.content, Buffer.from(s, 'utf8')]);
  }

  clear(): void {
    this.content = Buffer.alloc(0);
  }

  /** `ToString` (= `ReadString`): UTF-8 decode of the stream bytes. */
  toString(): string {
    return this.content.toString('utf8');
  }

  setContent(s: string): void {
    this.content = Buffer.from(s, 'utf8');
  }

  get bytes(): Uint8Array {
    return new Uint8Array(this.content);
  }

  setBytes(b: Uint8Array): void {
    this.content = Buffer.from(b);
  }
}

export interface HttpPipelineOptions {
  readonly transport: HttpTransportPort;
  readonly egress: EgressPolicy;
  readonly cookies: CookieStore;
  readonly gate?: HostGatePort | undefined;
  /** The abort handle read (Terminated semantics). */
  readonly isTerminated: () => boolean;
}

interface HopResult {
  /** A transport-level response was read (synapse `HTTPMethod` result). */
  readonly sent: boolean;
  readonly status: number;
  /** Hard policy stop (egress deny) — abandon the whole request. */
  readonly denied: boolean;
}

export class HttpPipeline {
  resultCode = 0;
  resultString = '';
  lastURL = '';
  mimeType = 'text/html';
  userAgent = DEFAULT_USER_AGENT;
  timeout = DEFAULT_TIMEOUT_MS;
  retryCount = 0;
  maxRedirect = 5;
  enabledCookies = true;
  followRedirection = true;
  allowServerErrorResponse = false;
  compress = true;
  readonly headers = new NameValueMap();
  readonly document = new HttpDocument();

  private readonly transport: HttpTransportPort;
  private readonly egress: EgressPolicy;
  private readonly cookies: CookieStore;
  private readonly gate: HostGatePort | undefined;
  private readonly isTerminated: () => boolean;

  constructor(options: HttpPipelineOptions) {
    this.transport = options.transport;
    this.egress = options.egress;
    this.cookies = options.cookies;
    this.gate = options.gate;
    this.isTerminated = options.isTerminated;
    // constructor parity: THTTPSendThread.Create runs Reset (:548)
    composeReset(this.headers, this.compress);
  }

  // --- default header sets -------------------------------------------------

  /** `Reset` (:924-932): ResetBasic + the five browser default headers. */
  reset(): void {
    composeReset(this.headers, this.compress);
    this.resetState();
  }

  /** `ResetBasic` (:944-954): clears + Accept-Encoding per Compress (D13). */
  resetBasic(): void {
    composeResetBasic(this.headers, this.compress);
    this.resetState();
  }

  private resetState(): void {
    this.document.clear();
    this.mimeType = 'text/html';
  }

  /** `AcceptImage` (:919-922). */
  acceptImage(): void {
    applyAcceptImage(this.headers);
  }

  // --- request methods -----------------------------------------------------

  /** `Request(method, url)` — no POST normalization (LuaHTTPSend :32-36). */
  request(method: string, url: string): boolean {
    const upper = method.toUpperCase();
    return this.requestNormalized(upper === '' ? 'GET' : upper, url);
  }

  /** `GET` (:714-716). */
  get(url: string): boolean {
    return this.requestNormalized('GET', url);
  }

  /** `HEAD` (:712-713). */
  head(url: string): boolean {
    return this.requestNormalized('HEAD', url);
  }

  /**
   * `POST` (:726-747): body rides in Document; the Content-Type header
   * moves into MimeType; exact `text/html` is rewritten.
   */
  post(url: string, postData: string): boolean {
    if (postData !== '') {
      this.document.clear();
      this.document.writeString(postData);
    }
    this.mimeType = moveContentTypeToMimeType(this.headers, this.mimeType);
    return this.requestNormalized('POST', url);
  }

  /** `XHR` (:749-755): GET + X-Requested-With (the header persists). */
  xhr(url: string): boolean {
    if (this.firstHeaderLine().startsWith('HTTP/')) {
      this.reset();
    }
    this.headers.set('X-Requested-With', 'XMLHttpRequest');
    return this.requestNormalized('GET', url);
  }

  private firstHeaderLine(): string {
    const entries = this.headers.entries();
    const first = entries[0];
    return first === undefined ? '' : `${first[0]}: ${first[1]}`;
  }

  private requestNormalized(method: string, url: string): boolean {
    if (this.isTerminated()) {
      return false;
    }
    const furl = massageUrl(url);
    if (furl === '') {
      return false; // :613-614 Exit
    }
    // FMD2 quirk (:618-620): first header line starting with 'HTTP/' → Reset
    if (this.firstHeaderLine().startsWith('HTTP/')) {
      this.reset();
    }
    return this.run(furl, method);
  }

  // --- the DefaultHTTPRequest port (:594-711) ------------------------------

  private cloneHeaders(source: NameValueMap): NameValueMap {
    const copy = new NameValueMap();
    for (const [name, value] of source.entries()) {
      copy.set(name, value);
    }
    return copy;
  }

  private restoreHeaders(snapshot: NameValueMap): void {
    const clone = this.cloneHeaders(snapshot);
    this.headers.clear();
    for (const [name, value] of clone.entries()) {
      this.headers.set(name, value);
    }
  }

  private run(furl: string, method: string): boolean {
    const snapshot = this.cloneHeaders(this.headers);
    let redirectCounter = 0;
    let currentMethod = method;
    let currentURL = furl;

    let hop = this.attemptWithRetries(currentMethod, currentURL, snapshot);
    if (hop.denied) {
      return false;
    }

    // redirect loop (:642-674): 301/302/303/307 followed AS GET
    while (this.followRedirection && REDIRECT_CODES.has(hop.status)) {
      if (this.isTerminated()) {
        return false;
      }
      if (redirectCounter >= this.maxRedirect) {
        return false;
      }
      redirectCounter += 1;
      if (!snapshot.has('Referer')) {
        snapshot.set('Referer', currentURL); // the pre-redirect URL
      }
      const location = this.headers.get('Location');
      if (location !== '') {
        currentURL = resolveRedirectLocation(currentURL, location);
      }
      currentMethod = 'GET';
      this.document.clear();
      this.restoreHeaders(snapshot);
      hop = this.attemptWithRetries(currentMethod, currentURL, snapshot);
      if (hop.denied) {
        return false;
      }
    }

    // success ⇔ Document.Size > 0 (:717)
    return this.document.size > 0;
  }

  /**
   * One attempt + its retry loop (:623-629): while the hop failed or
   * (AllowServerErrorResponse off and ResultCode > 500): abort check,
   * RetryCount bound (negative = unlimited), restore headers, retry —
   * no delay. The counter starts at 0 for every redirect hop (:668).
   */
  private attemptWithRetries(
    method: string,
    url: string,
    snapshot: NameValueMap,
  ): HopResult {
    let counter = 0;
    let hop = this.attempt(method, url);
    while (!hop.sent || (!this.allowServerErrorResponse && hop.status > 500)) {
      if (hop.denied || this.isTerminated()) {
        return hop;
      }
      if (this.retryCount > -1 && this.retryCount <= counter) {
        return hop;
      }
      counter += 1;
      this.restoreHeaders(snapshot);
      hop = this.attempt(method, url);
    }
    return hop;
  }

  /** One transport hop + response-side state (synapse HTTPMethod). */
  private attempt(method: string, url: string): HopResult {
    // egress policy hook — checked before EVERY send (redirect targets too)
    const verdict = this.egress.check(url);
    if (!verdict.allowed) {
      this.resultCode = 0;
      this.resultString = verdict.reason;
      return { sent: false, status: 0, denied: true };
    }

    const release =
      this.gate !== undefined ? this.gate.acquire(url, this.isTerminated) : () => undefined;
    if (release === null) {
      // queued-but-unstarted request failing fast on abort
      this.resultCode = 0;
      this.resultString = 'Terminated';
      return { sent: false, status: 0, denied: false };
    }
    try {
      const requestHeaders: Record<string, string> = {};
      for (const [name, value] of this.headers.entries()) {
        requestHeaders[name] = value;
      }
      // synapse request-side inserts (:469-477): UA always, Content-Type
      // only when a body is sent; cookies via the jar (SetHTTPCookies)
      if (this.userAgent !== '') {
        requestHeaders['User-Agent'] = this.userAgent;
      }
      const body = this.document.toString();
      if (body !== '' && this.mimeType !== '') {
        requestHeaders['Content-Type'] = this.mimeType;
      }
      if (this.enabledCookies) {
        const cookieHeader = this.cookies.requestHeader();
        if (cookieHeader !== '' && requestHeaders['Cookie'] === undefined) {
          requestHeaders['Cookie'] = cookieHeader;
        }
      }

      const raw: RawHttpRequest = {
        method,
        url,
        headers: requestHeaders,
        body,
        timeoutMs: this.timeout,
      };
      const result = this.transport.send(raw);
      if (!result.ok) {
        // synapse failure path: ResultCode stays at the initial 500 (:615)
        this.resultCode = 500;
        this.resultString = '';
        this.document.clear();
        this.headers.clear();
        return { sent: false, status: 500, denied: false };
      }

      this.resultCode = result.status;
      this.resultString = result.statusText;
      this.lastURL = url;

      // response headers replace the request headers (synapse Clear+read)
      this.headers.clear();
      for (const [name, value] of result.headers) {
        const existing = this.headers.get(name);
        this.headers.set(name, existing === '' ? value : `${existing}\n${value}`);
      }

      // cookies per hop (:572-574): enabled → parse; disabled → clear
      if (this.enabledCookies) {
        for (const setCookie of result.setCookie) {
          this.cookies.addServerCookie(setCookie);
        }
      } else {
        this.cookies.clear();
      }

      // MimeType ← received Content-Type, default 'text/html' (:669-670)
      const contentType = this.headers.get('Content-Type');
      this.mimeType = contentType !== '' ? contentType : 'text/html';

      // response body into the Document, then decompress in place (:684-710)
      this.document.setBytes(result.body);
      this.decompressDocument();
      return { sent: true, status: result.status, denied: false };
    } finally {
      release();
    }
  }

  /** Decompression (:684-710): zstd, then br, then gzip/deflate (D13). */
  private decompressDocument(): void {
    if (this.document.size <= 0) {
      return;
    }
    const encoding = this.headers.get('Content-Encoding').toLowerCase();
    let kind: 'zstd' | 'br' | 'gzip' | undefined;
    if (encoding.includes('zstd')) {
      kind = 'zstd';
    } else if (encoding.includes('br')) {
      kind = 'br';
    } else if (encoding.includes('gzip') || encoding.includes('deflate')) {
      kind = 'gzip';
    }
    if (kind === undefined) {
      return;
    }
    const input = Buffer.from(this.document.bytes);
    try {
      let decoded: Buffer;
      switch (kind) {
        case 'zstd':
          decoded = decompressZstd(input);
          break;
        case 'br':
          decoded = zlib.brotliDecompressSync(input);
          break;
        case 'gzip':
          decoded = gunzipOrInflate(input);
          break;
      }
      this.document.setBytes(decoded);
    } catch {
      // decode failure keeps the raw bytes (the Pascal try/except)
    }
  }
}

function gunzipOrInflate(input: Buffer): Buffer {
  try {
    return zlib.gunzipSync(input);
  } catch {
    return zlib.inflateSync(input);
  }
}

function decompressZstd(input: Buffer): Buffer {
  const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (zstd === undefined) {
    throw new Error('zstd decoding unavailable (D13)');
  }
  return zstd(input);
}
