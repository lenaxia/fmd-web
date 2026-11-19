import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  EngineThread,
  OffloadedInfoService,
  offloadEngineSubstrate,
  probeOnEngineThread,
} from '../../../src/engine/services/engine-thread.js';
import type { AvailabilitySink, SiteAvailabilityOutcome } from '../../../src/engine/services/availability.js';
import { createLuaHostFactory } from '../../../src/engine/lua/host.js';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import type { RegistrationRecord } from '../../../src/engine/registry/capabilities.js';
import type { ModuleRuntime } from '../../../src/engine/services/module-runtime.js';
import type { TaskWriter } from '../../../src/engine/services/download-ports.js';
import type { HostLogRecord } from '@fmd/contract';
import { fileURLToPath } from 'node:url';

/**
 * Engine-thread offload regression (the Downloads-page lockup):
 * a module HTTP hop that hangs on a slow origin must NEVER block the
 * main event loop — the hop blocks the ENGINE worker thread (where the
 * synchronous transport belongs), while the process that serves HTTP
 * stays responsive.
 *
 * Hermetic (DESIGN §13): the slow origin is a loopback node:http server
 * with a per-request delay; the module is the E2ESeed fixture driven
 * through the REAL offloaded engine path (worker thread + wasmoon +
 * §5.4 shims + LoopbackHttpTransport). No external network.
 *
 * Pre-fix, this exact scenario froze the process: the transport's
 * chunked Atomics.wait ran on the MAIN thread (wasmoon in-process), so
 * a 15 s silent origin stalled every concurrent request — measured
 * live as GET /api/jobs taking 14.8 s while a chapter dispatched.
 */

const LUA_ROOT = fileURLToPath(new URL('../../../../e2e/fixtures/lua/lua/', import.meta.url));
const MODULE_ID = 'e2ee000000000000000000000000ca7a';

/** Slow loopback origin: every response is held ORIGIN_DELAY_MS. */
const ORIGIN_DELAY_MS = 900;
const INFO_BODY = Buffer.from(
  '<html><body>' +
    '<h1 id="manga-title">Alpha Quest</h1>' +
    '<span id="authors">Author A</span>' +
    '<span id="genres">Action</span>' +
    '<span id="status">Ongoing</span>' +
    '<p id="summary">A quest.</p>' +
    '<ul id="chapters"><li><a href="/manga/alpha-quest/c001">Ch.001</a></li></ul>' +
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

/** Slow-origin router: the info shape, a two-page chapter shape (the
 * §5.2 GetPageNumber/GetImageURL flow), and per-page image containers. */
const bodyFor = (url: string | undefined): Buffer => {
  if (url !== undefined && url.startsWith('/page/')) {
    return Buffer.from(
      `<html><body><img id="image" src="${originBase}/img/1.jpg"/></body></html>`,
    );
  }
  if (url !== undefined && url.includes('/c001')) {
    return Buffer.from(
      `<html><body><div id="pages">` +
        `<a href="${originBase}/page/1"></a><a href="${originBase}/page/2"></a>` +
        `</div></body></html>`,
    );
  }
  return INFO_BODY;
};

/** Wall-clock time N macrotask round-trips take (the loop-responsiveness
 * probe: pre-fix these serialize behind the blocked transport). */
async function loopRoundTrips(rounds: number): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
  }
  return Date.now() - started;
}

beforeAll(async (): Promise<void> => {
  origin = createServer((req, res): void => {
    const body = bodyFor(req.url);
    setTimeout((): void => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
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

describe('engine thread offload', (): void => {
  it('keeps the main event loop responsive while a module hop waits on a slow origin', async (): Promise<void> => {
    const records: HostLogRecord[] = [];
    const service = new OffloadedInfoService(
      {
        luaRoot: LUA_ROOT,
        modules: (): readonly RegistrationRecord[] => [registration()],
        // Unused by the offloaded path (the worker builds its own) but
        // part of the options contract:
        transport: { send: (): never => { throw new Error('main-thread transport must not be used'); } },
        egress: new EgressPolicy({ allow: ['*'] }),
        logSink: (record): void => {
          records.push(record);
        },
        hostFactory: createLuaHostFactory(),
      },
      thread,
      { allowedHosts: [], egressAllow: ['*', '127.0.0.1'] },
    );

    let pending = true;
    const infoPromise = service.getInfo(MODULE_ID, `${originBase}/manga/alpha-quest`);
    void infoPromise.finally((): void => {
      pending = false;
    });
    // While the engine's HTTP hop waits out the slow origin, the main
    // loop must keep cycling macrotasks. Pre-fix, this window was
    // blocked for the FULL origin delay per hop.
    const rounds = 60;
    const during = await loopRoundTrips(rounds);
    expect(pending).toBe(true); // the hop is genuinely still in flight
    // 60 timer round-trips on a free loop: tens of ms. A blocked loop
    // cannot finish before the ~900 ms origin delay elapses.
    expect(during).toBeLessThan(ORIGIN_DELAY_MS);

    const info = await infoPromise;
    expect(info.title).toBe('Alpha Quest');
    expect(info.chapterLinks).toContain('/manga/alpha-quest/c001');
    // engine log records flow back through the main-thread sink
    expect(Array.isArray(records)).toBe(true);
  }, 30_000);

  it('rejects with the typed ApiError envelope from the worker', async (): Promise<void> => {
    const service = new OffloadedInfoService(
      {
        luaRoot: LUA_ROOT,
        modules: (): readonly RegistrationRecord[] => [registration()],
        transport: { send: (): never => { throw new Error('unused'); } },
        egress: new EgressPolicy({ allow: ['*'] }),
        hostFactory: createLuaHostFactory(),
      },
      thread,
      { allowedHosts: [], egressAllow: ['*', '127.0.0.1'] },
    );
    await expect(service.getInfo('f'.repeat(32), `${originBase}/x`)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  }, 30_000);

  it('runs a full chapter session over the thread (task marshal + the unbound BeforeDownloadImage RPC)', async (): Promise<void> => {
    // The substrate wrapper is the seam production uses; the delegate's
    // other methods stay untouched (never called here).
    const substrate = offloadEngineSubstrate({} as ModuleRuntime, thread);
    const hooks = await substrate.createDownloadHooks(MODULE_ID, {
      luaRoot: LUA_ROOT,
      modules: (): readonly RegistrationRecord[] => [registration()],
      transport: { send: (): never => { throw new Error('main-thread transport must not be used'); } },
      egress: new EgressPolicy({ allow: ['*'] }),
      hostFactory: createLuaHostFactory(),
    }, );

    const task: TaskWriter = {
      pageLinks: [],
      pageContainerLinks: [],
      fileNames: [],
      pageNumber: 0,
      link: `${originBase}/manga/alpha-quest/c001`,
    };

    // GetPageNumber waits out the slow origin on the engine thread —
    // the main loop must stay responsive for the whole hop.
    let pending = true;
    const pageNumber = hooks.getPageNumber(task, task.link);
    void pageNumber.finally((): void => {
      pending = false;
    });
    const during = await loopRoundTrips(60);
    expect(pending).toBe(true);
    expect(during).toBeLessThan(ORIGIN_DELAY_MS);
    await expect(pageNumber).resolves.toBe(true);
    expect(task.pageNumber).toBe(2);
    expect(task.pageLinks).toEqual(['W', 'W']);

    // GetImageURL resolves slot 0 through the two-hop container flow.
    await expect(hooks.getImageURL(task, 0, task.link)).resolves.toBe(true);
    expect(task.pageLinks[0]).toBe(`${originBase}/img/1.jpg`);

    // BeforeDownloadImage is UNBOUND in E2ESeed → undefined. This is
    // the exact RPC shape that regressed live (it carries NO task
    // snapshot — a worker that required one failed every image of a
    // fanfox chapter with 'malformed chapter.call request').
    await expect(hooks.beforeDownloadImage?.(0, task.pageLinks[0] ?? '')).resolves.toBeUndefined();

    await hooks.dispose();
  }, 30_000);
});

describe('engine thread site-availability marshaling (dead-site discovery)', (): void => {
  it('a successful worker-side GetInfo forwards the reachable verdict home through the sink', async (): Promise<void> => {
    const outcomes: Array<{ moduleId: string; outcome: SiteAvailabilityOutcome }> = [];
    const sink: AvailabilitySink = (moduleId, outcome): void => {
      outcomes.push({ moduleId, outcome });
    };
    const service = new OffloadedInfoService(
      {
        luaRoot: LUA_ROOT,
        modules: (): readonly RegistrationRecord[] => [registration()],
        transport: { send: (): never => { throw new Error('unused'); } },
        egress: new EgressPolicy({ allow: ['*'] }),
        availabilitySink: sink,
        hostFactory: createLuaHostFactory(),
      },
      thread,
      { allowedHosts: [], egressAllow: ['*', '127.0.0.1'] },
    );
    const info = await service.getInfo(MODULE_ID, `${originBase}/manga/alpha-quest`);
    expect(info.title).toBe('Alpha Quest');
    // worker-side classification → response.availability → main-side sink
    expect(outcomes).toEqual([{ moduleId: MODULE_ID, outcome: { verdict: 'reachable' } }]);
  }, 30_000);

  it('a connection-refused origin rides the ERROR envelope home: typed 502 AND the unreachable verdict', async (): Promise<void> => {
    const outcomes: Array<{ moduleId: string; outcome: SiteAvailabilityOutcome }> = [];
    const sink: AvailabilitySink = (moduleId, outcome): void => {
      outcomes.push({ moduleId, outcome });
    };
    const service = new OffloadedInfoService(
      {
        luaRoot: LUA_ROOT,
        modules: (): readonly RegistrationRecord[] => [registration()],
        transport: { send: (): never => { throw new Error('unused'); } },
        egress: new EgressPolicy({ allow: ['*'] }),
        availabilitySink: sink,
        hostFactory: createLuaHostFactory(),
      },
      thread,
      { allowedHosts: [], egressAllow: ['*', '127.0.0.1'] },
    );
    // Port 9 (discard) on loopback: nothing listens → connect refused
    // fast — the dead-site shape the record exists for.
    await expect(service.getInfo(MODULE_ID, 'http://127.0.0.1:9/manga/x')).rejects.toMatchObject({
      status: 502,
      code: 'upstream_error',
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.moduleId).toBe(MODULE_ID);
    expect(outcomes[0]?.outcome.verdict).toBe('unreachable');
    expect(outcomes[0]?.outcome.reason ?? '').toContain('ECONNREFUSED');
  }, 30_000);

  it('the availability.check op probes the module RootURL on the worker thread', async (): Promise<void> => {
    const rooted = registration();
    const withRoot: RegistrationRecord = { ...rooted, rootURL: `${originBase}/` };
    const raw = await probeOnEngineThread(
      thread,
      {
        luaRoot: LUA_ROOT,
        modules: [withRoot],
        allowedHosts: [],
        egressAllow: ['*', '127.0.0.1'],
        cookies: [],
      },
      MODULE_ID,
    );
    expect(raw.resultCode).toBe(200);
  }, 30_000);

  it('the availability.check op surfaces the typed 404 for an unknown module', async (): Promise<void> => {
    await expect(
      probeOnEngineThread(
        thread,
        {
          luaRoot: LUA_ROOT,
          modules: [registration()],
          allowedHosts: [],
          egressAllow: ['*', '127.0.0.1'],
          cookies: [],
        },
        'f'.repeat(32),
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  }, 30_000);
});
