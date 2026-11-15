import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildUpstreamTree, startMock, e2eConstants, type MockUpstream, type UpstreamTree } from './fixtures.js';

/**
 * SIGTERM graceful drain of the REAL runtime entry (DESIGN §4) — the
 * process-mode twin of the compose drain assertion: the server boots,
 * auto-bootstraps against the local mock upstream, serves the SPA over
 * the raw bridge, and on SIGTERM flushes and exits within the 30 s
 * bound with the drain log lines compose logs will be asserted on.
 *
 * Runs `node server/dist/src/runtime-entry.js` — the built artifact the
 * Docker image executes (CI builds before tests; scripts/e2e.sh too).
 */

const ENTRY = path.resolve(import.meta.dirname, '../../../server/dist/src/runtime-entry.js');
const DRAIN_BOUND_MS = 30_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject): void => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', (): void => {
      const port = (server.address() as net.AddressInfo).port;
      server.close((): void => {
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

let mock: MockUpstream;
let upstream: UpstreamTree;
let distDir: string;
let upstreamRoot: string;

beforeAll(async (): Promise<void> => {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`runtime entry not built: ${ENTRY} (run npm run typecheck first)`);
  }
  upstreamRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-drain-upstream-'));
  const started = await startMock(upstreamRoot);
  mock = started.mock;
  upstream = buildUpstreamTree({ mockBase: started.base, outDir: upstreamRoot });
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-drain-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>fmd-web</title>');
}, 60_000);

afterAll((): void => {
  mock.stop();
  upstream.cleanup();
  fs.rmSync(upstreamRoot, { recursive: true, force: true });
  fs.rmSync(distDir, { recursive: true, force: true });
});

interface Booted {
  readonly child: ChildProcess;
  readonly port: number;
  readonly stdout: string[];
  readonly stderr: string[];
}

async function bootServer(dataDir: string, port: number): Promise<Booted> {
  const e2e = e2eConstants();
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      FMD_WEB_DATA_DIR: dataDir,
      FMD_STATIC_DIR: distDir,
      FMD2_REPO: e2e.repo,
      FMD2_LUA_SHA: e2e.luaSha,
      FMD2_CODELOAD_URL: `${mock.base}/codeload`,
      FMD_DB_URL: `${mock.base}/FMD2-DB/db`,
      FMD_DB_API_BASE: `${mock.base}/api-github`,
      FMD_BOOTSTRAP_CATALOGS: e2e.catalogId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on('data', (chunk: Buffer): void => {
    stdout.push(String(chunk));
  });
  child.stderr?.on('data', (chunk: Buffer): void => {
    stderr.push(String(chunk));
  });
  return { child, port, stdout, stderr };
}

async function waitForReady(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
      lastStatus = res.status;
      if (res.status === 200) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`server never became ready (last /readyz status ${String(lastStatus)})`);
}

describe('SIGTERM graceful drain (§4, process-mode twin of the compose assertion)', (): void => {
  it('boots with auto-bootstrap, serves the SPA, and exits ≤30s with flush logs on SIGTERM', async (): Promise<void> => {
    const e2e = e2eConstants();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-drain-data-'));
    const port = await freePort();
    const { child, stdout, stderr } = await bootServer(dataDir, port);
    try {
      await waitForReady(port);

      // Enqueue a job pre-drain so the flush has state to report.
      await fetch(`http://127.0.0.1:${String(port)}/api/jobs/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moduleId: e2e.catalogId,
          mangaUrl: `${mock.base}/manga/alpha-quest`,
          mangaTitle: 'Alpha Quest',
          chapterLink: '/manga/alpha-quest/ch/1',
          chapterName: 'Chapter 1: The Beginning',
        }),
      }).then(async (res): Promise<void> => {
        expect(res.status).toBe(201);
        expect((await res.json() as { job: { state: string } }).job.state).toBe('queued');
      });

      // SPA served through the raw bridge (Buffer-exact static reply).
      const index = await fetch(`http://127.0.0.1:${String(port)}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('fmd-web');

      // ── the drain ──
      const startedAt = Date.now();
      const exited = new Promise<{ code: number | null; elapsedMs: number }>((resolve): void => {
        child.on('exit', (code): void => {
          resolve({ code, elapsedMs: Date.now() - startedAt });
        });
      });
      child.kill('SIGTERM');
      const result = await exited;
      const log = stdout.join('');

      expect(result.code).toBe(0);
      expect(result.elapsedMs).toBeLessThan(DRAIN_BOUND_MS);
      expect(log).toContain('SIGTERM received — beginning graceful drain');
      expect(log).toContain('stopped accepting connections');
      expect(log).toContain('1 queued job(s) preserved');
      expect(log).toContain('flush complete');
      expect(log).toContain('drain: complete in');
      // The whole run bootstrapped (compose logs assert the same lines).
      expect(log).toContain('bootstrap: done');
      expect(stderr.join('')).toBe('');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 150_000);
});
