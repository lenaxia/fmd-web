import { Response, Headers } from 'undici';
import type { HttpAbortHandle } from '@fmd/contract';
import { toBool, toInteger, toStr } from '../lua/base-globals.js';
import type { FacadeBridge, FacadeSpec } from '../lua/facade.js';

/**
 * HTTP shim v0 (DESIGN.md §5.4, semantics of `httpsendthread.pas`) —
 * undici-backed with a RecordedResponseResolver: every response envelope
 * (status, headers incl. Set-Cookie) is built through undici's
 * `Response`/`Headers` from recorded fixtures by URL — there is NO live
 * network path.
 *
 * v0 subset the seed flows need: Document stream facade (ToString/
 * WriteString/Clear/Size, request success ⇔ Size > 0,
 * httpsendthread.pas:717), ResultCode/ResultString/LastURL, case-
 * insensitive Headers/Cookies `Values[name]`, GET/POST (+ the POST
 * Content-Type move out of `Headers` into `MimeType` and the
 * `text/html` → `application/x-www-form-urlencoded` rewrite, :730-747),
 * XHR (= GET + X-Requested-With, :749-755), Reset/ResetBasic header
 * sets (:924-932), the cookie jar fed from response Set-Cookie headers,
 * and the `Terminated` flag from the abort handle.
 */

/** One recorded response entry the resolver matches by URL. */
export interface RecordedResponse {
  /** Matched against the full request URL (exact match). */
  readonly url: string;
  readonly status: number;
  readonly statusText?: string;
  /** Response body (string). */
  readonly body: string;
  /** Extra response headers (Set-Cookie feeds the cookie jar). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The HTTP method this entry answers (default: any). */
  readonly method?: 'GET' | 'POST' | 'HEAD' | 'XHR';
  /** Response media type (Content-Type when headers omit it). */
  readonly mimeType?: string;
}

export interface RecordedRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly mimeType: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ResolvedRecordedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: string;
}

/**
 * Fixture lookup by URL — NO live network. Unknown URLs return a 404
 * response with an empty body so flows degrade exactly like a real
 * (offline) request would.
 */
export class RecordedResponseResolver {
  readonly requests: RecordedRequestRecord[] = [];

  constructor(private readonly entries: RecordedResponse[] = []) {}

  add(entry: RecordedResponse): void {
    this.entries.push(entry);
  }

  /** Resolve one request to a recorded undici Response envelope. */
  resolve(method: string, url: string, body: string, mimeType: string, headers: Readonly<Record<string, string>>): ResolvedRecordedResponse {
    this.requests.push({ method, url, body, mimeType, headers });
    const entry =
      this.entries.find((e) => e.url === url && (e.method === undefined || e.method === method)) ??
      this.entries.find((e) => e.url === url);
    if (entry === undefined) {
      return {
        status: 404,
        statusText: 'Not Found (no recorded fixture)',
        headers: new Headers(),
        body: '',
      };
    }
    const responseHeaders = new Headers(entry.headers ?? {});
    if (!responseHeaders.has('content-type')) {
      responseHeaders.set('content-type', entry.mimeType ?? 'text/html; charset=utf-8');
    }
    // The undici Response carries the recorded envelope (status +
    // Set-Cookie semantics); the body stays a plain string — a stream
    // read would need async and the facade surface is synchronous.
    const response = new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText ?? '',
      headers: responseHeaders,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: entry.body,
    };
  }
}

/** A cookie jar fed by Values writes and server Set-Cookie headers. */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  /** Case-insensitive get. */
  get(name: string): string {
    return this.jar.get(name.toLowerCase()) ?? '';
  }

  /** Case-insensitive set (last writer wins). */
  set(name: string, value: string): void {
    this.jar.set(name.toLowerCase(), value);
  }

  /** Parse one Set-Cookie header's first name=value pair into the jar. */
  addServerCookie(setCookie: string): void {
    const pair = setCookie.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      return;
    }
    this.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }

  clear(): void {
    this.jar.clear();
  }

  /** `Cookie` request-header form. */
  toRequestHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  snapshot(): Record<string, string> {
    return { ...Object.fromEntries(this.jar) };
  }

  entries(): Array<[string, string]> {
    return [...this.jar.entries()];
  }
}

/** Case-insensitive name/value map backing the Headers facade. */
export class NameValueMap {
  private readonly map = new Map<string, string>();

  get(name: string): string {
    return this.map.get(name.toLowerCase()) ?? '';
  }

  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }

  remove(name: string): void {
    this.map.delete(name.toLowerCase());
  }

  clear(): void {
    this.map.clear();
  }

  snapshot(): Record<string, string> {
    return { ...Object.fromEntries(this.map) };
  }
}

/** The backing state of one HTTP object's Document stream facade. */
export class HttpDocument {
  private parts: string[] = [];

  /** Size in bytes; success ⇔ Size > 0 (httpsendthread.pas:717). */
  size = 0;

  writeString(s: string): void {
    this.parts.push(s);
    this.size += s.length;
  }

  clear(): void {
    this.parts = [];
    this.size = 0;
  }

  toString(): string {
    return this.parts.join('');
  }

  setContent(s: string): void {
    this.parts = [s];
    this.size = s.length;
  }
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

export interface HttpShimOptions {
  readonly resolver: RecordedResponseResolver;
  readonly abort: HttpAbortHandle;
  /** When set, registers documentFacadeId → backing stream (ParseHTML). */
  readonly documents?: Map<number, HttpDocument>;
}

export interface HttpShimHandle {
  readonly spec: FacadeSpec;
  readonly document: HttpDocument;
  readonly headers: NameValueMap;
  readonly cookies: CookieJar;
  /** MimeType after POST normalization (observable for tests). */
  lastMimeType(): string;
  /** The last response code (observable for tests). */
  lastResultCode(): number;
}

/**
 * Create a real-behavior offline HTTP facade (§5.4 v0). The dispatcher
 * binds a fresh request-scoped object per event call (FMD2 LoadObject);
 * the resolver records every request for golden evidence.
 */
export function makeHttpShim(bridge: FacadeBridge, options: HttpShimOptions): HttpShimHandle {
  const { resolver, abort } = options;
  const document = new HttpDocument();
  const headers = new NameValueMap();
  const cookies = new CookieJar();
  let terminatedExternal = false;

  let resultCode = 0;
  let resultString = '';
  let lastURL = '';
  let userAgent = DEFAULT_USER_AGENT;
  let mimeType = '';
  let timeout = 0;
  let retryCount = 0;
  let maxRedirect = 5;
  let enabledCookies = true;
  let followRedirection = true;
  let allowServerErrorResponse = false;
  let compress = false;

  const resetHeaderSet = (): void => {
    headers.clear();
    headers.set('DNT', '1');
    headers.set('Upgrade-Insecure-Requests', '1');
    headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    headers.set('Accept-Language', 'en-US,en;q=0.9');
    headers.set('Accept-Charset', 'utf-8,ISO-8859-1;q=0.7,*;q=0.5');
  };

  // --- request implementation --------------------------------------------
  const performRequest = (method: string, url: string, body: string): boolean => {
    if (abort.terminated || terminatedExternal) {
      resultCode = 0;
      resultString = 'Terminated';
      return false;
    }

    // POST normalization (httpsendthread.pas:730-747): move Content-Type
    // from Headers into MimeType; rewrite text/html → urlencoded.
    if (method === 'POST') {
      const headerType = headers.get('Content-Type');
      if (headerType !== '') {
        mimeType = headerType;
        headers.remove('Content-Type');
      }
      if (mimeType === 'text/html' || mimeType.startsWith('text/html;')) {
        mimeType = 'application/x-www-form-urlencoded; charset=UTF-8';
      }
    }

    const requestHeaders: Record<string, string> = headers.snapshot();
    requestHeaders['User-Agent'] = userAgent;
    if (body !== '') {
      requestHeaders['Content-Type'] =
        mimeType !== '' ? mimeType : 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    if (enabledCookies) {
      const cookieHeader = cookies.toRequestHeader();
      if (cookieHeader !== '') {
        requestHeaders['Cookie'] = cookieHeader;
      }
    }

    document.clear();
    let response: ResolvedRecordedResponse;
    try {
      response = resolver.resolve(method, url, body, mimeType, requestHeaders);
    } catch {
      resultCode = 0;
      resultString = '';
      return false;
    }

    resultCode = response.status;
    resultString = response.statusText;
    lastURL = url;

    for (const sc of response.headers.getSetCookie()) {
      cookies.addServerCookie(sc);
    }
    document.setContent(response.body);

    // success ⇔ Document.Size > 0 (httpsendthread.pas:717)
    return document.size > 0;
  };

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    Request: (m: unknown, url: unknown) => {
      const method = toStr(m).toUpperCase();
      return performRequest(method === '' ? 'GET' : method, toStr(url), '');
    },
    GET: (url: unknown) => performRequest('GET', toStr(url), ''),
    POST: (url: unknown, postDocument: unknown) => {
      const body = typeof postDocument === 'string' ? postDocument : postDocument === undefined || postDocument === null ? '' : toStr(postDocument);
      return performRequest('POST', toStr(url), body);
    },
    HEAD: (url: unknown) => performRequest('HEAD', toStr(url), ''),
    XHR: (url: unknown) => {
      headers.set('X-Requested-With', 'XMLHttpRequest');
      const ok = performRequest('GET', toStr(url), '');
      headers.remove('X-Requested-With');
      return ok;
    },
    Reset: () => {
      resetHeaderSet();
      return undefined;
    },
    ResetBasic: () => {
      headers.clear();
      if (compress) {
        headers.set('Accept-Encoding', 'gzip, deflate, br');
      }
      return undefined;
    },
    ClearCookies: () => {
      cookies.clear();
      return undefined;
    },
    ClearCookiesStorage: () => {
      cookies.clear();
      return undefined;
    },
    GetCookies: () => cookies.toRequestHeader(),
    ParseServerCookies: (s: unknown) => {
      cookies.addServerCookie(toStr(s));
      return undefined;
    },
    AddServerCookies: (s: unknown) => {
      for (const part of toStr(s).split(';')) {
        cookies.addServerCookie(part.trim());
      }
      return undefined;
    },
    MergeCookies: () => undefined,
    RemoveCookie: (name: unknown) => {
      cookies.set(toStr(name), '');
      return undefined;
    },
    SetProxy: () => undefined,
  };

  // --- sub facades --------------------------------------------------------
  const documentFacadeId = bridge.create('', {
    get: (k) => {
      if (k === 'Size') {
        return document.size;
      }
      if (k === 'ToString') {
        return () => document.toString();
      }
      if (k === 'WriteString') {
        return (s: unknown) => {
          document.writeString(toStr(s));
          return undefined;
        };
      }
      if (k === 'Clear') {
        return () => {
          document.clear();
          return undefined;
        };
      }
      if (k === 'LoadFromFile' || k === 'SaveToFile') {
        return () => undefined; // fs jail is a later story
      }
      return undefined;
    },
    set: (k, v) => {
      // Size is writable in FMD2 (truncate semantics in v0)
      if (k === 'Size' && typeof v === 'number') {
        document.setContent(document.toString().slice(0, Math.max(0, Math.trunc(v))));
      }
    },
  });

  const headersValuesId = bridge.create('', {
    get: (k) => {
      if (typeof k === 'number') {
        const line = Object.entries(headers.snapshot())[k];
        return line === undefined ? '' : `${line[0]}=${line[1]}`;
      }
      if (typeof k === 'string') {
        return headers.get(k);
      }
      return undefined;
    },
    set: (k, v) => {
      if (typeof k === 'string') {
        headers.set(k, toStr(v));
      }
    },
  });
  const headersFacadeId = bridge.create('', {
    get: (k) => (typeof k === 'string' && k !== 'Values' ? headers.get(k) : undefined),
    set: (k, v) => {
      if (typeof k === 'string' && k !== 'Values') {
        headers.set(k, toStr(v));
      }
    },
    sub: (k) => (k === 'Values' ? headersValuesId : undefined),
  });

  const cookiesValuesId = bridge.create('', {
    get: (k) => {
      if (typeof k === 'number') {
        const line = cookies.entries()[k];
        return line === undefined ? '' : `${line[0]}=${line[1]}`;
      }
      if (typeof k === 'string') {
        return cookies.get(k);
      }
      return undefined;
    },
    set: (k, v) => {
      if (typeof k === 'string') {
        cookies.set(k, toStr(v));
      }
    },
  });
  const cookiesFacadeId = bridge.create('', {
    get: (k) => (typeof k === 'string' && k !== 'Values' ? cookies.get(k) : undefined),
    set: (k, v) => {
      if (typeof k === 'string' && k !== 'Values') {
        cookies.set(k, toStr(v));
      }
    },
    sub: (k) => (k === 'Values' ? cookiesValuesId : undefined),
  });

  const spec: FacadeSpec = {
    get(key) {
      if (typeof key !== 'string') {
        return undefined;
      }
      switch (key) {
        case 'Terminated':
          return abort.terminated || terminatedExternal;
        case 'ResultCode':
          return resultCode;
        case 'ResultString':
          return resultString;
        case 'LastURL':
          return lastURL;
        case 'UserAgent':
          return userAgent;
        case 'MimeType':
          return mimeType;
        case 'Timeout':
          return timeout;
        case 'RetryCount':
          return retryCount;
        case 'MaxRedirect':
          return maxRedirect;
        case 'EnabledCookies':
          return enabledCookies;
        case 'FollowRedirection':
          return followRedirection;
        case 'AllowServerErrorResponse':
          return allowServerErrorResponse;
        case 'Compress':
          return compress;
        default:
          break;
      }
      const method = methods[key];
      return method !== undefined ? method : undefined;
    },
    set(key, value) {
      switch (key) {
        case 'UserAgent':
          userAgent = toStr(value);
          return;
        case 'MimeType':
          mimeType = toStr(value);
          return;
        case 'Timeout':
          timeout = toInteger(value);
          return;
        case 'RetryCount':
          retryCount = toInteger(value);
          return;
        case 'MaxRedirect':
          maxRedirect = toInteger(value);
          return;
        case 'EnabledCookies':
          enabledCookies = toBool(value);
          return;
        case 'FollowRedirection':
          followRedirection = toBool(value);
          return;
        case 'AllowServerErrorResponse':
          allowServerErrorResponse = toBool(value);
          return;
        case 'Compress':
          compress = toBool(value);
          return;
        case 'Terminated':
          // modules cannot un-terminate; only the host abort governs
          if (toBool(value)) {
            terminatedExternal = true;
          }
          return;
        default:
          return; // read-only + unknown keys: silent no-op
      }
    },
    sub(key) {
      switch (key) {
        case 'Document':
          return documentFacadeId;
        case 'Headers':
          return headersFacadeId;
        case 'Cookies':
          return cookiesFacadeId;
        default:
          return undefined;
      }
    },
  };

  if (options.documents !== undefined) {
    options.documents.set(documentFacadeId, document);
  }

  return {
    spec,
    document,
    headers,
    cookies,
    lastMimeType: () => mimeType,
    lastResultCode: () => resultCode,
  };
}

/**
 * Shared per-module HTTP state (§5.3): one resolver (+ its request log)
 * reused across the request-scoped HTTP objects of a module run.
 */
export function createSharedHttpState(entries?: readonly RecordedResponse[]): RecordedResponseResolver {
  return new RecordedResponseResolver(entries ? [...entries] : []);
}
