import { Headers, Response } from 'undici';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path';
import type { HttpAbortHandle } from '@fmd/contract';
import { toBool, toInteger, toStr } from '../lua/base-globals.js';
import type { FacadeBridge, FacadeSpec } from '../lua/facade.js';
import { NameValueMap } from './http-headers.js';
import { CookieJar, CookieStore, type CookieJarPort } from './http-cookies.js';
import { EgressPolicy } from './http-egress.js';
import { HttpPipeline, HttpDocument } from './http-pipeline.js';
import type { HostGatePort } from './http-hostgate.js';
import {  getProxy as proxyTupleFromConfig,
  normalizeProxyConfig,
  describeProxySelection,
  type ProxyConfig,
  type ProxySelection,
} from './http-proxy.js';
import {
  RecordedHttpTransport,
  type HttpTransportPort,
} from './http-transport.js';

/**
 * HTTP shim (DESIGN.md §5.4, semantics of `httpsendthread.pas`) — the
 * full §5.4 facade over {@link HttpPipeline}: every property, method
 * and sub-facade of `LuaHTTPSend.pas:91-198`, the Document stream
 * facade (ToString=ReadString, WriteString, jailed LoadFromFile/
 * SaveToFile, Clear, writable Size; POST bodies ride in it; success ⇔
 * Size > 0 :717), SetProxy with HTTP|SOCKS4|SOCKS5 agent selection
 * (:838-874), and the Terminated flag from the abort handle.
 *
 * Transport plugging: the default adapter wraps the
 * {@link RecordedResponseResolver} (offline fixtures — the e2e golden
 * path); integration tests pass a `LoopbackHttpTransport` against a
 * LOCAL node:http mock server. There is no live external network path
 * (DESIGN §13), and the egress policy denies private/link-local
 * targets by default.
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
  readonly method?: string;
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
 *
 * Matching modes: default is first-match-by-URL (golden replay); with
 * `{ consume: true }` each matching entry is served once in order
 * (retry/sequence tests) and the final matching entry repeats.
 */
export class RecordedResponseResolver {
  readonly requests: RecordedRequestRecord[] = [];
  private consumed = new Set<number>();

  constructor(
    private readonly entries: RecordedResponse[] = [],
    private readonly matchOptions: { readonly consume?: boolean } = {},
  ) {}

  add(entry: RecordedResponse): void {
    this.entries.push(entry);
  }

  /** Resolve one request to a recorded undici Response envelope. */
  resolve(method: string, url: string, body: string, mimeType: string, headers: Readonly<Record<string, string>>): ResolvedRecordedResponse {
    this.requests.push({ method, url, body, mimeType, headers });
    const match = (e: RecordedResponse): boolean =>
      e.url === url && (e.method === undefined || e.method === method);
    const matchAny = (e: RecordedResponse): boolean => e.url === url;
    let index = -1;
    if (this.matchOptions.consume === true) {
      index = this.entries.findIndex((e, i) => !this.consumed.has(i) && match(e));
      if (index === -1) {
        index = this.entries.findIndex((e, i) => !this.consumed.has(i) && matchAny(e));
      }
      if (index === -1) {
        // all matching entries consumed → repeat the last matching one
        for (let i = this.entries.length - 1; i >= 0; i--) {
          const candidate = this.entries[i];
          if (candidate !== undefined && matchAny(candidate)) {
            index = i;
            break;
          }
        }
      }
      if (index !== -1) {
        this.consumed.add(index);
      }
    } else {
      const entry = this.entries.find(match) ?? this.entries.find(matchAny);
      index = entry === undefined ? -1 : this.entries.indexOf(entry);
    }
    const entry = index === -1 ? undefined : this.entries[index];
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
    // Null-body statuses (204/304) reject in the Response constructor —
    // fall back to the header envelope directly for those.
    try {
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
    } catch {
      return {
        status: entry.status,
        statusText: entry.statusText ?? '',
        headers: responseHeaders,
        body: entry.status >= 200 && entry.status < 300 ? entry.body : '',
      };
    }
  }
}

export { CookieJar, CookieStore, HttpDocument };
export type {
  CookieJarPort,
  EgressPolicy,
  HostGatePort,
  HttpTransportPort,
  ProxyConfig,
  ProxySelection,
};

export interface HttpShimOptions {
  /** Fixture resolver for the default (recorded) transport. */
  readonly resolver: RecordedResponseResolver;
  readonly abort: HttpAbortHandle;
  /** When set, registers documentFacadeId → backing stream (ParseHTML). */
  readonly documents?: Map<number, HttpDocument>;
  /** Shared per-module cookie jar (§5.3 state service) — persistence across request-scoped objects. */
  readonly sharedCookies?: CookieJarPort;
  /** Per-host connection gate (limits + host-level delays). */
  readonly gate?: HostGatePort;
  /** Egress policy override (default: deny RFC1918/link-local). */
  readonly egress?: EgressPolicy;
  /** Transport override (default: recorded fixtures; loopback for integration tests). */
  readonly transport?: HttpTransportPort;
  /** Filesystem jail root for Document LoadFromFile/SaveToFile (§5.4). */
  readonly fsJail?: string;
}

export interface HttpShimHandle {
  readonly spec: FacadeSpec;
  readonly document: HttpDocument;
  readonly headers: NameValueMap;
  readonly cookies: CookieStore;
  readonly pipeline: HttpPipeline;
  /** MimeType after POST normalization (observable for tests). */
  lastMimeType(): string;
  /** The last response code (observable for tests). */
  lastResultCode(): number;
  /** `GetProxy` (httpsendthread.pas:876-902): the active config, five strings. */
  getProxy(): [string, string, string, string, string];
  /** Agent-selection descriptor (test surface for SetProxy). */
  proxySelection(): ProxySelection;
  /** `AcceptImage` (:919-922) — host-invoked by the download pipeline. */
  acceptImage(): void;
}

/**
 * Resolve a module-supplied path against the fs jail. Windows
 * backslashes normalize to '/'; paths escaping the jail are refused.
 */
export function resolveJailedPath(jailRoot: string, rawPath: string): string | undefined {
  const normalized = rawPath.replaceAll('\\', '/').trim();
  if (normalized === '') {
    return undefined;
  }
  const root = resolvePath(jailRoot);
  const candidate = isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(root, normalized);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return undefined; // jail escape
  }
  return candidate;
}

/**
 * Create a real-behavior offline HTTP facade (§5.4). The dispatcher
 * binds a fresh request-scoped object per event call (FMD2 LoadObject);
 * cookies persist through `options.sharedCookies` (§5.3).
 */
export function makeHttpShim(bridge: FacadeBridge, options: HttpShimOptions): HttpShimHandle {
  const { abort } = options;
  const cookies = new CookieStore(options.sharedCookies ?? new CookieJar());
  const egress = options.egress ?? new EgressPolicy({ allow: [] });
  const transport =
    options.transport ??
    new RecordedHttpTransport((m, u, b, mt, h) => options.resolver.resolve(m, u, b, mt, h));

  let terminatedExternal = false;
  const pipeline = new HttpPipeline({
    transport,
    egress,
    cookies,
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    isTerminated: () => abort.terminated || terminatedExternal,
  });
  const { document, headers } = pipeline;

  let proxyConfig: ProxyConfig = normalizeProxyConfig('', '', '', '', '');
  let proxySelection: ProxySelection = describeProxySelection(proxyConfig);

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    Request: (m: unknown, url: unknown) => pipeline.request(toStr(m), toStr(url)),
    GET: (url: unknown) => pipeline.get(toStr(url)),
    POST: (url: unknown, postDocument: unknown) =>
      pipeline.post(toStr(url), typeof postDocument === 'string' ? postDocument : toStr(postDocument ?? '')),
    HEAD: (url: unknown) => pipeline.head(toStr(url)),
    XHR: (url: unknown) => pipeline.xhr(toStr(url)),
    Reset: () => {
      pipeline.reset();
      return undefined;
    },
    ResetBasic: () => {
      pipeline.resetBasic();
      return undefined;
    },
    // ClearCookies clears the object jar; ClearCookiesStorage also
    // clears the shared storage (httpsendthread.pas:951-959) — with a
    // shared jar port both clear the same backing store.
    ClearCookies: () => {
      cookies.clear();
      return undefined;
    },
    ClearCookiesStorage: () => {
      cookies.clear();
      return undefined;
    },
    GetCookies: () => cookies.getCookieString(),
    ParseServerCookies: (s: unknown) => {
      // ParseHTTPCookies (:481-484): parses the CURRENT response Headers
      cookies.feedResponseHeaders(headers);
      void toStr(s);
      return undefined;
    },
    AddServerCookies: (s: unknown) => {
      cookies.addServerCookie(toStr(s));
      return undefined;
    },
    MergeCookies: (s: unknown) => {
      cookies.merge(toStr(s));
      return undefined;
    },
    RemoveCookie: (name: unknown) => {
      cookies.remove(toStr(name));
      return undefined;
    },
    SetProxy: (type: unknown, host: unknown, port: unknown, user: unknown, pass: unknown) => {
      proxyConfig = normalizeProxyConfig(toStr(type), toStr(host), toStr(port), toStr(user), toStr(pass));
      proxySelection = describeProxySelection(proxyConfig);
      return undefined;
    },
  };

  // --- sub facades --------------------------------------------------------

  const resolveJail = (p: string): string | undefined =>
    options.fsJail !== undefined ? resolveJailedPath(options.fsJail, p) : undefined;

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
      if (k === 'LoadFromFile') {
        return (p: unknown) => {
          const path = resolveJail(toStr(p));
          if (path === undefined) {
            return false; // jailed or no jail configured
          }
          try {
            document.setBytes(readFileSync(path));
            return true;
          } catch {
            return false;
          }
        };
      }
      if (k === 'SaveToFile') {
        return (p: unknown) => {
          const path = resolveJail(toStr(p));
          if (path === undefined) {
            return false; // jailed or no jail configured
          }
          try {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, document.bytes);
            return true;
          } catch {
            return false;
          }
        };
      }
      return undefined;
    },
    set: (k, v) => {
      // Size is writable in FMD2 (SetSize: truncate / zero-fill)
      if (k === 'Size' && typeof v === 'number') {
        document.size = v;
      }
    },
  });

  const headersValuesId = bridge.create('', {
    get: (k) => {
      if (typeof k === 'number') {
        const line = headers.entries()[k];
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
        return cookies.lineAt(k);
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
          return pipeline.resultCode;
        case 'ResultString':
          return pipeline.resultString;
        case 'LastURL':
          return pipeline.lastURL;
        case 'UserAgent':
          return pipeline.userAgent;
        case 'MimeType':
          return pipeline.mimeType;
        case 'Timeout':
          return pipeline.timeout;
        case 'RetryCount':
          return pipeline.retryCount;
        case 'MaxRedirect':
          return pipeline.maxRedirect;
        case 'EnabledCookies':
          return pipeline.enabledCookies;
        case 'FollowRedirection':
          return pipeline.followRedirection;
        case 'AllowServerErrorResponse':
          return pipeline.allowServerErrorResponse;
        case 'Compress':
          return pipeline.compress;
        default:
          break;
      }
      const method = methods[key];
      return method !== undefined ? method : undefined;
    },
    set(key, value) {
      switch (key) {
        case 'UserAgent':
          pipeline.userAgent = toStr(value);
          return;
        case 'MimeType':
          pipeline.mimeType = toStr(value);
          return;
        case 'Timeout':
          pipeline.timeout = toInteger(value);
          return;
        case 'RetryCount':
          pipeline.retryCount = toInteger(value);
          return;
        case 'MaxRedirect':
          pipeline.maxRedirect = toInteger(value);
          return;
        case 'EnabledCookies':
          pipeline.enabledCookies = toBool(value);
          return;
        case 'FollowRedirection':
          pipeline.followRedirection = toBool(value);
          return;
        case 'AllowServerErrorResponse':
          pipeline.allowServerErrorResponse = toBool(value);
          return;
        case 'Compress':
          pipeline.compress = toBool(value);
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
    pipeline,
    lastMimeType: () => pipeline.mimeType,
    lastResultCode: () => pipeline.resultCode,
    getProxy: () => proxyTupleFromConfig(proxyConfig),
    proxySelection: () => proxySelection,
    acceptImage: () => pipeline.acceptImage(),
  };
}

/**
 * Shared per-module HTTP state (§5.3): one resolver (+ its request log)
 * reused across the request-scoped HTTP objects of a module run.
 */
export function createSharedHttpState(entries?: readonly RecordedResponse[]): RecordedResponseResolver {
  return new RecordedResponseResolver(entries ? [...entries] : []);
}
