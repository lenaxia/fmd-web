import { Worker } from 'node:worker_threads';
import { firstCrlfIndex } from './http-headers.js';

/**
 * Transport port (DESIGN §5.4): one HTTP hop — no redirects, no
 * retries, no auto-decompression (the pipeline owns those, mirroring
 * `httpsendthread.pas`). The port is SYNCHRONOUS: the Lua facade calls
 * it from a blocked thread.
 *
 * Two implementations:
 * - {@link RecordedHttpTransport}: fixture-backed (RecordedResponseResolver)
 *   — the offline unit/e2e path (no sockets at all).
 * - {@link LoopbackHttpTransport}: real requests against a LOCAL
 *   node:http mock server, performed on a worker thread and awaited
 *   with `Atomics.wait` (the deadline-watchdog pattern). Loopback hosts
 *   are always allowed (DESIGN §13's hermetic test posture: no
 *   allow-list configured ⇒ loopback-only, exactly like the offline
 *   suite). The sanctioned egress extension is an EXPLICIT
 *   `allowedHosts` allow-list (FMD_HTTP_ALLOW_HOSTS): allow-listed
 *   hosts may be reached over http AND https (TLS-verified, SNI set,
 *   optional private trust roots via `ca`) — the operator's gate for
 *   live module traffic. `*` in the list opens egress to any host.
 *   Proxy hops (HTTP/SOCKS4(a)/SOCKS5) carry https via CONNECT /
 *   tunneled TLS.
 */

/**
 * Proxy hop descriptor riding the request (SetProxy parity, DESIGN §5.4
 * httpsendthread.pas:838-874): the transport worker routes the hop
 * through this proxy — HTTP → forward-proxy absolute-form request;
 * SOCKS4(a)/SOCKS5 → handshake + CONNECT tunnel, then the origin-form
 * request over the tunnel. Loopback-only hosts as always (DESIGN §13).
 */
export interface RawProxy {
  readonly type: 'HTTP' | 'SOCKS4' | 'SOCKS5';
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly pass: string;
}

export interface RawHttpRequest {
  method: string;
  /** Absolute URL (http://…). */
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
  /** Active proxy for THIS hop (absent = direct). */
  readonly proxy?: RawProxy;
}

export interface RawHttpResult {
  /** Transport-level success (a response was read; any status). */
  readonly ok: boolean;
  /** '' on success; the error message otherwise. */
  readonly error: string;
  readonly status: number;
  readonly statusText: string;
  /** Ordered response header pairs (original casing, duplicates kept). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** Set-Cookie header values in response order. */
  readonly setCookie: readonly string[];
  readonly body: Uint8Array;
}

/** One-hop transport port (synchronous). */
export interface HttpTransportPort {
  send(request: RawHttpRequest): RawHttpResult;
}

const TRANSPORT_ERROR = (
  error: string,
): RawHttpResult => ({
  ok: false,
  error,
  status: 0,
  statusText: '',
  headers: [],
  setCookie: [],
  body: new Uint8Array(0),
});

/**
 * Recorded-fixture transport: adapts the §5.4 v0
 * `RecordedResponseResolver` (kept verbatim — the e2e golden harness and
 * shim consumers depend on its public API) into the one-hop port.
 */
export interface RecordedEnvelope {
  readonly status: number;
  readonly statusText: string;
  /** Structural subset of undici's Headers the transport needs. */
  readonly headers: {
    forEach(callback: (value: string, key: string) => void): void;
    get(name: string): string | null;
    getSetCookie(): string[];
  };
  readonly body: string;
}

export class RecordedHttpTransport implements HttpTransportPort {
  constructor(
    private readonly resolve: (
      method: string,
      url: string,
      body: string,
      mimeType: string,
      headers: Readonly<Record<string, string>>,
    ) => RecordedEnvelope,
  ) {}

  send(request: RawHttpRequest): RawHttpResult {
    let resolved: RecordedEnvelope;
    try {
      resolved = this.resolve(
        request.method,
        request.url,
        request.body,
        request.headers['Content-Type'] ?? '',
        request.headers,
      );
    } catch (err) {
      return TRANSPORT_ERROR(err instanceof Error ? err.message : String(err));
    }
    const headers: Array<readonly [string, string]> = [];
    resolved.headers.forEach((value, key) => {
      headers.push([key, value] as const);
    });
    return {
      ok: true,
      error: '',
      status: resolved.status,
      statusText: resolved.statusText,
      headers,
      setCookie: resolved.headers.getSetCookie(),
      body: Buffer.from(resolved.body, 'utf8'),
    };
  }
}

// ---------------------------------------------------------------------------
// Loopback worker pump
// ---------------------------------------------------------------------------

const REQ_BUF_BYTES = 1 * 1024 * 1024;
const RES_BUF_BYTES = 16 * 1024 * 1024;
const WAIT_CHUNK_MS = 25;

const LOOPBACK_WORKER_SCRIPT = `
(async () => {
  // dynamic imports: valid in BOTH CJS and ESM eval contexts (eval
  // workers get ESM/CJS syntax-detected on some node entry paths)
  const { workerData } = await import('node:worker_threads');
  const http = await import('node:http');
  const https = await import('node:https');
  const net = await import('node:net');
  const tls = await import('node:tls');
  const control = new Int32Array(workerData.control);
  const reqBuf = new Uint8Array(workerData.reqBuf);
  const resBuf = new Uint8Array(workerData.resBuf);
  const allowedHosts = new Set(
    (workerData.allowedHosts || []).map((h) => String(h).toLowerCase()),
  );
  const allowAnyHost = allowedHosts.has('*');
  const tlsCa = (workerData.tlsCa || []).map((p) => String(p));
  const tlsVerify = workerData.tlsVerify !== false;
  let lastSeq = 0;

  function isLoopbackHost(h) {
    const s = String(h).toLowerCase();
    return (
      s === 'localhost' || s.endsWith('.localhost') ||
      s.startsWith('127.') || s === '::1' || s === '[::1]'
    );
  }

  function isAllowedHost(h) {
    return isLoopbackHost(h) || allowAnyHost || allowedHosts.has(String(h).toLowerCase());
  }

  function crlfIndex(s) {
    const cr = s.indexOf('\\r');
    const lf = s.indexOf('\\n');
    if (cr === -1) return lf;
    if (lf === -1) return cr;
    return Math.min(cr, lf);
  }

  function readReq() {
    const len =
      (reqBuf[0] | (reqBuf[1] << 8) | (reqBuf[2] << 16) | (reqBuf[3] << 24)) >>> 0;
    return JSON.parse(Buffer.from(reqBuf.buffer, 8, len).toString('utf8'));
  }

  function writeResult(seq, result) {
    if (Atomics.load(control, 0) !== seq) return; // abandoned request
    // Wire-level failures (TLS, DNS, connect, timeout) surface on the
    // process stderr → the app log: policy refusals stay quiet (expected
    // in hermetic runs), but silent net_problem diagnoses are worse than noise.
    if (result.ok === false && result.error !== '' &&
        !String(result.error).startsWith('loopback transport refuses') &&
        !String(result.error).includes('supports http/https only')) {
      console.error('[http-transport] ' + result.error);
    }
    let out = Buffer.from(JSON.stringify(result), 'utf8');
    if (out.length + 8 > resBuf.length) {
      out = Buffer.from(JSON.stringify({
        ok: false,
        error: 'response exceeds the loopback result buffer',
        status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '',
      }), 'utf8');
    }
    const len = out.length;
    resBuf[0] = len & 0xff;
    resBuf[1] = (len >> 8) & 0xff;
    resBuf[2] = (len >> 16) & 0xff;
    resBuf[3] = (len >> 24) & 0xff;
    new Uint8Array(resBuf.buffer, 8).set(out);
    Atomics.store(control, 1, seq);
    Atomics.notify(control, 1);
  }

  // ── proxy tunnel (SetProxy parity, httpsendthread.pas:838-874) ────────
  // HTTP  → forward-proxy absolute-form request line at the proxy.
  // SOCKS5 → greeting (+ RFC1929 user/pass subnegotiation) + CONNECT.
  // SOCKS4 → SOCKS4a CONNECT form (hostname + 0.0.0.1 placeholder IP).
  // The tunnel socket then carries the origin-form request; every phase
  // honors the request timeout.

  // Ordered sequential reader for the SOCKS handshake: replies may
  // arrive coalesced in one chunk, so leftover bytes must be retained
  // between reads.
  function makeReader(socket) {
    let buf = Buffer.alloc(0);
    const waiters = [];
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (waiters.length > 0 && buf.length >= waiters[0].n) {
        const w = waiters.shift();
        const out = buf.subarray(0, w.n);
        buf = buf.subarray(w.n);
        w.cb(out);
      }
    });
    return {
      read(n, cb) {
        if (buf.length >= n) {
          const out = buf.subarray(0, n);
          buf = buf.subarray(n);
          cb(out);
          return;
        }
        waiters.push({ n, cb });
      },
    };
  }

  function socksTunnel(proxy, host, port, timeoutMs) {
    return new Promise((resolveTunnel, rejectTunnel) => {
      let timer = null;
      const socket = net.connect({ host: proxy.host, port: Number(proxy.port) || 1080 });
      const fail = (what) => {
        if (timer !== null) clearTimeout(timer);
        socket.destroy();
        rejectTunnel(new Error(what));
      };
      const arm = (what) => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => fail('proxy timeout: ' + what), timeoutMs > 0 ? timeoutMs : 60000);
      };
      arm('connect');
      socket.on('error', (e) => fail('proxy connect failed: ' + String((e && e.message) || e)));
      socket.once('connect', () => {
        const reader = makeReader(socket);
        if (proxy.type === 'SOCKS5') {
          const wantAuth = proxy.user !== '';
          const methods = wantAuth ? Buffer.from([0x05, 2, 0x00, 0x02]) : Buffer.from([0x05, 1, 0x00]);
          arm('socks5 greeting');
          socket.write(methods);
          reader.read(2, (greet) => {
            if (greet[0] !== 0x05) return fail('socks5: bad greeting version');
            const method = greet[1];
            if (method === 0xff) return fail('socks5: no acceptable auth method');
            if (method === 0x00) { sendConnect5(); return; }
            if (method !== 0x02) return fail('socks5: unsupported auth method ' + method);
            if (!wantAuth) return fail('socks5: proxy demands auth but no credentials set');
            const user = Buffer.from(String(proxy.user), 'utf8');
            const pass = Buffer.from(String(proxy.pass), 'utf8');
            const auth = Buffer.concat([
              Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass,
            ]);
            arm('socks5 auth');
            socket.write(auth);
            reader.read(2, (authReply) => {
              if (authReply[0] !== 0x01 || authReply[1] !== 0x00) return fail('socks5: auth rejected');
              sendConnect5();
            });
          });
          function sendConnect5() {
            const hostBuf = Buffer.from(String(host), 'utf8');
            const req = Buffer.concat([
              Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
              hostBuf,
              Buffer.from([(port >> 8) & 0xff, port & 0xff]),
            ]);
            arm('socks5 connect');
            socket.write(req);
            reader.read(4, (head) => {
              if (head[0] !== 0x05) return fail('socks5: bad reply version');
              if (head[1] !== 0x00) return fail('socks5 CONNECT refused (code ' + head[1] + ')');
              const atyp = head[3];
              const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : null;
              if (addrLen !== null) {
                reader.read(addrLen + 2, () => {
                  if (timer !== null) clearTimeout(timer);
                  resolveTunnel(socket);
                });
                return;
              }
              // domain-bound reply: 1 length byte + name + 2 port bytes
              reader.read(1, (l) => {
                reader.read(l[0] + 2, () => {
                  if (timer !== null) clearTimeout(timer);
                  resolveTunnel(socket);
                });
              });
            });
          }
        } else {
          // SOCKS4 / SOCKS4a
          const userBuf = Buffer.from(String(proxy.user || ''), 'utf8');
          const hostBuf = Buffer.from(String(host), 'utf8');
          const req = Buffer.concat([
            Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, 0, 0, 0, 1]),
            userBuf, Buffer.from([0x00]),
            hostBuf, Buffer.from([0x00]),
          ]);
          arm(proxy.type === 'SOCKS4' ? 'socks4 connect' : 'socks4a connect');
          socket.write(req);
          reader.read(8, (reply) => {
            if (reply[1] !== 0x5a) return fail('socks4 CONNECT refused (code ' + reply[1] + ')');
            if (timer !== null) clearTimeout(timer);
            resolveTunnel(socket);
          });
        }
      });
    });
  }

  function perform(seq, req) {
    let u;
    try {
      u = new URL(req.url);
    } catch {
      writeResult(seq, { ok: false, error: 'bad URL', status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      writeResult(seq, { ok: false, error: 'transport supports http/https only: ' + u.protocol, status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
      return;
    }
    const secure = u.protocol === 'https:';
    const originPort = u.port === '' ? (secure ? 443 : 80) : Number(u.port);
    if (!isAllowedHost(u.hostname)) {
      writeResult(seq, { ok: false, error: 'loopback transport refuses non-loopback host: ' + u.hostname, status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
      return;
    }
    const proxy = req.proxy || null;
    if (proxy !== null && !isAllowedHost(proxy.host)) {
      writeResult(seq, { ok: false, error: 'loopback transport refuses non-loopback proxy host: ' + proxy.host, status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
      return;
    }
    const body = Buffer.from(req.bodyB64, 'base64');
    // Wire-boundary guard, worker side (audit F-1 defense in depth):
    // a CR/LF in a header name or value would split the request on the
    // wire; node:http would throw mid-flight and (pre-fix) wedge this
    // worker. Refuse the ONE request with a typed failure instead.
    for (const [k, v] of Object.entries(req.headers)) {
      if (crlfIndex(k) !== -1 || crlfIndex(v) !== -1) {
        writeResult(seq, { ok: false, error: 'header "' + k + '" contains CR/LF — refused at the wire boundary', status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
        return;
      }
    }
    // Hop-by-hop + transport-managed headers are stripped before
    // node:http validation (stale response headers re-sent by the FMD2
    // header-bleed quirk would otherwise be rejected with 400;
    // connection-scoped headers are transport-level, not application-level).
    const HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade',
      'proxy-connection', 'host', 'content-length', 'expect',
    ]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) {
        headers[k] = v;
      }
    }
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      writeResult(seq, result);
    };
    const transportFailure = (what) => ({
      ok: false,
      error: String((what && what.message) || what),
      status: 0,
      statusText: '',
      headers: [],
      setCookie: [],
      bodyB64: '',
    });
    const wrapTls = (socket, onSecure) => {
      const tlsSock = tls.connect({
        socket,
        servername: u.hostname,
        rejectUnauthorized: tlsVerify,
        ...(tlsCa.length > 0 ? { ca: tlsCa } : {}),
      });
      const handshakeTimer = setTimeout(
        () => tlsSock.destroy(new Error('tls handshake timeout')),
        req.timeoutMs > 0 ? req.timeoutMs : 30000,
      );
      tlsSock.on('secureConnect', () => {
        clearTimeout(handshakeTimer);
        onSecure(tlsSock);
      });
      tlsSock.on('error', (e) => {
        clearTimeout(handshakeTimer);
        // finish is idempotent (guarded by done): post-secureConnect
        // failures are owned by the http request's own error path.
        finish(transportFailure(e));
      });
      return tlsSock;
    };
    const issueRequest = (targetHost, targetPort, requestPath, requestHeaders, tunnel, secureHop) => {
      const lib = secureHop ? https : http;
      const upstream = lib.request(
        {
          host: targetHost,
          port: targetPort,
          path: requestPath,
          method: req.method,
          headers: requestHeaders,
          // fresh connection per request (synapse parity: httpsendthread
          // opens a new TCP/TLS session per HTTPMethod and never pools —
          // a reused keep-alive socket reset by an idle-timeout (CDN RST)
          // would surface as a transport failure FMD2 cannot have).
          // Tunneled hops keep createConnection (agent:false would
          // ignore the provided socket — node honors createConnection
          // only when no agent is set); the tunnel is per-request
          // already, so freshness holds there by construction.
          ...(tunnel ? { createConnection: () => tunnel } : { agent: false }),
          // direct https: node does the TLS here, so the trust roots and
          // the verify toggle must ride the request options (tunneled
          // https already has its TLS from wrapTls)
          ...(secureHop && tunnel === null ? {
            rejectUnauthorized: tlsVerify,
            ...(tlsCa.length > 0 ? { ca: tlsCa } : {}),
          } : {}),
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const pairs = [];
            const raw = res.rawHeaders;
            for (let i = 0; i + 1 < raw.length; i += 2) {
              pairs.push([raw[i], raw[i + 1]]);
            }
            const setCookie = res.headers['set-cookie'];
            finish({
              ok: true,
              error: '',
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: pairs,
              setCookie: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
              bodyB64: Buffer.concat(chunks).toString('base64'),
            });
          });
        },
      );
      upstream.setTimeout(req.timeoutMs > 0 ? req.timeoutMs : 0, () => {
        upstream.destroy(new Error('timeout'));
      });
      upstream.on('error', (e) => {
        finish({
          ok: false,
          error: String((e && e.message) || e),
          status: 0,
          statusText: '',
          headers: [],
          setCookie: [],
          bodyB64: '',
        });
      });
      if (body.length > 0) upstream.write(body);
      upstream.end();
    };

    if (proxy === null) {
      if (body.length > 0) headers['Content-Length'] = body.length;
      issueRequest(u.hostname, originPort, u.pathname + u.search, headers, null, secure);
      return;
    }
    const proxyPort = Number(proxy.port) || (proxy.type === 'HTTP' ? 8080 : 1080);
    if (proxy.type === 'HTTP') {
      if (!secure) {
        // forward proxy (plain http): absolute-form request line + Host
        // of the TARGET; Proxy-Authorization when credentials are
        // configured (:853-857)
        const pheaders = { ...headers, Host: u.host };
        if (body.length > 0) pheaders['Content-Length'] = body.length;
        if (proxy.user !== '') {
          pheaders['Proxy-Authorization'] = 'Basic ' +
            Buffer.from(proxy.user + ':' + proxy.pass, 'utf8').toString('base64');
        }
        issueRequest(proxy.host, proxyPort, req.url, pheaders, null, false);
        return;
      }
      // https through an HTTP forward proxy: CONNECT tunnel, then TLS
      // inside the tunnel, then the origin-form request over TLS.
      const connectHeaders = proxy.user !== ''
        ? { 'Proxy-Authorization': 'Basic ' +
            Buffer.from(proxy.user + ':' + proxy.pass, 'utf8').toString('base64') }
        : {};
      const connectReq = http.request({
        host: proxy.host,
        port: proxyPort,
        method: 'CONNECT',
        path: u.hostname + ':' + originPort,
        headers: connectHeaders,
        agent: false,
      });
      connectReq.setTimeout(req.timeoutMs > 0 ? req.timeoutMs : 0, () => {
        connectReq.destroy(new Error('timeout'));
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          finish(transportFailure('proxy CONNECT refused: ' + res.statusCode));
          return;
        }
        if (body.length > 0) headers['Content-Length'] = body.length;
        wrapTls(socket, (tlsSock) => {
          issueRequest(u.hostname, originPort, u.pathname + u.search, headers, tlsSock, true);
        });
      });
      connectReq.on('error', (e) => finish(transportFailure(e)));
      connectReq.end();
      return;
    }
    socksTunnel(proxy, u.hostname, originPort, req.timeoutMs)
      .then((tunnel) => {
        if (done) { tunnel.destroy(); return; }
        if (body.length > 0) headers['Content-Length'] = body.length;
        if (!secure) {
          issueRequest(u.hostname, originPort, u.pathname + u.search, headers, tunnel, false);
          return;
        }
        wrapTls(tunnel, (tlsSock) => {
          issueRequest(u.hostname, originPort, u.pathname + u.search, headers, tlsSock, true);
        });
      })
      .catch((e) => {
        finish(transportFailure(e));
      });
  }

  // Poll instead of blocking in Atomics.wait: a blocking wait would
  // starve this thread's own http.request callbacks (the deadline
  // watchdog can block because it does no async I/O — this worker does).
  // The interval stays referenced so the worker thread stays alive;
  // dispose() terminates it explicitly.
  // Worker resilience (audit F-1): a poisoned request must fail THAT
  // request with a typed result — an uncaught throw here would take the
  // worker down and permanently wedge every subsequent request.
  setInterval(() => {
    const seq = Atomics.load(control, 0);
    if (seq !== lastSeq) {
      lastSeq = seq;
      try {
        perform(seq, readReq());
      } catch (e) {
        writeResult(seq, { ok: false, error: 'loopback transport worker fault: ' + String((e && e.message) || e), status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
      }
    }
  }, 5);
})();
`;

function isLoopbackHost(host: string): boolean {
  const s = host.toLowerCase();
  return (
    s === 'localhost' ||
    s.endsWith('.localhost') ||
    s.startsWith('127.') ||
    s === '::1' ||
    s === '[::1]'
  );
}

export interface LoopbackTransportOptions {
  /** Hard cap for one send() on the caller side (ms, default 120000). */
  readonly maxWaitMs?: number;
  /**
   * Explicit allow-list of EXTRA (non-loopback) hostnames the transport
   * may open — live module egress (FMD_HTTP_ALLOW_HOSTS) plus compose
   * e2e mock containers. Empty/undefined (default): loopback hosts
   * only — the hermetic test posture. The entry `*` allows any host.
   * Host-side AND worker-side checks both enforce the same set.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Additional trust roots (PEM strings) for https connections —
   * private CA deployments and hermetic TLS tests. Default: the
   * system store.
   */
  readonly ca?: readonly string[];
  /**
   * TLS certificate verification toggle. Default true — verification
   * is a security boundary; `false` exists for hermetic self-signed
   * test servers only.
   */
  readonly tlsVerify?: boolean;
}

/**
 * Real socket requests (http and https), one worker thread per
 * transport (created lazily, `dispose()` terminates). Loopback hosts
 * are always allowed; non-loopback hosts require an explicit
 * `allowedHosts` entry (`FMD_HTTP_ALLOW_HOSTS`) — the worker
 * re-asserts the same set before opening any socket. https is
 * TLS-verified with SNI (trust roots extensible via `ca`); proxy
 * hops carry https via CONNECT / tunneled TLS.
 */
export class LoopbackHttpTransport implements HttpTransportPort {
  private readonly control: Int32Array;
  private readonly reqBuf: SharedArrayBuffer;
  private readonly resBuf: SharedArrayBuffer;
  private readonly allowedHosts: readonly string[];
  private readonly tlsCa: readonly string[];
  private readonly tlsVerify: boolean;
  private seq = 0;
  private worker: Worker | null = null;
  private readonly maxWaitMs: number;

  constructor(options: LoopbackTransportOptions = {}) {
    this.maxWaitMs = Math.max(1000, Math.trunc(options.maxWaitMs ?? 120000));
    this.allowedHosts = (options.allowedHosts ?? []).map((h) => h.toLowerCase());
    this.tlsCa = options.ca ?? [];
    this.tlsVerify = options.tlsVerify ?? true;
    const controlBuf = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    this.control = new Int32Array(controlBuf);
    this.reqBuf = new SharedArrayBuffer(REQ_BUF_BYTES);
    this.resBuf = new SharedArrayBuffer(RES_BUF_BYTES);
  }

  dispose(): void {
    if (this.worker !== null) {
      void this.worker.terminate();
      this.worker = null;
    }
  }

  private ensureWorker(): Worker {
    if (this.worker === null) {
      this.worker = new Worker(LOOPBACK_WORKER_SCRIPT, {
        eval: true,
        workerData: {
          control: this.control.buffer,
          reqBuf: this.reqBuf,
          resBuf: this.resBuf,
          allowedHosts: [...this.allowedHosts],
          tlsCa: [...this.tlsCa],
          tlsVerify: this.tlsVerify,
        },
      });
      // Lifecycle (audit F-1): a worker that dies (uncaught fault, OOM,
      // external termination) must be FORGOTTEN so the next send()
      // recreates a fresh transport — pre-fix this.worker stayed set and
      // every subsequent request burned maxWaitMs against a dead worker.
      // The 'error' handler also keeps an unhandled worker error from
      // propagating into the parent thread.
      const worker = this.worker;
      worker.on('exit', () => {
        if (this.worker === worker) {
          this.worker = null;
        }
      });
      worker.on('error', () => {
        if (this.worker === worker) {
          this.worker = null;
        }
      });
      // NOT unref'd: an unref'd worker's event loop may be starved while
      // the caller blocks in Atomics.wait; dispose() terminates it.
    }
    return this.worker;
  }

  send(request: RawHttpRequest): RawHttpResult {
    const urlHost = hostOfUrl(request.url);
    if (
      !isLoopbackHost(urlHost) &&
      !this.allowedHosts.includes('*') &&
      !this.allowedHosts.includes(urlHost.toLowerCase())
    ) {
      return TRANSPORT_ERROR(
        `loopback transport refuses non-loopback host: ${urlHost}`,
      );
    }
    // Wire-boundary guard, host side (audit F-1): module-controlled
    // header values keep FMD2-raw storage (the jar stores verbatim), but
    // a CR/LF reaching the wire would split the request line. Refuse the
    // ONE request with a typed error BEFORE the worker is touched — the
    // transport (and every other module's request) stays healthy.
    for (const [name, value] of Object.entries(request.headers)) {
      if (firstCrlfIndex(name) !== -1 || firstCrlfIndex(value) !== -1) {
        return TRANSPORT_ERROR(
          `header "${name}" contains CR/LF — refused at the wire boundary`,
        );
      }
    }
    const worker = this.ensureWorker();
    void worker;
    const payload = Buffer.from(
      JSON.stringify({
        method: request.method,
        url: request.url,
        headers: request.headers,
        bodyB64: Buffer.from(request.body, 'utf8').toString('base64'),
        timeoutMs: request.timeoutMs,
        ...(request.proxy !== undefined ? { proxy: request.proxy } : {}),
      }),
      'utf8',
    );
    if (payload.length + 8 > REQ_BUF_BYTES) {
      return TRANSPORT_ERROR('request exceeds the loopback request buffer');
    }
    const reqView = new Uint8Array(this.reqBuf);
    reqView[0] = payload.length & 0xff;
    reqView[1] = (payload.length >> 8) & 0xff;
    reqView[2] = (payload.length >> 16) & 0xff;
    reqView[3] = (payload.length >> 24) & 0xff;
    new Uint8Array(this.reqBuf, 8).set(payload);
    this.seq += 1;
    const seq = this.seq;
    Atomics.store(this.control, 0, seq);
    Atomics.notify(this.control, 0);

    const budgetMs = Math.min(request.timeoutMs > 0 ? request.timeoutMs : this.maxWaitMs, this.maxWaitMs);
    const deadline = Date.now() + budgetMs;
    let observed = Atomics.load(this.control, 1);
    while (Atomics.load(this.control, 1) !== seq) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Host-side deadline overrun: the worker never answered within
        // the caller's budget (silent origin, wedged socket). The
        // worker's writeResult logging never runs for this request, so
        // log here — symmetric with the wire-level diagnostics — or the
        // failure stays invisible in the app log (exactly the blind
        // spot of a Cloudflare slow-origin hold: the response lands
        // after the request timeout, and nothing explains the
        // net_problem).
        console.error(
          `[http-transport] timeout after ${String(budgetMs)}ms: ${request.method} ${request.url}`,
        );
        return TRANSPORT_ERROR('timeout');
      }
      Atomics.wait(this.control, 1, observed, Math.min(WAIT_CHUNK_MS, remaining));
      observed = Atomics.load(this.control, 1);
    }
    const resView = new DataView(this.resBuf);
    const len = resView.getUint32(0, true);
    if (len <= 0 || len + 8 > RES_BUF_BYTES) {
      return TRANSPORT_ERROR('malformed loopback result');
    }
    let parsed: {
      ok: boolean;
      error: string;
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      setCookie: string[];
      bodyB64: string;
    };
    try {
      parsed = JSON.parse(Buffer.from(this.resBuf, 8, len).toString('utf8'));
    } catch {
      return TRANSPORT_ERROR('malformed loopback result');
    }
    return {
      ok: parsed.ok,
      error: parsed.error,
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      setCookie: parsed.setCookie,
      body: Buffer.from(parsed.bodyB64, 'base64'),
    };
  }
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
