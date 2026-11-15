import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BYPASS_DEFAULT_TIMEOUT_MS,
  BYPASS_MAX_CONCURRENCY,
  BypassTimeoutError,
  BypassUnavailableError,
  BypassUpstreamError,
  FlareSolverrBypassExecutor,
  extractUrl,
} from '../../../src/engine/sidecar/bypass-adapter.js';
import {
  makeSubprocessShim,
  type SubprocessShim,
} from '../../../src/engine/sidecar/subprocess-stub.js';
import type { BypassExecutorPort } from '../../../src/engine/sidecar/bypass-adapter.js';

/**
 * BypassExecutor sidecar adapter CONTRACT tests (DESIGN §5.11, D2;
 * acceptance: "vs a MOCK flaresolverr: bounded concurrency 2, timeout
 * 60 s, health-gate") — offline: the mock sidecar is a LOCAL node:http
 * server hosted in a worker harness (solveSync blocks the caller in
 * Atomics.wait, so the mock must live on another thread to answer).
 *
 * FlareSolverr v1 wire shape: GET /health → 200; POST /v1 { cmd,
 * url, maxTimeout, session?, postData? } → { status: 'ok', solution:
 * { url, status, headers, response, cookies, userAgent } } | { status:
 * 'error', message }.
 */

interface SidecarHarness {
  port: number;
  baseUrl: string;
  setMode(mode: 'ok' | 'unhealthy' | 'error' | 'stall'): Promise<void>;
  stats(): Promise<{ v1Calls: number; maxInFlight: number; healthCalls: number; lastBody: Record<string, unknown> }>;
  close(): Promise<void>;
}

const SIDECAR_SCRIPT = `
(async () => {
  const { parentPort } = await import('node:worker_threads');
  const http = await import('node:http');
  let mode = 'ok';
  let v1Calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let healthCalls = 0;
  let lastBody = {};

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      healthCalls++;
      if (mode === 'unhealthy') { res.writeHead(503); res.end('unhealthy'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        v1Calls++;
        if (mode === 'stall') {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => { inFlight--; res.writeHead(200); res.end('{}'); }, 5000);
          return;
        }
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight--;
          if (mode === 'error') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'challenge not solved' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            solution: {
              url: String(lastBody.url || '') + '#cleared',
              status: 200,
              headers: { 'content-type': 'text/html' },
              response: '<html>cleared</html>',
              cookies: [{ name: 'cf_clearance', value: 'tok', domain: 'example.org', path: '/', expires: 1800000000, httpOnly: true, secure: true, sameSite: 'Lax' }],
              userAgent: 'MockBrowser/1.0',
            },
          }));
        }, 120);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1', () => {
    parentPort.postMessage({ type: 'ready', port: server.address().port });
  });
  parentPort.on('message', (msg) => {
    if (msg.type === 'mode') { mode = msg.mode; parentPort.postMessage({ type: 'modeSet' }); return; }
    if (msg.type === 'stats') {
      parentPort.postMessage({ type: 'stats', stats: { v1Calls, maxInFlight, healthCalls, lastBody } });
    }
  });
})();
`;

let harness: SidecarHarness | undefined;

async function startHarness(): Promise<SidecarHarness> {
  const worker = new Worker(SIDECAR_SCRIPT, { eval: true });
  const port = await new Promise<number>((resolve, reject) => {
    worker.on('message', (msg: { type: string; port?: number }) => {
      if (msg.type === 'ready' && msg.port !== undefined) {
        resolve(msg.port);
      }
    });
    worker.on('error', reject);
  });
  const send = (msg: Record<string, unknown>): Promise<void> =>
    new Promise((resolve) => {
      const onMessage = (m: { type: string }): void => {
        if (m.type === 'modeSet') {
          worker.off('message', onMessage);
          resolve();
        }
      };
      worker.on('message', onMessage);
      worker.postMessage(msg);
    });
  const stats = (): Promise<{ v1Calls: number; maxInFlight: number; healthCalls: number; lastBody: Record<string, unknown> }> =>
    new Promise((resolve) => {
      const onMessage = (m: { type: string; stats?: { v1Calls: number; maxInFlight: number; healthCalls: number; lastBody: Record<string, unknown> } }): void => {
        if (m.type === 'stats' && m.stats !== undefined) {
          worker.off('message', onMessage);
          resolve(m.stats);
        }
      };
      worker.on('message', onMessage);
      worker.postMessage({ type: 'stats' });
    });
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    setMode: async (mode) => {
      await send({ type: 'mode', mode });
    },
    stats,
    close: () =>
      new Promise((resolve) => {
        worker.on('exit', () => resolve());
        void worker.terminate();
      }),
  };
}

describe('FlareSolverrBypassExecutor contract (§5.11)', () => {
  afterAll(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('§5.11 budgets are the defaults: concurrency 2, timeout 60 s', async () => {
    const h = harness ?? (harness = await startHarness());
    const executor = new FlareSolverrBypassExecutor({ baseUrl: h.baseUrl });
    expect(executor.budget).toEqual({ timeoutMs: BYPASS_DEFAULT_TIMEOUT_MS, maxConcurrency: BYPASS_MAX_CONCURRENCY });
    expect(BYPASS_DEFAULT_TIMEOUT_MS).toBe(60_000);
    expect(BYPASS_MAX_CONCURRENCY).toBe(2);
    executor.dispose();
  });

  it('health(): true on 200, false on 503', async () => {
    const h = harness ?? (harness = await startHarness());
    const executor = new FlareSolverrBypassExecutor({ baseUrl: h.baseUrl, healthTtlMs: 0 });
    expect(await executor.health()).toBe(true);
    await h.setMode('unhealthy');
    expect(await executor.health()).toBe(false);
    await h.setMode('ok');
    executor.dispose();
  });

  it('health-gate: an unhealthy sidecar refuses solve WITHOUT touching /v1', async () => {
    const h = harness ?? (harness = await startHarness());
    await h.setMode('unhealthy');
    const executor = new FlareSolverrBypassExecutor({ baseUrl: h.baseUrl, healthTtlMs: 60_000 });
    await expect(executor.solve({ url: 'https://example.org/challenge' })).rejects.toBeInstanceOf(BypassUnavailableError);
    const stats = await h.stats();
    expect(stats.v1Calls).toBe(0);
    executor.dispose();
    await h.setMode('ok');
  });

  it('solve(): request.get round-trip maps the FlareSolverr solution envelope', async () => {
    const h = harness ?? (harness = await startHarness());
    const executor = new FlareSolverrBypassExecutor({ baseUrl: h.baseUrl });
    const solution = await executor.solve({ url: 'https://example.org/page' });
    expect(solution.url).toBe('https://example.org/page#cleared');
    expect(solution.status).toBe(200);
    expect(solution.body).toBe('<html>cleared</html>');
    expect(solution.userAgent).toBe('MockBrowser/1.0');
    expect(solution.headers['content-type']).toBe('text/html');
    expect(solution.cookies).toEqual([
      { name: 'cf_clearance', value: 'tok', domain: 'example.org', path: '/', expires: 1_800_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
    const stats = await h.stats();
    expect(stats.lastBody['cmd']).toBe('request.get');
    expect(stats.lastBody['url']).toBe('https://example.org/page');
    expect(stats.lastBody['maxTimeout']).toBe(60_000);
    executor.dispose();
  });

  it('bounded concurrency 2: five concurrent solves never exceed two in-flight /v1 calls', async () => {
    const h = harness ?? (harness = await startHarness());
    const executor = new FlareSolverrBypassExecutor({ baseUrl: h.baseUrl });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => executor.solve({ url: `https://example.org/p${String(i)}` })),
    );
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    const stats = await h.stats();
    expect(stats.v1Calls).toBeGreaterThanOrEqual(5);
    expect(stats.maxInFlight).toBe(2); // the §5.11 bound, observed at the sidecar
    executor.dispose();
  });

  it('timeout: a stalled /v1 trips BypassTimeoutError within the configured budget', async () => {
    const h = harness ?? (harness = await startHarness());
    await h.setMode('stall');
    const executor = new FlareSolverrBypassExecutor({ baseUrl: h.baseUrl, timeoutMs: 300, healthTtlMs: 60_000 });
    await expect(executor.solve({ url: 'https://example.org/slow' })).rejects.toBeInstanceOf(BypassTimeoutError);
    executor.dispose();
    await h.setMode('ok');
  });

  it('upstream error outcome: FlareSolverr status=error → BypassUpstreamError with the message', async () => {
    const h = harness ?? (harness = await startHarness());
    await h.setMode('error');
    const executor = new FlareSolverrBypassExecutor({ baseUrl: h.baseUrl, healthTtlMs: 60_000 });
    const err = await executor.solve({ url: 'https://example.org/hard' }).catch((e: unknown): Error => e as Error);
    expect(err).toBeInstanceOf(BypassUpstreamError);
    expect((err as Error).message).toBe('challenge not solved');
    executor.dispose();
    await h.setMode('ok');
  });

  it('solveSync(): the blocking bridge routes through the same pump and unwraps the solution', async () => {
    const h = harness ?? (harness = await startHarness());
    await h.setMode('ok');
    const executor = new FlareSolverrBypassExecutor({ baseUrl: h.baseUrl });
    const solution = executor.solveSync({ url: 'https://example.org/sync' });
    expect(solution.status).toBe(200);
    expect(solution.body).toBe('<html>cleared</html>');
    executor.dispose();
  });

  it('an unreachable sidecar surfaces BypassUnavailableError (and poisons the health cache)', async () => {
    const executor = new FlareSolverrBypassExecutor({ baseUrl: 'http://127.0.0.1:9', healthTtlMs: 0 });
    await expect(executor.solve({ url: 'https://example.org/x' })).rejects.toBeInstanceOf(BypassUnavailableError);
    executor.dispose();
  });
});

describe('extractUrl + fmd.subprocess stub routing (§5.7/§5.11)', () => {
  it('extractUrl picks the first http(s) URL from a command line', () => {
    expect(extractUrl('cmd.exe /c node fetch.js --out /tmp/a.png https://site.example/pic.jpg?v=2')).toBe(
      'https://site.example/pic.jpg?v=2',
    );
    expect(extractUrl('cmd.exe /c dir')).toBeUndefined();
  });

  it('without the adapter: the denied stub returns nil for RunCommand*', () => {
    const shim: SubprocessShim = makeSubprocessShim({ logger: null, moduleId: 'm' });
    expect(shim.RunCommand('cmd.exe', '/c x')).toBeUndefined();
    expect(shim.RunCommandHide('cmd.exe', '/c x')).toBeUndefined();
  });

  it('with the adapter: RunCommandHide routes to solveSync and returns the LuaSubprocess.pas 4-value contract', () => {
    const calls: string[] = [];
    const adapter: BypassExecutorPort = {
      health: async () => true,
      solve: async () => {
        throw new Error('unused');
      },
      solveSync: (request) => {
        calls.push(request.url);
        return {
          url: request.url,
          status: 200,
          headers: {},
          body: 'ok',
          cookies: [{ name: 'cf_clearance', value: 'solved', domain: '', path: '/', expires: 0, httpOnly: false, secure: false, sameSite: 'Lax' }],
          userAgent: 'UA',
        };
      },
      dispose(): void {},
    };
    const shim = makeSubprocessShim({ bypass: adapter, logger: null, moduleId: 'm' });
    const returned = shim.RunCommandHide('cmd.exe', '/c node fetch.js https://site.example/page');
    const refused = shim.RunCommandHide('cmd.exe', '/c dir');
    expect(calls).toEqual(['https://site.example/page']);
    // (result, OutputString, ErrorString, ExitStatus) — LuaSubprocess.pas _runcommand (Result := 4)
    expect([...returned!]).toEqual([
      true,
      // cloudflare.py stdout shape: flat cookie map + user_agent inside flaresolver_result
      JSON.stringify({
        flaresolver_status_code: 200,
        flaresolver_result: JSON.stringify({ cf_clearance: 'solved', user_agent: 'UA' }),
        rookiepy_status_code: 400,
        rookiepy_result: 'rookiepy did not run',
      }),
      '',
      0,
    ]);
    // no URL in the command line → (false, '', reason, 1) (nothing to route)
    expect([...refused!]).toEqual([false, '', 'no http(s) URL in command line', 1]);
    expect(calls).toHaveLength(1);
  });

  it('with the adapter: a failing sidecar solve → (false, "", error, 1) (and a WARN log record)', () => {
    const records: Array<{ level: string; message: string }> = [];
    const adapter: BypassExecutorPort = {
      health: async () => true,
      solve: async () => {
        throw new Error('unused');
      },
      solveSync: () => {
        throw new BypassTimeoutError('budget exhausted');
      },
      dispose(): void {},
    };
    const shim = makeSubprocessShim({
      bypass: adapter,
      logger: { records: [], write: (r) => records.push({ level: r.level, message: r.message }) },
      moduleId: 'mod',
    });
    const budget = shim.RunCommandHide('cmd.exe', '/c node x.js https://site.example/y');
    expect(budget).toBeDefined();
    expect([...budget!]).toEqual([
      false,
      '',
      'budget exhausted',
      1,
    ]);
    expect(records.some((r) => r.level === 'warn' && r.message.includes('budget exhausted'))).toBe(true);
  });
});
