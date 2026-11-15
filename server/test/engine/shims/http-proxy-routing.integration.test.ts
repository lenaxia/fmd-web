import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../../src/engine/lua/abort.js';
import { makeHttpShim } from '../../../src/engine/shims/http-shim.js';
import { LoopbackHttpTransport } from '../../../src/engine/shims/http-transport.js';

/**
 * §5.4 SetProxy END-TO-END routing (DESIGN §5.4, httpsendthread.pas:
 * 838-874; acceptance: "HTTP + SOCKS5 routing proven against local mock
 * proxies, request egress asserted at the proxy"): real TCP through
 * LOCAL mock proxies hosted in a worker_threads harness (the caller
 * thread blocks in Atomics.wait inside LoopbackHttpTransport.send — the
 * mocks MUST live on another thread to answer, exactly like the direct
 * mock-server harness above). Recorded per mock:
 *
 * - HTTP forward proxy: the ABSOLUTE-form request line + the
 *   Proxy-Authorization header (basic credentials, :853-857).
 * - SOCKS5: the negotiated auth method, the RFC 1929 user/pass
 *   subnegotiation and the CONNECT (DOMAINNAME) target.
 * - SOCKS4(a): the user id and the CONNECT hostname/port.
 * - origin: every request the proxies forwarded (path + Host).
 *
 * The origin only ever sees proxy-forwarded traffic, so an origin hit
 * IS the egress proof (the request left through the proxy, nowhere
 * else).
 */

interface OriginRecord {
  readonly path: string;
  readonly host: string;
  readonly method: string;
}

interface HttpProxyRecord {
  readonly method: string;
  readonly url: string;
  readonly proxyAuth: string | undefined;
  readonly hostHeader: string | undefined;
}

interface SocksRecord {
  readonly kind: 'socks5' | 'socks4';
  readonly authMethod: number;
  readonly user: string | undefined;
  readonly passOk: boolean | undefined;
  readonly targetHost: string;
  readonly targetPort: number;
}

interface ProxyHarness {
  origin: string;
  httpProxyPort: number;
  socks5Port: number;
  socks5AuthPort: number;
  socks4Port: number;
  stallPort: number;
  records(): Promise<{
    origin: OriginRecord[];
    httpProxy: HttpProxyRecord[];
    socks5: SocksRecord[];
    socks5Auth: SocksRecord[];
    socks4: SocksRecord[];
  }>;
  close(): Promise<void>;
}

// The harness worker hosts EVERY mock on loopback. SOCKS5 (two modes:
// open + require-auth), SOCKS4(a), the forward HTTP proxy, a stalling
// proxy (accepts, never answers) and the origin.
const HARNESS_SCRIPT = `
(async () => {
  const { parentPort, workerData } = await import('node:worker_threads');
  const http = await import('node:http');
  const net = await import('node:net');
  const USER = 'alice';
  const PASS = 's3cret';

  const originRecords = [];
  const httpProxyRecords = [];
  const socks5Records = [];
  const socks5AuthRecords = [];
  const socks4Records = [];

  function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  }

  function pipeTunnel(client, host, port) {
    const target = net.connect({ host, port }, () => {
      client.pipe(target);
      target.pipe(client);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
    client.on('close', () => target.destroy());
  }

  function readN(socket, n, cb, onFail) {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) {
        socket.removeListener('data', onData);
        cb(buf.subarray(0, n));
      }
    };
    socket.on('data', onData);
    socket.on('error', (e) => { socket.removeListener('data', onData); if (onFail) onFail(e); });
  }

  // ── origin ────────────────────────────────────────────────────────────
  const origin = http.createServer((req, res) => {
    originRecords.push({ path: req.url, host: String(req.headers.host || ''), method: req.method });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('origin-ok');
  });

  // ── forward HTTP proxy (absolute-form request line) ───────────────────
  const httpProxy = http.createServer((req, res) => {
    httpProxyRecords.push({
      method: req.method,
      url: req.url,
      proxyAuth: req.headers['proxy-authorization'] || undefined,
      hostHeader: req.headers.host || undefined,
    });
    const target = new URL(req.url);
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port === '' ? 80 : Number(target.port),
        path: target.pathname + target.search,
        method: req.method,
        headers: Object.assign({}, req.headers, { host: target.host }),
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('proxy upstream error');
    });
    req.pipe(upstream);
  });

  // ── stalling proxy (accepts, never answers) ───────────────────────────
  const staller = http.createServer(() => undefined);

  // ── SOCKS5 (RFC 1928 + 1929) ──────────────────────────────────────────
  function startSocks5(records, requireAuth) {
    return net.createServer((client) => {
      let stage = 'greet';
      let buffer = Buffer.alloc(0);
      client.on('data', (chunk) => {
        if (stage === 'tunnel') return;
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 'greet' && buffer.length >= 2) {
          const nmethods = buffer[1];
          if (buffer.length < 2 + nmethods) return;
          const methods = Array.from(buffer.subarray(2, 2 + nmethods));
          buffer = buffer.subarray(2 + nmethods);
          const wantAuth = requireAuth && methods.includes(0x02);
          const method = wantAuth ? 0x02 : 0x00;
          records.push({ kind: 'socks5', authMethod: method, user: undefined, passOk: !requireAuth || undefined, targetHost: '', targetPort: 0 });
          client.write(Buffer.from([0x05, method]));
          stage = wantAuth ? 'auth' : 'connect';
          return;
        }
        if (stage === 'auth' && buffer.length >= 2) {
          const ulen = buffer[1];
          if (buffer.length < 2 + ulen + 1) return;
          const plen = buffer[2 + ulen];
          if (buffer.length < 3 + ulen + plen) return;
          const user = buffer.subarray(2, 2 + ulen).toString('utf8');
          const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
          const ok = user === USER && pass === PASS;
          const rec = records[records.length - 1];
          if (rec) { rec.user = user; rec.passOk = ok; }
          client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          buffer = buffer.subarray(3 + ulen + plen);
          if (!ok) { client.end(); stage = 'tunnel'; return; }
          stage = 'connect';
          return;
        }
        if (stage === 'connect' && buffer.length >= 5) {
          const atyp = buffer[3];
          if (atyp !== 0x03) return;
          const hlen = buffer[4];
          if (buffer.length < 5 + hlen + 2) return;
          const host = buffer.subarray(5, 5 + hlen).toString('utf8');
          const port = buffer[5 + hlen] * 256 + buffer[5 + hlen + 1];
          const rec = records[records.length - 1];
          if (rec) { rec.targetHost = host; rec.targetPort = port; }
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 'tunnel';
          pipeTunnel(client, host, port);
        }
      });
      client.on('error', () => client.destroy());
    });
  }

  // ── SOCKS4(a) ──────────────────────────────────────────────────────────
  const socks4 = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    client.on('data', (chunk) => {
      if (socks4Records.length > 0) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 8) return;
      const port = buffer[2] * 256 + buffer[3];
      const useridEnd = buffer.indexOf(0x00, 8);
      if (useridEnd === -1) return;
      const user = buffer.subarray(8, useridEnd).toString('utf8');
      const is4a = buffer[4] === 0 && buffer[5] === 0 && buffer[6] === 0 && buffer[7] === 1;
      if (!is4a) return;
      const hostEnd = buffer.indexOf(0x00, useridEnd + 1);
      if (hostEnd === -1) return;
      const host = buffer.subarray(useridEnd + 1, hostEnd).toString('utf8');
      socks4Records.push({ kind: 'socks4', authMethod: -1, user, passOk: true, targetHost: host, targetPort: port });
      client.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
      pipeTunnel(client, host, port);
    });
    client.on('error', () => client.destroy());
  });

  const ports = {};
  ports.origin = await listen(origin);
  ports.httpProxy = await listen(httpProxy);
  ports.stall = await listen(staller);
  ports.socks5 = await listen(startSocks5(socks5Records, false));
  ports.socks5Auth = await listen(startSocks5(socks5AuthRecords, true));
  ports.socks4 = await listen(socks4);

  parentPort.postMessage({ type: 'ready', ports });

  parentPort.on('message', (msg) => {
    if (msg.type === 'records') {
      parentPort.postMessage({
        type: 'records',
        origin: originRecords,
        httpProxy: httpProxyRecords,
        socks5: socks5Records,
        socks5Auth: socks5AuthRecords,
        socks4: socks4Records,
      });
      return;
    }
    if (msg.type === 'close') {
      origin.close();
      httpProxy.close();
      staller.close();
      socks4.close();
      parentPort.postMessage({ type: 'closed' });
    }
  });
  void workerData;
})();
`;

let harness: ProxyHarness | undefined;

async function startHarness(): Promise<ProxyHarness> {
  const worker = new Worker(HARNESS_SCRIPT, { eval: true });
  const ports = await new Promise<Record<string, number>>((resolve, reject) => {
    worker.on('message', (msg: { type: string; ports?: Record<string, number> }) => {
      if (msg.type === 'ready' && msg.ports !== undefined) {
        resolve(msg.ports);
      }
    });
    worker.on('error', reject);
  });
  const records = (): Promise<{
    origin: OriginRecord[];
    httpProxy: HttpProxyRecord[];
    socks5: SocksRecord[];
    socks5Auth: SocksRecord[];
    socks4: SocksRecord[];
  }> =>
    new Promise((resolve, reject) => {
      const onMessage = (msg: { type: string } & Record<string, unknown>): void => {
        if (msg.type === 'records') {
          worker.off('message', onMessage);
          resolve(msg as unknown as {
            origin: OriginRecord[];
            httpProxy: HttpProxyRecord[];
            socks5: SocksRecord[];
            socks5Auth: SocksRecord[];
            socks4: SocksRecord[];
          });
        }
      };
      worker.on('message', onMessage);
      worker.on('error', reject);
      worker.postMessage({ type: 'records' });
    });
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      worker.on('exit', () => resolve());
      worker.postMessage({ type: 'close' });
      void worker.terminate();
    });
  const p = ports as unknown as {
    origin: number;
    httpProxy: number;
    socks5: number;
    socks5Auth: number;
    socks4: number;
    stall: number;
  };
  void p;
  return {
    origin: `http://127.0.0.1:${p.origin}`,
    httpProxyPort: p.httpProxy,
    socks5Port: p.socks5,
    socks5AuthPort: p.socks5Auth,
    socks4Port: p.socks4,
    stallPort: p.stall,
    records,
    close,
  };
}

interface ShimParts {
  handle: ReturnType<typeof makeHttpShim>;
  transport: LoopbackHttpTransport;
}

function makeShim(initialProxy?: { type: string; host: string; port: string; user: string; pass: string }): ShimParts {
  const transport = new LoopbackHttpTransport();
  const bridge = {
    create(_t: string, _spec: unknown): number {
      return 1;
    },
    register(): void {},
  };
  const handle = makeHttpShim(bridge as never, {
    resolver: undefined as never,
    abort: new DeadlineAbortHandle(createDeadlineCells()),
    transport,
    egress: new EgressPolicy({ allow: ['127.0.0.1'] }),
    ...(initialProxy !== undefined ? { initialProxy } : {}),
  });
  return { handle, transport };
}

const transports: LoopbackHttpTransport[] = [];

describe('SetProxy end-to-end routing through local mock proxies', () => {
  afterAll(async () => {
    for (const t of transports.splice(0)) {
      t.dispose();
    }
    await harness?.close();
    harness = undefined;
  });

  it('HTTP proxy: the request egresses at the proxy (absolute-form line + Proxy-Authorization) and the origin answers through it', async () => {
    const h = harness ?? (harness = await startHarness());
    const shim = makeShim();
    transports.push(shim.transport);
    const setProxy = shim.handle.spec.get('SetProxy') as (...a: unknown[]) => void;
    setProxy('HTTP', '127.0.0.1', String(h.httpProxyPort), 'u', 'pw');
    const get = shim.handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${h.origin}/via-http-proxy`)).toBe(true);
    expect(shim.handle.lastResultCode()).toBe(200);
    expect(shim.handle.pipeline.document.toString()).toBe('origin-ok');

    const r = await h.records();
    // egress asserted AT THE PROXY: absolute-form URI + basic auth
    expect(r.httpProxy).toHaveLength(1);
    expect(r.httpProxy[0]?.method).toBe('GET');
    expect(r.httpProxy[0]?.url).toBe(`${h.origin}/via-http-proxy`);
    expect(r.httpProxy[0]?.proxyAuth).toBe(`Basic ${Buffer.from('u:pw', 'utf8').toString('base64')}`);
    expect(r.httpProxy[0]?.hostHeader).toBe(new URL(h.origin).host);
    // the origin ONLY saw the proxy-forwarded request (origin-form)
    expect(r.origin).toHaveLength(1);
    expect(r.origin[0]?.path).toBe('/via-http-proxy');
    expect(r.origin[0]?.host).toBe(new URL(h.origin).host);
  });

  it('initialProxy (settings default) routes without a module SetProxy call — SetNoProxy clears it', async () => {
    const h = harness ?? (harness = await startHarness());
    const first = makeShim({ type: 'HTTP', host: '127.0.0.1', port: String(h.httpProxyPort), user: '', pass: '' });
    transports.push(first.transport);
    expect(first.handle.getProxy()).toEqual(['HTTP', '127.0.0.1', String(h.httpProxyPort), '', '']);
    const get = first.handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${h.origin}/initial`)).toBe(true);
    expect(first.handle.pipeline.document.toString()).toBe('origin-ok');
    let r = await h.records();
    expect(r.httpProxy[r.httpProxy.length - 1]?.proxyAuth).toBeUndefined();
    const httpProxyCount = r.httpProxy.length;

    // a module SetProxy call REPLACES the settings default (SetNoProxy)
    const second = makeShim({ type: 'HTTP', host: '127.0.0.1', port: String(h.httpProxyPort), user: '', pass: '' });
    transports.push(second.transport);
    const setProxy = second.handle.spec.get('SetProxy') as (...a: unknown[]) => void;
    setProxy('', '', '', '', '');
    const get2 = second.handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get2(`${h.origin}/direct`)).toBe(true);
    r = await h.records();
    expect(r.httpProxy).toHaveLength(httpProxyCount); // the cleared-config hop bypassed the proxy
    const originCount = r.origin.length;
    expect(r.origin.slice(-2).map((x) => x.path)).toEqual(['/initial', '/direct']);
    void originCount;
  });

  it('SOCKS5 without auth: CONNECT target recorded at the proxy; origin answers through the tunnel', async () => {
    const h = harness ?? (harness = await startHarness());
    const shim = makeShim();
    transports.push(shim.transport);
    const setProxy = shim.handle.spec.get('SetProxy') as (...a: unknown[]) => void;
    setProxy('SOCKS5', '127.0.0.1', String(h.socks5Port), '', '');
    const get = shim.handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${h.origin}/via-socks5`)).toBe(true);
    expect(shim.handle.lastResultCode()).toBe(200);
    expect(shim.handle.pipeline.document.toString()).toBe('origin-ok');

    const r = await h.records();
    expect(r.socks5[r.socks5.length - 1]?.authMethod).toBe(0x00);
    expect(r.socks5[r.socks5.length - 1]?.targetHost).toBe('127.0.0.1');
    expect(r.socks5[r.socks5.length - 1]?.targetPort).toBe(Number(new URL(h.origin).port));
    expect(r.origin.at(-1)?.path).toBe('/via-socks5');
  });

  it('SOCKS5 with auth: wrong credentials fail the handshake; correct credentials route and are recorded', async () => {
    const h = harness ?? (harness = await startHarness());
    const bad = makeShim();
    transports.push(bad.transport);
    const setProxy = bad.handle.spec.get('SetProxy') as (...a: unknown[]) => void;
    setProxy('SOCKS5', '127.0.0.1', String(h.socks5AuthPort), 'alice', 'wrong');
    const getBad = bad.handle.spec.get('GET') as (u: unknown) => boolean;
    expect(getBad(`${h.origin}/denied`)).toBe(false);
    expect(bad.handle.lastResultCode()).toBe(500); // synapse failure path keeps 500

    const good = makeShim();
    transports.push(good.transport);
    const setProxyGood = good.handle.spec.get('SetProxy') as (...a: unknown[]) => void;
    setProxyGood('SOCKS5', '127.0.0.1', String(h.socks5AuthPort), 'alice', 's3cret');
    const getGood = good.handle.spec.get('GET') as (u: unknown) => boolean;
    expect(getGood(`${h.origin}/allowed`)).toBe(true);
    expect(good.handle.pipeline.document.toString()).toBe('origin-ok');

    const r = await h.records();
    const auth = r.socks5Auth.slice(-2);
    expect(auth).toHaveLength(2);
    expect(auth[0]?.user).toBe('alice');
    expect(auth[0]?.passOk).toBe(false);
    expect(auth[1]?.user).toBe('alice');
    expect(auth[1]?.passOk).toBe(true);
    expect(auth[1]?.targetHost).toBe('127.0.0.1');
    // nothing from the failed handshake reached the origin
    expect(r.origin.filter((x) => x.path === '/denied')).toHaveLength(0);
  });

  it('SOCKS4(a): CONNECT hostname + user id recorded at the proxy; origin answers through the tunnel', async () => {
    const h = harness ?? (harness = await startHarness());
    const shim = makeShim();
    transports.push(shim.transport);
    const setProxy = shim.handle.spec.get('SetProxy') as (...a: unknown[]) => void;
    setProxy('SOCKS4', '127.0.0.1', String(h.socks4Port), 'carol', '');
    const get = shim.handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${h.origin}/via-socks4`)).toBe(true);
    expect(shim.handle.pipeline.document.toString()).toBe('origin-ok');

    const r = await h.records();
    expect(r.socks4.at(-1)?.user).toBe('carol');
    expect(r.socks4.at(-1)?.targetHost).toBe('127.0.0.1');
    expect(r.socks4.at(-1)?.targetPort).toBe(Number(new URL(h.origin).port));
  });

  it('non-loopback proxy host is refused before any socket opens', async () => {
    const h = harness ?? (harness = await startHarness());
    const shim = makeShim();
    transports.push(shim.transport);
    const setProxy = shim.handle.spec.get('SetProxy') as (...a: unknown[]) => void;
    setProxy('SOCKS5', 'proxy.example.com', '1080', '', '');
    const get = shim.handle.spec.get('GET') as (u: unknown) => boolean;
    expect(get(`${h.origin}/blocked`)).toBe(false);
    const r = await h.records();
    expect(r.origin.filter((x) => x.path === '/blocked')).toHaveLength(0);
  });

  it('a stalling HTTP proxy trips the request timeout (Timeout property)', async () => {
    const h = harness ?? (harness = await startHarness());
    const shim = makeShim();
    transports.push(shim.transport);
    const setProxy = shim.handle.spec.get('SetProxy') as (...a: unknown[]) => void;
    setProxy('HTTP', '127.0.0.1', String(h.stallPort), '', '');
    shim.handle.pipeline.timeout = 600;
    const get = shim.handle.spec.get('GET') as (u: unknown) => boolean;
    const started = Date.now();
    expect(get(`${h.origin}/stall`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(shim.handle.lastResultCode()).toBe(500);
    const r = await h.records();
    expect(r.origin.filter((x) => x.path === '/stall')).toHaveLength(0);
  });
});
