import { Worker } from 'node:worker_threads';

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
 *   only — the transport refuses and never opens non-loopback sockets,
 *   keeping DESIGN §13's zero-network guarantee.
 */

export interface RawHttpRequest {
  method: string;
  /** Absolute URL (http://…). */
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
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
  const control = new Int32Array(workerData.control);
  const reqBuf = new Uint8Array(workerData.reqBuf);
  const resBuf = new Uint8Array(workerData.resBuf);
  let lastSeq = 0;

  function isLoopbackHost(h) {
    const s = String(h).toLowerCase();
    return (
      s === 'localhost' || s.endsWith('.localhost') ||
      s.startsWith('127.') || s === '::1' || s === '[::1]'
    );
  }

  function readReq() {
    const len =
      (reqBuf[0] | (reqBuf[1] << 8) | (reqBuf[2] << 16) | (reqBuf[3] << 24)) >>> 0;
    return JSON.parse(Buffer.from(reqBuf.buffer, 8, len).toString('utf8'));
  }

  function writeResult(seq, result) {
    if (Atomics.load(control, 0) !== seq) return; // abandoned request
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

  function perform(seq, req) {
    let u;
    try {
      u = new URL(req.url);
    } catch {
      writeResult(seq, { ok: false, error: 'bad URL', status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
      return;
    }
    if (u.protocol !== 'http:') {
      writeResult(seq, { ok: false, error: 'loopback transport is http-only', status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
      return;
    }
    if (!isLoopbackHost(u.hostname)) {
      writeResult(seq, { ok: false, error: 'loopback transport refuses non-loopback host: ' + u.hostname, status: 0, statusText: '', headers: [], setCookie: [], bodyB64: '' });
      return;
    }
    const body = Buffer.from(req.bodyB64, 'base64');
    // Hop-by-hop + transport-managed headers are stripped before
    // node:http validation (stale response headers re-sent by the FMD2
    // header-bleed quirk would otherwise be rejected with 400;
    // connection-scoped headers are transport-level, not application-level).
    const HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade',
      'proxy-connection', 'host', 'content-length', 'expect',
    ]);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) {
        headers[k] = v;
      }
    }
    if (body.length > 0) headers['Content-Length'] = body.length;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      writeResult(seq, result);
    };
    const upstream = http.request(
      {
        host: u.hostname,
        port: u.port === '' ? 80 : Number(u.port),
        path: u.pathname + u.search,
        method: req.method,
        headers,
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
  }

  // Poll instead of blocking in Atomics.wait: a blocking wait would
  // starve this thread's own http.request callbacks (the deadline
  // watchdog can block because it does no async I/O — this worker does).
  // The interval stays referenced so the worker thread stays alive;
  // dispose() terminates it explicitly.
  setInterval(() => {
    const seq = Atomics.load(control, 0);
    if (seq !== lastSeq) {
      lastSeq = seq;
      perform(seq, readReq());
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
}

/**
 * Real requests against a LOCAL node:http server, one worker thread
 * per transport (created lazily, `dispose()` terminates). Loopback
 * hosts only; the worker re-asserts that before opening any socket.
 */
export class LoopbackHttpTransport implements HttpTransportPort {
  private readonly control: Int32Array;
  private readonly reqBuf: SharedArrayBuffer;
  private readonly resBuf: SharedArrayBuffer;
  private seq = 0;
  private worker: Worker | null = null;
  private readonly maxWaitMs: number;

  constructor(options: LoopbackTransportOptions = {}) {
    this.maxWaitMs = Math.max(1000, Math.trunc(options.maxWaitMs ?? 120000));
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
        },
      });
      // NOT unref'd: an unref'd worker's event loop may be starved while
      // the caller blocks in Atomics.wait; dispose() terminates it.
    }
    return this.worker;
  }

  send(request: RawHttpRequest): RawHttpResult {
    const urlHost = hostOfUrl(request.url);
    if (!isLoopbackHost(urlHost)) {
      return TRANSPORT_ERROR(
        `loopback transport refuses non-loopback host: ${urlHost}`,
      );
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

    const deadline = Date.now() + Math.min(request.timeoutMs > 0 ? request.timeoutMs : this.maxWaitMs, this.maxWaitMs);
    let observed = Atomics.load(this.control, 1);
    while (Atomics.load(this.control, 1) !== seq) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
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
