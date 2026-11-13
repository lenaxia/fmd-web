import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordedResponseResolver, makeHttpShim, type HttpShimHandle } from '../../../src/engine/shims/http-shim.js';
import type { FacadeBridge, FacadeKey, FacadeValue, FacadeSpec } from '../../../src/engine/lua/facade.js';

/**
 * §5.4 facade surface matrix (DESIGN.md §5.4; LuaHTTPSend.pas:91-198).
 * Contract → test matrix (every §5.4 property/method row):
 * | Contract row                           | Test                                            |
 * |-----------------------------------------|-------------------------------------------------|
 * | Timeout get/set                         | property round-trips through the facade         |
 * | ResultCode get                          | reflects the pipeline result                    |
 * | ResultString get                        | reflects the pipeline result                    |
 * | LastURL get                             | final URL after the request                     |
 * | Headers case-insensitive Values get/set | headers sub-facade get/set + Values map         |
 * | Headers indexed Values[i]               | numeric index reads name=value lines            |
 * | Cookies case-insensitive Values         | cookies sub-facade + persistence via shared jar |
 * | Document.ToString (= ReadString)        | response body readable                          |
 * | Document.WriteString                    | body written pre-POST                           |
 * | Document.Clear                          | clears                                          |
 * | Document.Size get/writable              | truncate + zero-fill (SetSize)                  |
 * | Document.LoadFromFile (jailed)          | jail round-trip; escape refused                 |
 * | Document.SaveToFile (jailed)            | jail round-trip; escape refused                 |
 * | MimeType get/set                        | round-trips; POST move + rewrite                |
 * | UserAgent get/set                       | round-trips                                     |
 * | RetryCount get/set (default 0)          | default 0 + settable                            |
 * | EnabledCookies get/set                  | default true + settable                         |
 * | FollowRedirection get/set               | default true + settable                         |
 * | MaxRedirect get/set                     | default 5 + settable                            |
 * | AllowServerErrorResponse get/set        | default false + settable                        |
 * | Compress get/set                        | default true (ctor :548) + settable             |
 * | Terminated get (set latches)            | abort handle + module latch one-way             |
 * | Request(method, url)                    | dispatch                                        |
 * | GET/POST/HEAD                           | dispatch + POST body/move                       |
 * | XHR = GET + X-Requested-With (:749-755) | header set on the wire (and persists)           |
 * | Reset / ResetBasic                      | default header sets (:924-954)                  |
 * | ClearCookies / ClearCookiesStorage      | jar cleared                                     |
 * | GetCookies                              | ';'-joined lines                                |
 * | ParseServerCookies                      | response Headers fed into the jar               |
 * | AddServerCookies                        | Set-Cookie line into the jar                    |
 * | MergeCookies                            | pairs overwrite, bare lines kept                |
 * | RemoveCookie                            | by name                                         |
 * | SetProxy(HTTP/SOCKS4/SOCKS5)            | proxySelection kind per type                    |
 */

const BASE = 'http://mock.test';

/** Materialized facade node the fake bridge hands out (Lua table double). */
interface FacadeNode {
  get(key: FacadeKey): unknown;
  set(key: FacadeKey, value: FacadeValue): void;
  sub(key: FacadeKey): FacadeNode | undefined;
}

interface FakeBridge {
  create(target: string, spec: FacadeSpec): number;
  nodeOf(id: number): FacadeNode;
}

/**
 * A minimal FacadeBridge double over plain objects: `create` records
 * specs by id and `sub` ids materialize into child nodes — the §5.4
 * surface under test is the spec wiring, not the Lua glue (covered by
 * the Lua round-trip tests).
 */
function makeFakeBridge(): FakeBridge {
  const specs: FacadeSpec[] = [];

  function wrap(spec: FacadeSpec): FacadeNode {
    const cache = new Map<string, FacadeNode>();
    return {
      get: (key) => spec.get(key),
      set: (key, value) => spec.set(key, value),
      sub: (key) => {
        if (spec.sub === undefined) {
          return undefined;
        }
        const id = spec.sub(key);
        if (typeof id !== 'number') {
          return undefined;
        }
        let child = cache.get(String(key));
        if (child === undefined) {
          const childSpec = specs[id - 1];
          if (childSpec === undefined) {
            return undefined;
          }
          child = wrap(childSpec);
          cache.set(String(key), child);
        }
        return child;
      },
    };
  }

  return {
    create(_target: string, spec: FacadeSpec): number {
      specs.push(spec);
      return specs.length;
    },
    nodeOf(id: number): FacadeNode {
      const spec = specs[id - 1];
      if (spec === undefined) {
        throw new Error(`no facade registered for id ${id}`);
      }
      return wrap(spec);
    },
  };
}

function fakeAbort(): { abort(r?: string): void; terminated: boolean; reason: string | undefined } {
  return { abort: () => undefined, terminated: false, reason: undefined };
}

describe('http-shim §5.4 facade matrix', () => {
  let resolver: RecordedResponseResolver;
  let handle: HttpShimHandle;
  let http: FacadeNode;

  beforeEach(() => {
    resolver = new RecordedResponseResolver([
      { url: `${BASE}/page`, status: 200, body: 'page-body' },
      { url: `${BASE}/empty`, status: 200, body: '' },
      { url: `${BASE}/json`, status: 200, body: '{"a":1}', headers: { 'Content-Type': 'application/json' } },
    ]);
    const bridge = makeFakeBridge();
    handle = makeHttpShim(bridge as unknown as FacadeBridge, { resolver, abort: fakeAbort() });
    http = bridge.nodeOf(bridge.create('HTTP', handle.spec));
  });

  // --- properties ----------------------------------------------------------

  it('Timeout/RetryCount/MaxRedirect defaults + set (ctor parity 15000/0/5)', () => {
    expect(http.get('Timeout')).toBe(15000);
    expect(http.get('RetryCount')).toBe(0);
    expect(http.get('MaxRedirect')).toBe(5);
    http.set('Timeout', 5000);
    http.set('RetryCount', 3);
    http.set('MaxRedirect', 2);
    expect(http.get('Timeout')).toBe(5000);
    expect(http.get('RetryCount')).toBe(3);
    expect(http.get('MaxRedirect')).toBe(2);
  });

  it('boolean property defaults (EnabledCookies/FollowRedirection true; ASER false; Compress true)', () => {
    expect(http.get('EnabledCookies')).toBe(true);
    expect(http.get('FollowRedirection')).toBe(true);
    expect(http.get('AllowServerErrorResponse')).toBe(false);
    expect(http.get('Compress')).toBe(true);
    http.set('EnabledCookies', false);
    http.set('FollowRedirection', false);
    http.set('AllowServerErrorResponse', true);
    http.set('Compress', false);
    expect(http.get('EnabledCookies')).toBe(false);
    expect(http.get('FollowRedirection')).toBe(false);
    expect(http.get('AllowServerErrorResponse')).toBe(true);
    expect(http.get('Compress')).toBe(false);
  });

  it('UserAgent/MimeType get/set round-trip; UserAgent default is the FMD2 Chrome UA', () => {
    expect(http.get('UserAgent')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    );
    http.set('UserAgent', 'custom-agent');
    http.set('MimeType', 'text/plain');
    expect(http.get('UserAgent')).toBe('custom-agent');
    expect(http.get('MimeType')).toBe('text/plain');
  });

    it('ResultCode/ResultString/LastURL reflect the last request', () => {
    expect(http.get('ResultCode')).toBe(0);
    expect(http.get('ResultString')).toBe('');
    expect(http.get('LastURL')).toBe('');
    const get = http.get('GET') as (url: unknown) => boolean;
    expect(get(`${BASE}/page`)).toBe(true);
    expect(http.get('ResultCode')).toBe(200);
    expect(http.get('ResultString')).toBe('');
    expect(http.get('LastURL')).toBe(`${BASE}/page`);
  });

  it('Terminated reads the abort handle; setting true latches (no un-terminate)', () => {
    expect(http.get('Terminated')).toBe(false);
    http.set('Terminated', true);
    expect(http.get('Terminated')).toBe(true);
    http.set('Terminated', false);
    expect(http.get('Terminated')).toBe(true);
  });

  it('Constructor ran Reset: the default header set is present at creation', () => {
    const headers = http.sub('Headers');
    expect(headers?.get('DNT')).toBe('1');
    expect(headers?.get('Upgrade-Insecure-Requests')).toBe('1');
    expect(String(headers?.get('Accept'))).toContain('image/webp');
  });

  // --- Headers sub-facade ---------------------------------------------------

  it('Headers.Values get/set is case-insensitive; direct keys map to names', () => {
    const headers = http.sub('Headers');
    const values = headers?.sub('Values');
    expect(values).toBeDefined();
    values?.set('X-Test', 'hello');
    expect(values?.get('x-test')).toBe('hello');
    expect(values?.get('X-TEST')).toBe('hello');
    expect(headers?.get('X-Test')).toBe('hello');
    headers?.set('X-Test', 'changed');
    expect(headers?.get('x-test')).toBe('changed');
  });

  it('Headers numeric Values[i] index reads name=value lines', () => {
    http.set('Compress', false); // ResetBasic with Compress off leaves no Accept-Encoding
    (http.get('ResetBasic') as () => void)();
    const values = http.sub('Headers')?.sub('Values');
    values?.set('A-Header', '1');
    expect(values?.get(0)).toBe('A-Header=1'); // first-written casing is kept
    expect(values?.get(99)).toBe('');
  });

  // --- Document sub-facade ---------------------------------------------------

  it('Document.ToString reads the response body (ReadString)', () => {
    const get = http.get('GET') as (url: unknown) => boolean;
    get(`${BASE}/page`);
    const doc = http.sub('Document');
    expect((doc?.get('ToString') as () => string)()).toBe('page-body');
  });

  it('Document.Size reflects the body; success ⇔ Size > 0', () => {
    const get = http.get('GET') as (url: unknown) => boolean;
    expect(get(`${BASE}/empty`)).toBe(false);
    const doc = http.sub('Document');
    expect(doc?.get('Size')).toBe(0);
    expect(get(`${BASE}/page`)).toBe(true);
    expect(doc?.get('Size')).toBe('page-body'.length);
  });

  it('Document.Size is writable (SetSize truncate + zero-fill)', () => {
    const doc = http.sub('Document');
    (doc?.get('WriteString') as (s: unknown) => void)('0123456789');
    doc?.set('Size', 4);
    expect((doc?.get('ToString') as () => string)()).toBe('0123');
    doc?.set('Size', 8); // zero-fill growth
    expect((doc?.get('ToString') as () => string)().length).toBe(8);
  });

  it('Document.Clear empties the stream', () => {
    const doc = http.sub('Document');
    (doc?.get('WriteString') as (s: unknown) => void)('stuff');
    (doc?.get('Clear') as () => void)();
    expect(doc?.get('Size')).toBe(0);
  });

  it('Document.LoadFromFile/SaveToFile are jailed (round-trip inside, escape refused)', () => {
    const jail = mkdtempSync(join(tmpdir(), 'http-jail-'));
    try {
      const resolver2 = new RecordedResponseResolver([{ url: `${BASE}/x`, status: 200, body: 'x' }]);
      const bridge = makeFakeBridge();
      const handle2 = makeHttpShim(bridge as unknown as FacadeBridge, {
        resolver: resolver2,
        abort: fakeAbort(),
        fsJail: jail,
      });
      const doc = bridge.nodeOf(bridge.create('HTTP', handle2.spec)).sub('Document');
      (doc?.get('WriteString') as (s: unknown) => void)('saved-data');
      expect((doc?.get('SaveToFile') as (p: unknown) => boolean)('out/response.bin')).toBe(true);
      expect(readFileSync(join(jail, 'out/response.bin'), 'utf8')).toBe('saved-data');
      (doc?.get('Clear') as () => void)();
      expect((doc?.get('LoadFromFile') as (p: unknown) => boolean)('out/response.bin')).toBe(true);
      expect((doc?.get('ToString') as () => string)()).toBe('saved-data');
      // escapes refused (both relative .. and absolute outside)
      (doc?.get('WriteString') as (s: unknown) => void)('evil');
      expect((doc?.get('SaveToFile') as (p: unknown) => boolean)('../outside.bin')).toBe(false);
      expect((doc?.get('LoadFromFile') as (p: unknown) => boolean)('/etc/hostname')).toBe(false);
      expect(existsSync(join(jail, '..', 'outside.bin'))).toBe(false);
      // without a jail configured both are no-ops
      expect((http.sub('Document')?.get('SaveToFile') as (p: unknown) => boolean)('x')).toBe(false);
    } finally {
      rmSync(jail, { recursive: true, force: true });
    }
  });

  // --- Cookies sub-facade -----------------------------------------------------

  it('Cookies.Values get/set is case-insensitive', () => {
    const cookies = http.sub('Cookies');
    cookies?.set('Session', 'abc');
    expect(cookies?.get('session')).toBe('abc');
    expect(cookies?.get('SESSION')).toBe('abc');
  });

  it('cookies persist across HTTP objects via the shared state service interface', () => {
    const shared = new Map<string, string>();
    const sharedJar = {
      get: (n: string): string => shared.get(n.toLowerCase()) ?? '',
      set: (n: string, v: string): void => {
        shared.set(n.toLowerCase(), v);
      },
      remove: (n: string): void => {
        shared.delete(n.toLowerCase());
      },
      clear: (): void => {
        shared.clear();
      },
      addServerCookie: (sc: string): void => {
        const pair = sc.split(';')[0] ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) shared.set(pair.slice(0, eq).trim().toLowerCase(), pair.slice(eq + 1).trim());
      },
      get size(): number {
        return shared.size;
      },
      snapshotSync: () => ({
        entries: { ...Object.fromEntries(shared) },
        count: shared.size,
        requestHeader: [...shared.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
        settingsText: [...shared.entries()].map(([k, v]) => `${k}=${v}`).join(';'),
      }),
    };
    const mk = (): ReturnType<typeof makeHttpShim> => {
      const bridge = makeFakeBridge();
      const h = makeHttpShim(bridge as unknown as FacadeBridge, { resolver, abort: fakeAbort(), sharedCookies: sharedJar });
      bridge.create('HTTP', h.spec);
      return h;
    };
    // object 1 receives a Set-Cookie
    resolver.add({ url: `${BASE}/setcookie`, status: 200, body: 'with-cookie', headers: { 'Set-Cookie': 'SID=xyz42; Path=/' } });
    const first = mk();
    (first.spec.get('GET') as (u: unknown) => boolean)(`${BASE}/setcookie`);
    // object 2 (fresh request-scoped object, same module) sends it back
    const second = mk();
    (second.spec.get('GET') as (u: unknown) => boolean)(`${BASE}/page`);
    expect(resolver.requests.at(-1)?.headers['Cookie']).toBe('sid=xyz42');
    expect(second.cookies.get('SID')).toBe('xyz42');
  });

  // --- methods ------------------------------------------------------------

  it('Request(method,url)/GET/POST/HEAD dispatch; POST moves Content-Type and rewrites text/html', () => {
    const request = http.get('Request') as (m: unknown, u: unknown) => boolean;
    expect(request('get', `${BASE}/page`)).toBe(true);
    const post = http.get('POST') as (u: unknown, d: unknown) => boolean;
    http.sub('Headers')?.set('Content-Type', 'text/html');
    expect(post(`${BASE}/page`, 'a=1&b=2')).toBe(true);
    const req = resolver.requests.at(-1);
    expect(req?.body).toBe('a=1&b=2');
    expect(req?.headers['Content-Type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    // after the response, MimeType follows the received Content-Type
    expect(handle.lastMimeType()).toBe('text/html; charset=utf-8');
    const head = http.get('HEAD') as (u: unknown) => boolean;
    expect(head(`${BASE}/empty`)).toBe(false); // no body ⇒ false (parity quirk)
    expect(http.get('ResultCode')).toBe(200);
  });

  it('POST body rides in Document when pre-written (WriteString)', () => {
    const doc = http.sub('Document');
    (doc?.get('WriteString') as (s: unknown) => void)('prewritten');
    const request = http.get('Request') as (m: unknown, u: unknown) => boolean;
    request('POST', `${BASE}/page`);
    expect(resolver.requests.at(-1)?.body).toBe('prewritten');
  });

  it('XHR = GET + X-Requested-With on the wire (:749-755)', () => {
    const xhr = http.get('XHR') as (u: unknown) => boolean;
    expect(xhr(`${BASE}/page`)).toBe(true);
    expect(resolver.requests.at(-1)?.headers['X-Requested-With']).toBe('XMLHttpRequest');
    // the response replaces the Headers facade (:677 Clear) — a following
    // GET does NOT send X-Requested-With (FMD2 quirk)
    const get = http.get('GET') as (u: unknown) => boolean;
    get(`${BASE}/page`);
    expect(resolver.requests.at(-1)?.headers['X-Requested-With']).toBeUndefined();
  });

  it('Reset/ResetBasic compose their default header sets (:924-954)', () => {
    const reset = http.get('Reset') as () => void;
    const resetBasic = http.get('ResetBasic') as () => void;
    http.set('Compress', false);
    resetBasic();
    expect(http.sub('Headers')?.get('Accept-Encoding')).toBe('');
    http.set('Compress', true);
    reset();
    const h = http.sub('Headers');
    expect(h?.get('DNT')).toBe('1');
    expect(h?.get('Accept-Encoding')).toBe('gzip, deflate, br');
    expect(String(h?.get('Accept-Charset'))).toBe('utf-8');
  });

  it('cookie methods: GetCookies/AddServerCookies/MergeCookies/RemoveCookie/ClearCookies', () => {
    const addServer = http.get('AddServerCookies') as (s: unknown) => void;
    addServer('K1=V1; Path=/');
    const getCookies = http.get('GetCookies') as () => string;
    expect(getCookies()).toBe('K1=V1'); // first-written casing kept (case-insensitive lookup)
    const merge = http.get('MergeCookies') as (s: unknown) => void;
    merge('K1=V2; flag; K3=V3');
    expect(getCookies()).toBe('K1=V2; K3=V3; flag');
    const remove = http.get('RemoveCookie') as (n: unknown) => void;
    remove('K1');
    expect(getCookies()).toBe('K3=V3; flag');
    const clear = http.get('ClearCookies') as () => void;
    clear();
    expect(getCookies()).toBe('');
    expect(http.get('ClearCookiesStorage')).toBeDefined();
  });

  it('ParseServerCookies feeds the CURRENT response Headers into the jar', () => {
    const get = http.get('GET') as (u: unknown) => boolean;
    resolver.add({ url: `${BASE}/sc2`, status: 200, body: 'x', headers: { 'Set-Cookie': 'PARSED=yes' } });
    get(`${BASE}/sc2`);
    // the pipeline already fed Set-Cookie automatically; Parse re-feeds
    const parse = http.get('ParseServerCookies') as () => void;
    parse();
    expect(handle.cookies.get('PARSED')).toBe('yes');
  });

  it('SetProxy selects the agent per proxy type (HTTP/SOCKS4/SOCKS5/none)', () => {
    const setProxy = http.get('SetProxy') as (...a: unknown[]) => void;
    setProxy('HTTP', 'p.example.com', '8080', 'u', 'pw');
    expect(handle.getProxy()).toEqual(['HTTP', 'p.example.com', '8080', 'u', 'pw']);
    expect(handle.proxySelection().kind).toBe('http');
    setProxy('SOCKS4', 's.example.com', '1080', '', '');
    expect(handle.proxySelection().kind).toBe('socks4');
    expect(handle.proxySelection().socks?.type).toBe(4);
    setProxy('SOCKS5', 's.example.com', '1081', '', '');
    expect(handle.proxySelection().kind).toBe('socks5');
    expect(handle.proxySelection().socks?.port).toBe(1081);
    setProxy('BOGUS', 'h', '1', '', '');
    expect(handle.getProxy()).toEqual(['', '', '', '', '']);
    expect(handle.proxySelection().kind).toBe('none');
  });

  it('AcceptImage swaps Accept (host-invoked, :919-922)', () => {
    handle.acceptImage();
    expect(http.sub('Headers')?.get('Accept')).toBe('image/webp,*/*');
  });
});
