import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { LoopbackHttpTransport, type RawHttpResult, type RawHttpRequest } from '../../../src/engine/shims/http-transport.js';
import { HttpPipeline } from '../../../src/engine/shims/http-pipeline.js';
import { CookieJar, CookieStore } from '../../../src/engine/shims/http-cookies.js';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import type { HttpTransportPort } from '../../../src/engine/shims/http-shim.js';

/**
 * Audit F-1 remediation tests (AUDIT-FINAL.md §6 F-1 / §5 A2b): a hostile
 * CRLF header value must fail THAT request immediately with a typed
 * error — never wedge the shared transport worker — and the worker must
 * recreate after a forced exit.
 *
 * Layers under test (all three required):
 * 1. wire boundary — host side (LoopbackHttpTransport.send) and pipeline
 *    (HttpPipeline.attempt) refuse CR/LF header names/values (and cookie
 *    jar entries feeding the Cookie header) BEFORE any byte is built;
 * 2. worker resilience — the pump's perform() body is try/catch-wrapped
 *    → writeResult(ok:false, reason) so a poisoned request fails itself;
 * 3. lifecycle — worker 'exit'/'error' handlers clear this.worker so the
 *    next send() recreates the transport.
 */

// --- worker-backed loopback mock server (send() blocks the test thread
// in Atomics.wait — a server ON the test thread could never accept) ----

interface CapturedRequest {
  readonly cookieHeader: string;
  readonly evilHeaderPresent: boolean;
}

const MOCK_SERVER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
const captures = [];
const server = http.createServer((req, res) => {
  captures.push({
    cookieHeader: req.headers['cookie'] === undefined ? '' : String(req.headers['cookie']),
    evilHeaderPresent: req.headers['evil'] !== undefined,
  });
  parentPort.postMessage({ captured: captures[captures.length - 1] });
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('pong');
});
server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ ready: true, port: server.address().port });
});
parentPort.on('message', (m) => {
  if (m === 'die') process.exit(1); // unclean worker death (lifecycle test)
});
`;

interface MockServer {
  readonly port: number;
  readonly worker: Worker;
  readonly captures: CapturedRequest[];
}

async function startMockServer(): Promise<MockServer> {
  const worker = new Worker(MOCK_SERVER_SCRIPT, { eval: true });
  const captures: CapturedRequest[] = [];
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 5000);
    worker.on('message', (m: { ready?: boolean; port?: number; captured?: CapturedRequest }) => {
      if (m.captured !== undefined) {
        captures.push(m.captured);
        return;
      }
      if (m.ready === true && typeof m.port === 'number') {
        clearTimeout(timer);
        resolve(m.port);
      }
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return { port, worker, captures };
}

/** Typed internals probe (no `any`): the lazily-created pump worker. */
interface TransportInternals {
  worker: Worker | null;
}

const OK_RESULT: RawHttpResult = {
  ok: true,
  error: '',
  status: 200,
  statusText: 'OK',
  headers: [],
  setCookie: [],
  body: Buffer.from('pong'),
};

describe('LoopbackHttpTransport CRLF boundary (audit F-1)', () => {
  const servers: MockServer[] = [];
  const transports: LoopbackHttpTransport[] = [];

  async function freshServer(): Promise<MockServer> {
    const server = await startMockServer();
    servers.push(server);
    return server;
  }

  function freshTransport(): LoopbackHttpTransport {
    const transport = new LoopbackHttpTransport({ allowedHosts: ['127.0.0.1'] });
    transports.push(transport);
    return transport;
  }

  afterAll(async () => {
    for (const transport of transports) {
      transport.dispose();
    }
    for (const server of servers) {
      await server.worker.terminate();
    }
  });

  it('auditor repro (A2b): poisoned CRLF Cookie header → immediate typed error, no injection, transport survives, next request succeeds', async () => {
    const server = await freshServer();
    const transport = freshTransport();

    const t0 = Date.now();
    const poisoned = transport.send({
      method: 'GET',
      url: `http://127.0.0.1:${server.port}/x`,
      headers: { Cookie: 'a=1\r\nEvil: injected' },
      body: '',
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - t0;

    // Immediate typed failure — NOT the pre-fix timeout/wedge.
    expect(poisoned.ok).toBe(false);
    expect(poisoned.status).toBe(0);
    expect(poisoned.error).toMatch(/CR\/LF.*wire boundary/);
    expect(elapsed).toBeLessThan(3000);

    // Nothing reached the wire (no header injection, no request at all).
    await new Promise((r) => setTimeout(r, 100));
    expect(server.captures).toHaveLength(0);

    // The shared transport stays healthy: the next request succeeds.
    const clean = transport.send({
      method: 'GET',
      url: `http://127.0.0.1:${server.port}/x`,
      headers: {},
      body: '',
      timeoutMs: 5000,
    });
    expect(clean.ok).toBe(true);
    expect(clean.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(server.captures).toHaveLength(1);
  });

  it('CRLF in a header NAME is refused at the same boundary', () => {
    const transport = freshTransport();
    const result = transport.send({
      method: 'GET',
      url: 'http://127.0.0.1:9/x',
      headers: { 'Bad\r\nName': 'v' },
      body: '',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/CR\/LF.*wire boundary/);
  });

  it('worker fault resilience: a request the boundary cannot pre-reject fails typed INSIDE the worker and the pump survives', async () => {
    const server = await freshServer();
    const transport = freshTransport();

    // An invalid header NAME token (space) passes the CR/LF scan but
    // makes node:http throw mid-perform — pre-fix this killed the worker
    // and wedged every later request; now it fails THAT request.
    const faulted = transport.send({
      method: 'GET',
      url: `http://127.0.0.1:${server.port}/x`,
      headers: { 'bad name': 'v' },
      body: '',
      timeoutMs: 5000,
    });
    expect(faulted.ok).toBe(false);
    expect(faulted.error).toMatch(/worker fault/);

    // The same transport still serves requests (worker alive or recreated).
    const clean = transport.send({
      method: 'GET',
      url: `http://127.0.0.1:${server.port}/x`,
      headers: {},
      body: '',
      timeoutMs: 5000,
    });
    expect(clean.ok).toBe(true);
    expect(clean.status).toBe(200);
  });

  it('lifecycle: the worker is recreated after a forced exit (worker ≠ null again, requests succeed)', async () => {
    const server = await freshServer();
    const transport = freshTransport();
    const internals = transport as unknown as TransportInternals;

    const first = transport.send({
      method: 'GET',
      url: `http://127.0.0.1:${server.port}/x`,
      headers: {},
      body: '',
      timeoutMs: 5000,
    });
    expect(first.ok).toBe(true);
    const originalWorker = internals.worker;
    expect(originalWorker).not.toBeNull();

    // Force the pump to die exactly the way an unhandled fault would.
    const exited = new Promise<void>((resolve) => {
      originalWorker?.once('exit', () => resolve());
    });
    originalWorker?.terminate();
    await exited;
    expect(internals.worker).toBeNull(); // 'exit' handler cleared the handle

    // The NEXT send recreates a fresh worker and succeeds.
    const second = transport.send({
      method: 'GET',
      url: `http://127.0.0.1:${server.port}/x`,
      headers: {},
      body: '',
      timeoutMs: 5000,
    });
    expect(second.ok).toBe(true);
    expect(second.status).toBe(200);
    expect(internals.worker).not.toBeNull();
    expect(internals.worker).not.toBe(originalWorker);
  });
});

describe('HttpPipeline CRLF wire boundary (audit F-1, layer 1)', () => {
  function makePipeline(): { pipeline: HttpPipeline; sent: RawHttpRequest[] } {
    const sent: RawHttpRequest[] = [];
    const spy: HttpTransportPort = {
      send: (request) => {
        sent.push(request);
        return OK_RESULT;
      },
    };
    const pipeline = new HttpPipeline({
      transport: spy,
      egress: new EgressPolicy({ allow: ['127.0.0.1'] }),
      cookies: new CookieStore(new CookieJar()),
      isTerminated: (): boolean => false,
    });
    return { pipeline, sent };
  }

  it('CRLF in a module-written header value → typed refusal BEFORE transport.send, hard stop (no retry)', () => {
    const { pipeline, sent } = makePipeline();
    pipeline.headers.set('X-Evil', 'a\r\nEvil: injected');
    pipeline.retryCount = 3; // must NOT burn retries on a poisoned request

    expect(pipeline.get('http://127.0.0.1:9/x')).toBe(false);
    expect(sent).toHaveLength(0);
    expect(pipeline.resultCode).toBe(0);
    expect(pipeline.resultString).toBe('header "X-Evil" contains CR/LF — refused at the wire boundary');
  });

  it('unlimited retries (RetryCount = -1) still stop immediately on a poisoned request', () => {
    const { pipeline, sent } = makePipeline();
    pipeline.headers.set('X-Evil', 'a\nb');
    pipeline.retryCount = -1;
    expect(pipeline.get('http://127.0.0.1:9/x')).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('CRLF in a cookie VALUE → the Cookie header is refused (raw jar storage untouched — FMD2 parity)', () => {
    const { pipeline, sent } = makePipeline();
    pipeline.cookies.set('x', '1\r\nSet-Cookie: evil=1');

    expect(pipeline.get('http://127.0.0.1:9/x')).toBe(false);
    expect(sent).toHaveLength(0);
    expect(pipeline.resultString).toBe('header "Cookie" contains CR/LF — refused at the wire boundary');
    // Storage keeps the raw value verbatim (the jar is FMD2-parity; the
    // wire boundary is what sanitizes).
    expect(pipeline.cookies.get('x')).toBe('1\r\nSet-Cookie: evil=1');
  });

  it('CRLF in a cookie NAME → refused the same way', () => {
    const { pipeline, sent } = makePipeline();
    pipeline.cookies.set('a\r\nb', '1');
    expect(pipeline.get('http://127.0.0.1:9/x')).toBe(false);
    expect(sent).toHaveLength(0);
    expect(pipeline.resultString).toContain('"Cookie"');
  });

  it('a clean request after poisoned ones goes out normally (cookie flows, header flows)', () => {
    const { pipeline, sent } = makePipeline();
    pipeline.cookies.set('sid', 'abc');
    pipeline.headers.set('X-OK', 'fine');

    expect(pipeline.get('http://127.0.0.1:9/x')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['Cookie']).toBe('sid=abc');
    expect(sent[0]?.headers['X-OK']).toBe('fine');
  });
});
