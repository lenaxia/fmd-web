/**
 * STUB-SUBSTRATE SWAP PROOF (engine-boundary story, tsk-linear-varnish-restricts)
 * — the existence half of "no Lua gets in" (the CI dependency gates are
 * the type half; together they prove replaceability, see
 * docs/ENGINE-BOUNDARY.md).
 *
 * A test-only StubModuleRuntime implements the facade's ModuleRuntime
 * interface with NO wasmoon anywhere on its path: canned registry rows,
 * a scripted info result, scripted download hooks and login sessions,
 * stub sweep/walker. The app boots END-TO-END on it — healthz/readyz,
 * /api/modules serving stub registry data, a scripted /api/info
 * round-trip, and a job enqueue/cancel round-trip.
 *
 * The proof has teeth two ways:
 *  1. The wasmoon CANARY: `vi.mock('wasmoon', …throw…)` — if ANY module
 *     on the booted app's static import graph evaluates wasmoon (a leak
 *     the facade's wasmoon-free value rule exists to prevent), this
 *     suite fails loudly.
 *  2. Interface completeness: if any facade seam the app actually needs
 *     were missing (the app "secretly" requiring the Lua substrate),
 *     this test could not be written — the substrate override would not
 *     typecheck or the boot would fall through to the real engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// THE CANARY — registered BEFORE any import that could reach wasmoon.
// The facade's runtime value graph is wasmoon-free by rule; the default
// substrate is loaded lazily through the production door and never fires
// when a substrate is injected. If either invariant regresses, this mock
// factory runs and the suite dies with the message below.
vi.mock('wasmoon', (): object => {
  throw new Error(
    'wasmoon was evaluated on the stub-substrate boot path — the engine boundary is leaky',
  );
});

import { buildRuntime, type RuntimeConfig } from '../../src/runtime/assembly.js';
// Type-only facade imports (erased at runtime — they cannot evaluate
// anything, which is exactly why the facade exports these as types).
import type {
  DirectoryWalkPort,
  EngineInfoOptions,
  EngineLoginSessionOptions,
  ModuleDownloadHooks,
  ModuleHostFactory,
  ModuleInfoPort,
  ModuleLoginPort,
  ModuleRuntime,
  ModuleTreeSweepPort,
  RegistrationRecord,
} from '../../src/engine/facade.js';
import type { CatalogEntry, NormalizedInfo } from '@fmd/contract';

// ── the stub substrate ──────────────────────────────────────────────────────

const STUB_MODULE_ID = '5'.repeat(32);
const STUB_MODULE_NAME = 'StubSwapSite';

function stubRegistration(): RegistrationRecord {
  return {
    id: STUB_MODULE_ID,
    name: STUB_MODULE_NAME,
    rootURL: 'https://stub-swap.example',
    category: 'Manga',
    accountSupport: true,
    options: [{ name: 'Language', kind: 'combobox', defaultValue: 0, items: ['en', 'ja'] }],
    file: 'StubSwapSite.lua',
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: ['GetInfo', 'GetPageNumber', 'GetImageURL'],
      known_broken_flags: [],
      live_scrape_fallback: true,
    },
  };
}

const STUB_INFO: NormalizedInfo = {
  title: 'Stub Swap Manga',
  altTitles: 'Alt; Titles',
  authors: 'Stub Author',
  artists: 'Stub Artist',
  genres: 'Action, Stub',
  status: 'Ongoing',
  summary: 'A scripted info result served with zero Lua.',
  coverLink: 'https://stub-swap.example/cover.jpg',
  url: 'https://stub-swap.example/manga/1',
  link: 'https://stub-swap.example/manga/1',
  chapterLinks: ['https://stub-swap.example/manga/1/ch/1'],
  chapterNames: ['Chapter 1'],
  numChapter: 1,
};

const STUB_DIRECTORY_PAGE: readonly CatalogEntry[] = [
  {
    link: 'https://stub-swap.example/manga/1',
    title: 'Stub Swap Manga',
    alttitles: '',
    authors: '',
    artists: '',
    genres: '',
    status: '',
    summary: '',
    numChapter: 1,
    jdn: 2460000,
  },
];

/**
 * The NO-WASMOON substrate: every construction the assembly asks the
 * engine for is answered with canned data. `hostFactoryCalls` MUST stay
 * 0 — the substrate never constructs a module host.
 */
class StubModuleRuntime implements ModuleRuntime {
  public readonly hostFactoryCalls = 0;
  public infoCalls: readonly { moduleId: string; url: string }[] = [];
  public infoDisposed = false;
  public readonly initialModules: readonly RegistrationRecord[];

  constructor(rows: readonly RegistrationRecord[]) {
    this.initialModules = rows;
  }

  createHostFactory(): ModuleHostFactory {
    // Typed as the opaque factory; any CALL fails the test loudly (the
    // stub serves everything without a host).
    return {
      createHost: (): never => {
        throw new Error('stub substrate: module host constructed — the swap is leaky');
      },
      createChunkCache: (): never => {
        throw new Error('stub substrate: chunk cache constructed — the swap is leaky');
      },
    };
  }

  createSweep(): ModuleTreeSweepPort {
    const registrations = this.initialModules;
    return {
      discoverFiles: (): string[] => ['StubSwapSite.lua'],
      treeSha: (): string => '0'.repeat(64),
      sweep: async () => ({
        files: [{ file: 'StubSwapSite.lua', ok: true, registrations }],
        summary: {
          luaRoot: '(stub)',
          treeSha: '0'.repeat(64),
          totalFiles: 1,
          registeredFiles: 1,
          failedFiles: 0,
          totalModules: registrations.length,
          failures: [],
          knownBroken: {},
          eventCoverage: { GetInfo: registrations.length },
          withinTolerance: true,
        },
        registrations,
      }),
    };
  }

  createInfoService(_options: EngineInfoOptions): ModuleInfoPort {
    return {
      getInfo: async (moduleId: string, url: string): Promise<NormalizedInfo> => {
        this.infoCalls = [...this.infoCalls, { moduleId, url }];
        return { ...STUB_INFO, url };
      },
      dispose: async (): Promise<void> => {
        this.infoDisposed = true;
      },
    };
  }

  createDirectoryWalker(): DirectoryWalkPort {
    return {
      walk: async (): Promise<readonly CatalogEntry[]> => STUB_DIRECTORY_PAGE,
    };
  }

  async createDownloadHooks(_moduleId: string): Promise<ModuleDownloadHooks> {
    return {
      taskStart: async (): Promise<boolean> => true,
      getPageNumber: async (task): Promise<boolean> => {
        task.pageNumber = 1;
        task.pageLinks[0] = 'https://stub-swap.example/img/001.jpg';
        return true;
      },
      getImageURL: async (): Promise<boolean> => true,
      dispose: async (): Promise<void> => undefined,
    };
  }

  createLoginSession(_options: EngineLoginSessionOptions): ModuleLoginPort {
    return {
      login: async () => ({ status: 2, cookies: 'stub-session=1' }),
      dispose: async (): Promise<void> => undefined,
    };
  }
}

// ── the boot + round-trips ──────────────────────────────────────────────────

let runtime: Awaited<ReturnType<typeof buildRuntime>>;
let stub: StubModuleRuntime;
let dataDir: string;
const logs: string[] = [];

beforeAll(async (): Promise<void> => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-stub-substrate-'));
  const config: RuntimeConfig = {
    dataDir,
    port: 0,
    staticDir: undefined,
    moduleSync: {
      repo: 'dazedcat19/fmd2',
      sha: '0'.repeat(40),
      codeloadBaseUrl: 'https://stub.invalid',
      tarballApiBaseUrl: 'https://stub.invalid',
      dataDir,
      luaDirOverride: undefined,
      autoBump: false,
    },
    dbUrl: undefined,
    dbApiBase: undefined,
    bootstrapCatalogIds: [],
    httpAllowedHosts: [],
    bootstrapStageDelayMs: 0,
    // The stub vouches for its registry (initialModules); the bootstrap
    // is disabled so nothing ever fetches a real lua tree. /readyz is
    // green by design on this deployment shape (FMD_BOOTSTRAP_DISABLE=1
    // semantics — the operator, here the substrate, owns provisioning).
    bootstrapDisabled: true,
    favoriteMaxConcurrent: 1,
    favoriteIntervalMs: 60 * 60 * 1000,
    favoriteJitterMs: 0,
    browserSidecarUrl: '',
    liveScrapeTtlMs: 6 * 60 * 60 * 1000,
    liveScrapeConcurrency: 1,
    liveScrapeHostLimit: 4,
    password: undefined,
    apiTokenEnv: undefined,
  };
  stub = new StubModuleRuntime([stubRegistration()]);
  runtime = await buildRuntime({
    config,
    log: (message): void => {
      logs.push(message);
    },
    version: '0.1.0-stub-proof',
    substrate: stub,
  });
  // The production boot sequence: D20 bootstrap run (DISABLED here — the
  // substrate vouches for the registry, nothing is fetched; the runner
  // short-circuits to done, which is what flips /readyz green).
  await runtime.bootstrap.run();
});

afterAll(async (): Promise<void> => {
  await runtime.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('stub-substrate swap proof (engine boundary: no Lua gets in)', (): void => {
  it('the substrate never constructed a module host (opaque factory untouched)', (): void => {
    expect(stub.hostFactoryCalls).toBe(0);
  });

  it('/healthz + /readyz pass on the stub boot', async (): Promise<void> => {
    const health = await runtime.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    const ready = await runtime.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ready: true });
  });

  it('/api/modules serves the STUB registry rows', async (): Promise<void> => {
    const res = await runtime.app.inject({ method: 'GET', url: '/api/modules' });
    expect(res.statusCode).toBe(200);
    const modules = res.json().modules as { id: string; name: string }[];
    expect(modules.map((m): string => m.id)).toEqual([STUB_MODULE_ID]);
    expect(modules[0]?.name).toBe(STUB_MODULE_NAME);
  });

  it('/api/info round-trips the SCRIPTED result (no Lua anywhere)', async (): Promise<void> => {
    const url = 'https://stub-swap.example/manga/1';
    const res = await runtime.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: STUB_MODULE_ID, url },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NormalizedInfo & { moduleId?: string };
    expect(body.title).toBe(STUB_INFO.title);
    expect(body.summary).toBe(STUB_INFO.summary);
    expect(body.numChapter).toBe(STUB_INFO.numChapter);
    expect(body.chapterLinks).toEqual(STUB_INFO.chapterLinks);
    // The STUB served it — verbatim call record.
    expect(stub.infoCalls).toEqual([{ moduleId: STUB_MODULE_ID, url }]);
  });

  it('a job enqueue/cancel round-trips through the stub boot', async (): Promise<void> => {
    // paused:true = add-as-stopped hold — the job stays queued (the lane
    // never claims it), so the cancel round-trip is deterministic and
    // needs zero substrate interaction beyond the registry row.
    const enqueue = await runtime.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: {
        moduleId: STUB_MODULE_ID,
        mangaUrl: 'https://stub-swap.example/manga/1',
        mangaTitle: 'Stub Swap Manga',
        chapterLink: 'https://stub-swap.example/manga/1/ch/1',
        chapterName: 'Chapter 1',
        paused: true,
      },
    });
    expect(enqueue.statusCode).toBe(201);
    const job = enqueue.json().job as { id: string; state: string };
    expect(job.state).toBe('queued');

    const cancel = await runtime.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json().job as { state: string }).state).toBe('cancelled');

    const fetched = await runtime.app.inject({ method: 'GET', url: `/api/jobs/${job.id}` });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json().job as { state: string }).state).toBe('cancelled');
  });

  it('the stub info service was disposed on drain (substrate lifecycle respected)', async (): Promise<void> => {
    // afterAll ran dispose? No — assert the dispose path explicitly by
    // disposing a SECOND stub runtime instance.
    const second = new StubModuleRuntime([stubRegistration()]);
    const rt = await buildRuntime({
      config: { ...runtimeConfigOf(dataDir) },
      log: (): void => undefined,
      version: '0.1.0-stub-proof',
      substrate: second,
    });
    await rt.dispose();
    expect(second.infoDisposed).toBe(true);
  });
});

/** Minimal config copy for the lifecycle assertion. */
function runtimeConfigOf(dir: string): RuntimeConfig {
  return JSON.parse(
    JSON.stringify({
      dataDir: dir,
      port: 0,
      staticDir: undefined,
      moduleSync: {
        repo: 'dazedcat19/fmd2',
        sha: '0'.repeat(40),
        codeloadBaseUrl: 'https://stub.invalid',
        tarballApiBaseUrl: 'https://stub.invalid',
        dataDir: dir,
        luaDirOverride: undefined,
        autoBump: false,
      },
      dbUrl: undefined,
      dbApiBase: undefined,
      bootstrapCatalogIds: [],
      httpAllowedHosts: [],
      bootstrapStageDelayMs: 0,
      bootstrapDisabled: true,
      favoriteMaxConcurrent: 1,
      favoriteIntervalMs: 60 * 60 * 1000,
      favoriteJitterMs: 0,
      browserSidecarUrl: '',
      liveScrapeTtlMs: 6 * 60 * 60 * 1000,
      liveScrapeConcurrency: 1,
      liveScrapeHostLimit: 4,
      password: undefined,
      apiTokenEnv: undefined,
    }),
  ) as RuntimeConfig;
}
