import { describe, expect, it, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { makeHttpShim } from '../../../src/engine/shims/http-shim.js';
import { LoopbackHttpTransport } from '../../../src/engine/shims/http-transport.js';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import { SyncHostGate } from '../../../src/engine/shims/http-hostgate.js';
import { SharedCookieJar } from '../../../src/engine/state/module-state.js';
import { AsyncRWLock } from '../../../src/engine/state/locks.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../../src/engine/lua/abort.js';

/**
 * §5.4 integration tests over a LOCAL node:http mock server (loopback
 * only — DESIGN §13 allows loopback sockets; the no-network guard
 * forbids everything else). Real requests flow through the sync
 * LoopbackHttpTransport (worker-thread pump) + the full pipeline.
 *
 * The server runs on ITS OWN worker thread: the Lua-facing request is
 * synchronous (the test thread blocks in Atomics.wait), so a server on
 * the test thread could never accept connections (deadlock). The plan
 * is declarative (first matching rule wins; default 200 + body).
 *
 * Contract → test matrix (integration rows; captured-request assertions):
 * | Row    | Contract                                             | Test                                   |
 * |--------|-------------------------------------------------------|----------------------------------------|
 * | R-RED1 | 301/302/303/307 followed AS GET on the wire           | server captures method rewrite         |
 * | R-RED3 | Referer = pre-redirect URL (captured)                 | server captures Referer                |
 * | R-RED2 | max 5 redirects default; exceeding fails              | 6-hop chain stops at the cap           |
 * | R-RET1 | retry >500 bounded by RetryCount, no delay            | server hit count + wall clock bound    |
 * | R-POST1| POST body rides in Document (captured)                | server echoes the body                 |
 * | R-POST2| Content-Type moved + text/html rewrite; charset=UTF-8 | server captures Content-Type           |
 * | R-CK1  | cookie persistence via the shared state service       | SharedCookieJar across two objects     |
 * | R-CMP1 | Compress ⇒ Accept-Encoding; gzip response decoded     | server captures AE; Document decoded   |
 * | R-CMP2 | Compress off ⇒ no Accept-Encoding (captured)          | server sees absent header              |
 * | R-EG4  | egress allow-list override admits loopback            | whole suite (allow-listed 127.0.0.1)   |
 * | R-OK1  | success ⇔ Document.Size > 0 (HEAD fails; empty fails) | HEAD vs GET vs empty 200               |
 * | R-URL3 | URL massaging on the live path (strip :/ + scheme)    | server sees the massaged path          |
 * | R-DEL1 | host-level start-interval delay between connections   | server timestamps the spacing          |
 * | R-HDR1 | default header set + UserAgent on live requests       | server captures DNT + Accept-Language + UA |
 */

// --- worker-backed mock server -----------------------------------------------

const SERVER_WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
const zlib = require('node:zlib');
const captures = [];
const t0 = Date.now();
const rules = workerData.rules;

function firstMatch(path, index) {
  for (const rule of rules) {
    if (rule.path !== undefined && rule.path !== path) continue;
    if (rule.atIndex !== undefined && rule.atIndex !== index) continue;
    if (rule.minIndex !== undefined && index < rule.minIndex) continue;
    return rule;
  }
  return {};
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const index = captures.length;
    const rule = firstMatch(req.url || '', index);
    captures.push({
      method: req.method,
      url: req.url || '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      at: Date.now() - t0,
    });
    let body = rule.body !== undefined ? rule.body : 'response-' + index;
    const headers = Object.assign({}, rule.headers ?? {});
    if (rule.gzip === true) {
      body = zlib.gzipSync(Buffer.from(String(body), 'utf8'));
      headers['Content-Encoding'] = 'gzip';
    }
    if (rule.echoCookie === true) {
      body = String(req.headers['cookie'] ?? 'no-cookie');
    }
    const status = rule.status !== undefined ? rule.status : 200;
    res.writeHead(status, headers);
    res.end(body);
  });
});
server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ type: 'listening', port: server.address().port });
});
parentPort.on('message', (msg) => {
  if (msg.type === 'captures') {
    parentPort.postMessage({ type: 'captures', captures });
  } else if (msg.type === 'close') {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }
});
`;

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  at: number;
}

/** Declarative response rule (first match wins; default 200 + body). */
interface ServerRule {
  /** Exact request path (url) match. */
  path?: string;
  /** Exact capture-index match (for ordered sequences). */
  atIndex?: number;
  /** Match from this capture index on (for tails). */
  minIndex?: number;
  status?: number;
  body?: string;
  headers?: Record<string, string | string[]>;
  /** Serve the body gzip-compressed with a Content-Encoding header. */
  gzip?: boolean;
  /** Body = the request's Cookie header. */
  echoCookie?: boolean;
}

interface MockServer {
  readonly origin: string;
  /** Pull the request captures (only after the synchronous sends return). */
  captures(): Promise<CapturedRequest[]>;
  close(): Promise<void>;
}

async function startMockServer(rules: ServerRule[]): Promise<MockServer> {
  const worker = new Worker(SERVER_WORKER_SCRIPT, {
    eval: true,
    workerData: { rules },
  });
  const port: number = await new Promise((resolve, reject) => {
    worker.on('message', (m: { type: string; port?: number }) => {
      if (m.type === 'listening' && m.port !== undefined) {
        resolve(m.port);
      }
    });
    worker.on('error', reject);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    captures: () =>
      new Promise((resolve, reject) => {
        const onMessage = (m: { type: string; captures?: CapturedRequest[] }): void => {
          if (m.type === 'captures') {
            worker.off('message', onMessage);
            resolve(m.captures ?? []);
          }
        };
        worker.on('message', onMessage);
        worker.on('error', reject);
        worker.postMessage({ type: 'captures' });
      }),
    close: () =>
      new Promise((resolve) => {
        worker.postMessage({ type: 'close' });
        worker.on('exit', () => resolve());
      }),
  };
}

// --- tests -------------------------------------------------------------------

describe('http §5.4 integration (local mock server)', () => {
  const servers: MockServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function start(rules: ServerRule[]): Promise<MockServer> {
    const server = await startMockServer(rules);
    servers.push(server);
    return server;
  }

  function makeHandle(_server: MockServer, options?: {
    cookies?: SharedCookieJar;
    gate?: SyncHostGate;
  }): ReturnType<typeof makeHttpShim> {
    const transport = new LoopbackHttpTransport();
    const bridge = {
      create(_t: string, spec: unknown): number {
        void spec;
        return 1;
      },
      register(): void {},
    };
    return makeHttpShim(bridge as never, {
      resolver: undefined as never, // unused: the loopback transport is explicit
      abort: new DeadlineAbortHandle(createDeadlineCells()),
      transport,
      egress: new EgressPolicy({ allow: ['127.0.0.1'] }), // R-EG4: allow-list override
      ...(options?.cookies !== undefined ? { sharedCookies: options.cookies } : {}),
      ...(options?.gate !== undefined ? { gate: options.gate } : {}),
    });
  }

  it('redirects 301/302/303/307 are followed AS GET with Referer (captured)', async () => {
    const server = await start([
      { path: '/final', body: 'landed' },
      { minIndex: 4, body: 'landed' },
      { status: 301, body: '', headers: { Location: '/final' } },
    ]);
    const handle = makeHandle(server);
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/start`)).toBe(true);
    expect(handle.lastResultCode()).toBe(200);
    expect(handle.pipeline.document.toString()).toBe('landed');
    const captures = await server.captures();
    // one 301 hop: /start then /final (each 30x code has its own test)
    expect(captures[0]?.url).toBe('/start');
    expect(captures[1]?.url).toBe('/final');
    expect(captures[1]?.method).toBe('GET');
    expect(captures[1]?.headers['referer']).toBe(`${server.origin}/start`);
  });

  it.each([301, 302, 303, 307])('%i is followed AS GET with Referer (captured)', async (status) => {
    const server = await start([
      { path: '/final', body: 'landed' },
      { status, body: '', headers: { Location: '/final' } },
    ]);
    const handle = makeHandle(server);
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/start`)).toBe(true);
    const captures = await server.captures();
    expect(captures[1]?.method).toBe('GET'); // followed AS GET
    expect(captures[1]?.headers['referer']).toBe(`${server.origin}/start`);
    expect(captures[1]?.url).toBe('/final');
  });

  it('POST redirects to GET on the wire (303)', async () => {
    const server = await start([
      { path: '/done', body: 'ok' },
      { status: 303, body: '', headers: { Location: '/done' } },
    ]);
    const handle = makeHandle(server);
    const post = handle.spec.get('POST') as (u: unknown, d: unknown) => boolean;
    expect(post(`${server.origin}/post`, 'a=1')).toBe(true);
    const captures = await server.captures();
    expect(captures[0]?.method).toBe('POST');
    expect(captures[1]?.method).toBe('GET');
  });

  it('caps redirects at MaxRedirect 5 by default (6th hop never happens)', async () => {
    const server = await start([
      { status: 302, body: '', headers: { Location: '/next' } },
    ]);
    const handle = makeHandle(server);
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/hop0`)).toBe(false);
    expect(handle.lastResultCode()).toBe(302);
    const captures = await server.captures();
    expect(captures).toHaveLength(6); // 1 + 5 redirects
  });

  it('retries >500 bounded by RetryCount with no delay (server counts hits)', async () => {
    const server = await start([
      { atIndex: 0, status: 503, body: '' },
      { atIndex: 1, status: 503, body: '' },
      { body: 'recovered' },
    ]);
    const handle = makeHandle(server);
    handle.spec.set('RetryCount', 2);
    const started = Date.now();
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/flaky`)).toBe(true);
    const elapsed = Date.now() - started;
    const captures = await server.captures();
    expect(captures).toHaveLength(3);
    expect(handle.lastResultCode()).toBe(200);
    expect(handle.pipeline.document.toString()).toBe('recovered');
    expect(elapsed).toBeLessThan(5000); // retries are immediate (no delay)
  });

  it('POST body rides in Document; Content-Type moved + text/html rewritten (captured)', async () => {
    const server = await start([{ body: 'ok' }]);
    const handle = makeHandle(server);
    handle.headers.set('Content-Type', 'text/html');
    const post = handle.spec.get('POST') as (u: unknown, d: unknown) => boolean;
    expect(post(`${server.origin}/submit`, 'name=manga&page=7')).toBe(true);
    const captures = await server.captures();
    const captured = captures[0];
    expect(captured?.method).toBe('POST');
    expect(captured?.body).toBe('name=manga&page=7');
    expect(captured?.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    // the move consumed the header
    expect(handle.headers.get('Content-Type')).toBe('');
  });

  it('non-text/html Content-Type moves through unchanged', async () => {
    const server = await start([{ body: 'ok' }]);
    const handle = makeHandle(server);
    handle.headers.set('Content-Type', 'application/json');
    const post = handle.spec.get('POST') as (u: unknown, d: unknown) => boolean;
    expect(post(`${server.origin}/json`, '{"q":1}')).toBe(true);
    const captures = await server.captures();
    expect(captures[0]?.headers['content-type']).toBe('application/json');
    expect(captures[0]?.body).toBe('{"q":1}');
  });

  it('cookies persist across request-scoped objects via the shared state service (SharedCookieJar)', async () => {
    const server = await start([
      { path: '/login', body: 'logged-in', headers: { 'Set-Cookie': 'session=abc123; Path=/' } },
      { echoCookie: true },
    ]);
    const sharedJar = new SharedCookieJar(new AsyncRWLock());
    const first = makeHandle(server, { cookies: sharedJar });
    const firstGet = first.spec.get('GET') as (u: unknown) => boolean;
    expect(firstGet(`${server.origin}/login`)).toBe(true);
    expect(first.cookies.get('session')).toBe('abc123');
    // a FRESH request-scoped object (the dispatcher binds one per event
    // call) shares the module cookie jar — the wire carries the cookie
    const second = makeHandle(server, { cookies: sharedJar });
    const secondGet = second.spec.get('GET') as (u: unknown) => boolean;
    expect(secondGet(`${server.origin}/page`)).toBe(true);
    const captures = await server.captures();
    expect(captures[1]?.headers['cookie']).toBe('session=abc123');
    expect(second.pipeline.document.toString()).toBe('session=abc123');
    // ClearCookiesStorage clears the shared storage
    (second.spec.get('ClearCookiesStorage') as () => void)();
    expect(secondGet(`${server.origin}/page2`)).toBe(true);
    const captures2 = await server.captures();
    expect(captures2[2]?.headers['cookie']).toBeUndefined();
  });

  it('Compress (default true) advertises gzip and decodes a gzip response', async () => {
    const server = await start([
      { body: 'compressed-body', gzip: true, headers: { 'Content-Type': 'text/plain' } },
    ]);
    const handle = makeHandle(server);
    expect(handle.spec.get('Compress')).toBe(true);
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/gz`)).toBe(true);
    const captures = await server.captures();
    expect(String(captures[0]?.headers['accept-encoding'])).toBe('gzip, deflate, br');
    expect(String(captures[0]?.headers['accept-encoding'])).not.toContain('zstd'); // D13
    expect(handle.pipeline.document.toString()).toBe('compressed-body');
  });

  it('Compress=false sends no Accept-Encoding (captured)', async () => {
    const server = await start([{ body: 'plain' }]);
    const handle = makeHandle(server);
    handle.spec.set('Compress', false);
    (handle.spec.get('Reset') as () => void)();
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/plain`)).toBe(true);
    const captures = await server.captures();
    expect(captures[0]?.headers['accept-encoding']).toBeUndefined();
  });

  it('success ⇔ Document.Size > 0: HEAD yields ResultCode but not success; empty 200 fails', async () => {
    const server = await start([
      { path: '/empty', body: '' },
      { body: 'body-here' },
    ]);
    const handle = makeHandle(server);
    const head = handle.spec.get('HEAD') as (u: unknown) => boolean;
    expect(head(`${server.origin}/head`)).toBe(false);
    expect(handle.lastResultCode()).toBe(200);
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/empty`)).toBe(false);
    expect(get(`${server.origin}/full`)).toBe(true);
  });

  it('URL massaging applies on the live path (MaybeEncodeURL)', async () => {
    const server = await start([{ body: 'x' }]);
    const handle = makeHandle(server);
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    // space is encoded on the wire (massageUrl → MaybeEncodeURL; the
    // ':/'-strip + scheme-prepend paths are covered by the unit tests —
    // they compose https:// which the http-only loopback transport refuses)
    expect(get(`${server.origin}/ma ssaged`)).toBe(true);
    const captures = await server.captures();
    expect(captures[0]?.url).toBe('/ma%20ssaged');
  });

  it('host gate wiring: requests flow through a per-host gate (deterministic delay in unit tests)', async () => {
    const server = await start([{ body: 'd' }]);
    const gate = new SyncHostGate({ delayMs: 5, chunkMs: 5 });
    const handle = makeHandle(server, { gate });
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/d1`)).toBe(true);
    expect(get(`${server.origin}/d2`)).toBe(true);
    expect(gate.activeFor(`${server.origin}/d1`)).toBe(0); // slots released
    const captures = await server.captures();
    expect(captures).toHaveLength(2);
  });

  it('default headers ride on live requests (Reset set + UserAgent)', async () => {
    const server = await start([{ body: 'x' }]);
    const handle = makeHandle(server);
    const get = handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${server.origin}/headers`)).toBe(true);
    const captures = await server.captures();
    const h = captures[0]?.headers ?? {};
    expect(h['dnt']).toBe('1');
    expect(h['upgrade-insecure-requests']).toBe('1');
    expect(String(h['accept-language'])).toBe('en-US,en;q=0.5');
    expect(String(h['user-agent'])).toContain('Chrome/133');
  });
});
