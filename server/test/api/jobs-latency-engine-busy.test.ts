/**
 * Downloads-page lockup regression (endpoint latency under engine load):
 *
 * GET /api/jobs must stay fast while a module HTTP hop is in flight —
 * with N seeded jobs in the queue AND a real engine dispatch waiting
 * out a slow loopback origin on the engine thread. Pre-fix, the hop
 * blocked the MAIN event loop inside the synchronous transport
 * (Atomics.wait), and the list endpoint stalled for the full hop
 * budget (measured live: 14.8 s against a silent origin while a
 * chapter's GetPageNumber hung — the owner-visible "Loading jobs…"
 * lockup).
 *
 * Hermetic (DESIGN §13): loopback slow origin only, E2ESeed fixture
 * module through the REAL offloaded engine path, fastify.inject (no
 * sockets needed for the latency pin — a blocked loop delays inject
 * the same way it delays a socket).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildHarness } from './helpers.js';
import { EngineThread, OffloadedInfoService } from '../../src/engine/services/engine-thread.js';
import { createLuaHostFactory } from '../../src/engine/lua/host.js';
import { EgressPolicy } from '../../src/engine/shims/http-egress.js';
import type { RegistrationRecord } from '../../src/engine/registry/capabilities.js';
import { fileURLToPath } from 'node:url';

const LUA_ROOT = fileURLToPath(new URL('../../../e2e/fixtures/lua/lua/', import.meta.url));
const MODULE_ID = 'e2ee000000000000000000000000ca7a';
const SEED_JOBS = 250;
const ORIGIN_DELAY_MS = 1_200;
/** Latency bound per list poll while the engine hop is in flight: the
 * pre-fix failure mode measured ~ORIGIN_DELAY_MS (fully blocked loop);
 * a healthy loop answers in single-digit milliseconds. */
const LIST_BOUND_MS = 500;

const INFO_BODY = Buffer.from(
  '<html><body>' +
    '<h1 id="manga-title">Latency Quest</h1>' +
    '<span id="authors">Author A</span>' +
    '<span id="genres">Action</span>' +
    '<span id="status">Ongoing</span>' +
    '<p id="summary">A quest.</p>' +
    '<ul id="chapters"><li><a href="/manga/latency-quest/c001">Ch.001</a></li></ul>' +
    '</body></html>',
);

function registration(): RegistrationRecord {
  return {
    id: MODULE_ID,
    name: 'E2ESeed',
    rootURL: '',
    category: 'English',
    accountSupport: false,
    options: [],
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: ['GetInfo', 'GetPageNumber', 'GetImageURL'],
      known_broken_flags: [],
      live_scrape_fallback: false,
    },
    file: 'E2ESeed.lua',
  };
}

let origin: Server;
let originBase = '';
let thread: EngineThread;

beforeAll(async (): Promise<void> => {
  origin = createServer((_req, res): void => {
    setTimeout((): void => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(INFO_BODY);
    }, ORIGIN_DELAY_MS);
  });
  await new Promise<void>((resolve): void => {
    origin.listen(0, '127.0.0.1', (): void => {
      resolve();
    });
  });
  const address = origin.address();
  if (address === null || typeof address === 'string') {
    throw new Error('slow origin did not bind');
  }
  originBase = `http://127.0.0.1:${String(address.port)}`;
  thread = new EngineThread({ allowedHosts: [], egressAllow: ['*', '127.0.0.1'] });
}, 30_000);

afterAll(async (): Promise<void> => {
  thread.dispose();
  await new Promise<void>((resolve): void => {
    origin.close((): void => {
      resolve();
    });
  });
}, 30_000);

describe('GET /api/jobs latency while the engine waits on a slow origin', (): void => {
  it(`lists ${String(SEED_JOBS)} seeded jobs fast during an in-flight module hop`, async (): Promise<void> => {
    const h = buildHarness();

    // Seed the downloads queue (N jobs across states — done rows included
    // so the list payload is realistically sized).
    for (let i = 0; i < SEED_JOBS; i += 1) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/jobs/download',
        payload: {
          moduleId: (i % 2 === 0 ? 'aaaaaaaa' : 'bbbbbbbb') + String(i).padStart(8, '0') + 'c'.repeat(16),
          mangaUrl: `https://ex.org/manga/x${String(i)}`,
          mangaTitle: `Fixture Manga ${String(i)}`,
          chapterLink: `https://ex.org/manga/x${String(i)}/1`,
          chapterName: `Ch. ${String(i)}`,
          idempotencyKey: `latency-seed-${String(i)}`,
        },
      });
      expect(res.statusCode).toBe(201);
    }
    expect(h.jobs.size).toBe(SEED_JOBS);

    const service = new OffloadedInfoService(
      {
        luaRoot: LUA_ROOT,
        modules: (): readonly RegistrationRecord[] => [registration()],
        transport: { send: (): never => { throw new Error('main-thread transport must not be used'); } },
        egress: new EgressPolicy({ allow: ['*'] }),
        hostFactory: createLuaHostFactory(),
      },
      thread,
      { allowedHosts: [], egressAllow: ['*', '127.0.0.1'] },
    );

    // The engine dispatch that pre-fix froze the server: a module hop
    // waiting out the slow origin ON THE ENGINE THREAD.
    let pending = true;
    const infoPromise = service.getInfo(MODULE_ID, `${originBase}/manga/latency-quest`);
    void infoPromise.finally((): void => {
      pending = false;
    });

    const timings: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const started = Date.now();
      const res = await h.app.inject({ method: 'GET', url: '/api/jobs?limit=50' });
      timings.push(Date.now() - started);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { jobs: unknown[] };
      expect(body.jobs.length).toBe(50);
    }
    expect(pending).toBe(true); // the hop was still holding the whole time
    for (const ms of timings) {
      expect(ms).toBeLessThan(LIST_BOUND_MS);
    }

    const info = await infoPromise;
    expect(info.title).toBe('Latency Quest');
  }, 60_000);
});
