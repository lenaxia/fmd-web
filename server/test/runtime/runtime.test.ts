import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRuntime, loadRuntimeConfig, type RuntimeConfig } from '../../src/runtime/assembly.js';
import { DEFAULT_BOOTSTRAP_CATALOGS } from '../../src/runtime/catalog-defaults.js';
import { DEFAULT_FMD2_PIN_SHA } from '../../src/index.js';
import { registerStatic } from '../../src/runtime/static.js';
import { buildApp } from '../../src/api/app.js';
import {
  createDefaultServices,
  type ApiServices,
} from '../../src/main.js';
import {
  e2eConstants,
  buildUpstreamTree,
  startMock,
  type MockUpstream,
  type UpstreamTree,
} from './fixtures.js';

/**
 * PRODUCTION runtime assembly, offline (DESIGN §13 — the mock upstream
 * is loopback and is the REAL e2e/mock-upstream.mjs the compose stack
 * runs). This is the in-process twin of scripts/e2e.sh: D20 bootstrap
 * over an empty data dir through the real sync pipelines, readiness
 * gating, browsable catalogs, engine-backed live info against the mock
 * upstream, dry-run job enqueue, and SPA static serving.
 */

let mock: MockUpstream;
let upstream: UpstreamTree;
let upstreamRoot: string;

beforeAll(async (): Promise<void> => {
  // The catalog entry links embed the mock base, so the mock binds
  // first (port grabbed from the loopback stack) and the tree is built
  // INTO its root afterwards — every request happens post-build. The
  // curated DEFAULT bootstrap catalogs get blobs too (the defaults-
  // driven test boots with zero FMD2_*/FMD_BOOTSTRAP_* env).
  upstreamRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-upstream-'));
  const started = await startMock(upstreamRoot);
  mock = started.mock;
  upstream = buildUpstreamTree({
    mockBase: started.base,
    outDir: upstreamRoot,
    extraCatalogIds: DEFAULT_BOOTSTRAP_CATALOGS,
  });
}, 60_000);

afterAll((): void => {
  mock.stop();
  upstream.cleanup();
  fs.rmSync(upstreamRoot, { recursive: true, force: true });
});

function runtimeConfig(dataDir: string, mockBase: string, bootstrapDisabled = false): RuntimeConfig {
  const e2e = e2eConstants();
  return {
    dataDir,
    port: 0,
    staticDir: undefined,
    moduleSync: {
      repo: e2e.repo,
      sha: e2e.luaSha,
      codeloadBaseUrl: `${mockBase}/codeload`,
      tarballApiBaseUrl: `${mockBase}/api-github`,
      dataDir,
      luaDirOverride: undefined,
      autoBump: false,
    },
    // LIVE-layout mirror: the mock bakes `<base>/FMD2-DB/master/7z/<id>.7z`
    dbUrl: `${mockBase}/FMD2-DB/master`,
    dbApiBase: `${mockBase}/api-github`,
    bootstrapCatalogIds: [e2e.catalogId],
    httpAllowedHosts: [],
    bootstrapStageDelayMs: 0,
    bootstrapDisabled,
    favoriteMaxConcurrent: 1,
    favoriteIntervalMs: 60 * 60 * 1_000,
    browserSidecarUrl: '',
    favoriteJitterMs: 0,
    liveScrapeTtlMs: 6 * 60 * 60 * 1_000,
    liveScrapeConcurrency: 1,
    liveScrapeHostLimit: 4,
  };
}

describe('D20 auto-bootstrap (offline, real pipelines, real mock script)', (): void => {
  it('empty data dir → module sync → registry sweep → catalog install → ready', async (): Promise<void> => {
    const e2e = e2eConstants();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-data-'));
    const logs: string[] = [];
    const runtime = await buildRuntime({
      config: runtimeConfig(dataDir, mock.base),
      log: (message): void => {
        logs.push(message);
      },
      version: '0.1.0-test',
    });

    // Readiness is gated BEFORE the bootstrap completes.
    const before = await runtime.app.inject({ method: 'GET', url: '/readyz' });
    expect(before.statusCode).toBe(503);
    expect(before.json()).toMatchObject({ ready: false });

    await runtime.bootstrap.run();

    expect(logs).toContainEqual(expect.stringContaining('bootstrap: empty data dir — running module sync'));
    expect(logs).toContainEqual(expect.stringContaining(`module sync installed sha ${e2e.luaSha.slice(0, 10)}`));
    expect(logs).toContainEqual(expect.stringContaining('registry ready'));
    expect(logs).toContainEqual(expect.stringContaining('catalog update check — head 5eed000000'));
    expect(logs).toContainEqual(expect.stringContaining(`catalog ${e2e.catalogId} updated`));
    expect(logs).toContainEqual(expect.stringContaining('bootstrap: done'));

    // The REAL §6.1 pipeline ran: the commits check hit the mock upstream
    // (request log — no shortcut), then the crafted .7z blob.
    const mockLog = await (await fetch(`${mock.base}/_requests`)).json() as { requests: { path: string }[] };
    const paths = mockLog.requests.map((r) => r.path);
    expect(paths.some((p) => p.startsWith('/api-github/repos/dazedcat19/FMD2-DB/commits'))).toBe(true);
    expect(paths.some((p) => p.startsWith(`/FMD2-DB/master/7z/${e2e.catalogId}.7z`))).toBe(true);

    // The lua tree landed through the REAL sync pipeline.
    expect(fs.existsSync(path.join(dataDir, 'lua', 'modules', 'E2ESeed.lua'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'lua', 'utils', 'e2eutil.lua'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'sync-state.json'))).toBe(true);

    // /readyz flipped.
    const after = await runtime.app.inject({ method: 'GET', url: '/readyz' });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ ready: true });

    // Registry: the seed module registered.
    const modules = runtime.services.modules.list();
    expect(modules.map((m) => m.id)).toContain(e2e.catalogId);
    const seed = modules.find((m) => m.id === e2e.catalogId);
    expect(seed?.name).toBe(e2e.moduleName);

    // Catalogs: browsable + searchable through the installed db.
    expect(runtime.services.catalogs.getMeta(e2e.catalogId)).toBeDefined();
    const latest = runtime.services.catalogs.latest(e2e.catalogId, { limit: 20 });
    expect(latest.total).toBe(5);
    expect(latest.entries[0]?.title).toBe('Alpha Quest');
    const search = runtime.services.catalogs.search(e2e.catalogId, { query: 'alpha', limit: 20 });
    expect(search.entries.map((entry) => entry.title)).toEqual(['Alpha Quest']);

    // Catalog browse over the API layer (real store behind the routes).
    const latestApi = await runtime.app.inject({
      method: 'GET',
      url: `/api/catalog/${e2e.catalogId}/latest?limit=20`,
    });
    expect(latestApi.statusCode).toBe(200);
    const page = latestApi.json();
    expect(page.total).toBe(5);
    expect(page.entries[0].link).toBe(`${mock.base}/manga/alpha-quest`);

    await runtime.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it('defaults only (no FMD2_*/FMD_BOOTSTRAP_* env): empty data dir → >=4 curated catalogs → ready', async (): Promise<void> => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-defaults-'));
    const logs: string[] = [];
    // Everything default: default pin (DEFAULT_FMD2_PIN_SHA), default
    // repo, default (curated) bootstrap catalogs — only the network
    // endpoints point at the loopback mock (tests never leave the box).
    const config = loadRuntimeConfig({
      FMD_WEB_DATA_DIR: dataDir,
      PORT: '0',
      FMD2_CODELOAD_URL: `${mock.base}/codeload`,
      FMD2_TARBALL_API_BASE: `${mock.base}/api-github`,
      FMD_DB_URL: `${mock.base}/FMD2-DB/master`,
      FMD_DB_API_BASE: `${mock.base}/api-github`,
    });
    expect(config.bootstrapCatalogIds).toEqual([...DEFAULT_BOOTSTRAP_CATALOGS]);
    expect(config.moduleSync.sha).toBe(DEFAULT_FMD2_PIN_SHA);
    expect(config.moduleSync.tarballApiBaseUrl).toBe(`${mock.base}/api-github`);

    const runtime = await buildRuntime({
      config,
      log: (message): void => {
        logs.push(message);
      },
      version: '0.1.0-test',
    });
    await runtime.bootstrap.run();

    // The default ID list is what got installed (>=4 curated catalogs,
    // each actually fetched through the §6.2 pipeline from the mock).
    expect(logs).toContainEqual(expect.stringContaining('bootstrap: done'));
    const mockLog = await (await fetch(`${mock.base}/_requests`)).json() as { requests: { path: string }[] };
    const paths = mockLog.requests.map((r) => r.path);
    for (const id of DEFAULT_BOOTSTRAP_CATALOGS) {
      expect(paths).toContain(`/FMD2-DB/master/7z/${id}.7z`);
    }
    expect(DEFAULT_BOOTSTRAP_CATALOGS.length).toBeGreaterThanOrEqual(4);

    // readyz green + every default catalog browsable through its db.
    const ready = await runtime.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    let installed = 0;
    for (const id of DEFAULT_BOOTSTRAP_CATALOGS) {
      const meta = runtime.services.catalogs.getMeta(id);
      if (meta !== undefined) {
        installed += 1;
      }
      const page = await runtime.app.inject({ method: 'GET', url: `/api/catalog/${id}/latest?limit=5` });
      expect(page.statusCode).toBe(200);
    }
    expect(installed).toBe(DEFAULT_BOOTSTRAP_CATALOGS.length);

    await runtime.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it('live info: module GetInfo against the mock upstream, §5.8-normalized', async (): Promise<void> => {
    const e2e = e2eConstants();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-data-'));
    const runtime = await buildRuntime({
      config: runtimeConfig(dataDir, mock.base),
      log: (): void => undefined,
      version: '0.1.0-test',
    });
    await runtime.bootstrap.run();

    const info = await runtime.services.info.getInfo(
      e2e.catalogId,
      `${mock.base}/manga/alpha-quest`,
    );
    expect(info.title).toBe('Alpha Quest');
    expect(info.authors).toBe('Alpha Author');
    expect(info.genres).toBe('Action, Adventure');
    expect(info.status).toBe('Ongoing');
    expect(info.numChapter).toBe(3);
    // isRemoveHostFromChapterLinks (uData.pas) strips the mock host.
    expect(info.chapterLinks).toEqual([
      '/manga/alpha-quest/ch/3',
      '/manga/alpha-quest/ch/2',
      '/manga/alpha-quest/ch/1',
    ]);
    expect(info.chapterNames[0]).toBe('Chapter 3: The Finale');

    // The request REALLY went out (mock request log — no recorded-fixture shortcut).
    const log = await (await fetch(`${mock.base}/_requests`)).json() as { requests: { path: string }[] };
    expect(log.requests.map((r) => r.path)).toContain('/manga/alpha-quest');

    // Unknown module id → typed 404.
    await expect(runtime.services.info.getInfo('ffffffffffffffffffffffffffffffff', '/x')).rejects.toMatchObject({
      status: 404,
    });

    await runtime.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it('dry-run enqueue → job visible queued (§7.1 in-memory §10 store)', async (): Promise<void> => {
    const e2e = e2eConstants();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-data-'));
    const runtime = await buildRuntime({
      config: runtimeConfig(dataDir, mock.base),
      log: (): void => undefined,
      version: '0.1.0-test',
    });
    await runtime.bootstrap.run();

    const create = await runtime.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: {
        moduleId: e2e.catalogId,
        mangaUrl: `${mock.base}/manga/alpha-quest`,
        mangaTitle: 'Alpha Quest',
        chapterLink: '/manga/alpha-quest/ch/1',
        chapterName: 'Chapter 1: The Beginning',
        idempotencyKey: 'e2e-dry-run-1',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().job.state).toBe('queued');

    const list = await runtime.app.inject({ method: 'GET', url: '/api/jobs?limit=20' });
    expect(list.statusCode).toBe(200);
    const page = list.json();
    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0].state).toBe('queued');
    expect(page.jobs[0].payload.mangaTitle).toBe('Alpha Quest');

    // Idempotent replay: same key + payload → original job, 200.
    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: {
        moduleId: e2e.catalogId,
        mangaUrl: `${mock.base}/manga/alpha-quest`,
        mangaTitle: 'Alpha Quest',
        chapterLink: '/manga/alpha-quest/ch/1',
        chapterName: 'Chapter 1: The Beginning',
        idempotencyKey: 'e2e-dry-run-1',
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().job.id).toBe(create.json().job.id);

    await runtime.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it('populated data dir: bootstrap skips the syncs and re-reads the installed state', async (): Promise<void> => {
    const e2e = e2eConstants();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-data-'));
    const first = await buildRuntime({
      config: runtimeConfig(dataDir, mock.base),
      log: (): void => undefined,
      version: '0.1.0-test',
    });
    await first.bootstrap.run();
    await first.dispose();

    const upstreamRequests = async (): Promise<number> => {
      const log = await (await fetch(`${mock.base}/_requests`)).json() as { requests: { path: string }[] };
      // /_requests itself is recorded — count only upstream traffic.
      return log.requests.filter((r) => r.path !== '/_requests').length;
    };
    const before = await upstreamRequests();

    const logs: string[] = [];
    const second = await buildRuntime({
      config: runtimeConfig(dataDir, mock.base),
      log: (message): void => {
        logs.push(message);
      },
      version: '0.1.0-test',
    });
    await second.bootstrap.run();
    expect(logs).toContainEqual(expect.stringContaining('already installed — module sync skipped'));
    expect(logs).toContainEqual(expect.stringContaining(`catalog ${e2e.catalogId} already installed`));
    expect(logs.some((entry) => entry.includes('catalog update check'))).toBe(false);

    const after = await upstreamRequests();
    expect(after).toBe(before); // zero upstream traffic

    const latest = second.services.catalogs.latest(e2e.catalogId, { limit: 20 });
    expect(latest.entries[0]?.title).toBe('Alpha Quest');

    await second.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it('FMD_BOOTSTRAP_DISABLE=1: empty data dir → zero sync work, /readyz green', async (): Promise<void> => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-runtime-data-'));
    const logs: string[] = [];
    const upstreamRequests = async (): Promise<string[]> => {
      const log = await (await fetch(`${mock.base}/_requests`)).json() as { requests: { path: string }[] };
      // /_requests itself is recorded — count only upstream traffic.
      return log.requests.filter((r) => r.path !== '/_requests').map((r) => r.path);
    };
    const beforePaths = await upstreamRequests();

    const runtime = await buildRuntime({
      config: runtimeConfig(dataDir, mock.base, true),
      log: (message): void => {
        logs.push(message);
      },
      version: '0.1.0-test',
    });

    await runtime.bootstrap.run();

    // The disable switch short-circuits the bootstrap — the operator
    // owns provisioning, so NO stage of the first-run sync fires.
    expect(logs).toContainEqual(expect.stringContaining('bootstrap: disabled (FMD_BOOTSTRAP_DISABLE=1)'));
    expect(logs.some((entry) => entry.includes('empty data dir — running module sync'))).toBe(false);
    expect(logs.some((entry) => entry.includes('registry ready'))).toBe(false);
    expect(logs.some((entry) => entry.includes('syncing catalog'))).toBe(false);

    // Zero sync jobs enqueued (the queue stays empty) and zero
    // upstream traffic (the §6.1 commits check never fires either).
    const page = runtime.services.jobs.list({ limit: 1000 });
    expect(page.jobs).toHaveLength(0);
    expect(await upstreamRequests()).toEqual(beforePaths);

    // No artifacts were provisioned into the empty data dir.
    expect(fs.existsSync(path.join(dataDir, 'lua', 'modules'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'catalogs'))).toBe(false);

    // /readyz is STILL green: bootstrap done + probe without the
    // lua-tree check (the deployment owns provisioning).
    const ready = await runtime.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true });
    // Live info stays honest about the unprovisioned registry.
    await expect(
      runtime.services.info.getInfo('ffffffffffffffffffffffffffffffff', '/x'),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('FMD_BOOTSTRAP_DISABLE=1') });

    await runtime.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);
});

describe('runtime config (env surface)', (): void => {
  it('loadRuntimeConfig: data dir, bootstrap catalogs, allow-lists, defaults', (): void => {
    const config = loadRuntimeConfig({
      FMD_WEB_DATA_DIR: '/tmp/fmd-data',
      PORT: '3123',
      FMD2_LUA_SHA: e2eConstants().luaSha,
      FMD_BOOTSTRAP_CATALOGS: 'aaaa,bbbb',
      FMD_HTTP_ALLOW_HOSTS: 'e2e-mock',
      FMD_DB_URL: 'http://e2e-mock:8081/FMD2-DB/db',
      FMD_STATIC_DIR: '/tmp/fmd-web-dist',
    });
    expect(config.dataDir).toBe('/tmp/fmd-data');
    expect(config.port).toBe(3123);
    expect(config.bootstrapCatalogIds).toEqual(['aaaa', 'bbbb']);
    expect(config.httpAllowedHosts).toEqual(['e2e-mock']);
    expect(config.staticDir).toBe('/tmp/fmd-web-dist');
    expect(config.moduleSync.dataDir).toBe('/tmp/fmd-data');

    const defaults = loadRuntimeConfig({});
    expect(defaults.port).toBe(3000);
    expect(defaults.staticDir).toBeUndefined();
    // Curated, live-verified defaults (launch defect (c)) — the env csv
    // overrides them entirely (asserted above with 'aaaa,bbbb').
    expect(defaults.bootstrapCatalogIds).toEqual([...DEFAULT_BOOTSTRAP_CATALOGS]);
    expect(defaults.dbUrl).toBeUndefined(); // CatalogSync composes the corrected default
    expect(defaults.httpAllowedHosts).toEqual([]);
    expect(defaults.bootstrapDisabled).toBe(false);

    // D20 disable switch: exactly '1' disables; other values keep the default.
    expect(loadRuntimeConfig({ FMD_BOOTSTRAP_DISABLE: '1' }).bootstrapDisabled).toBe(true);
    expect(loadRuntimeConfig({ FMD_BOOTSTRAP_DISABLE: '0' }).bootstrapDisabled).toBe(false);
    expect(loadRuntimeConfig({ FMD_BOOTSTRAP_DISABLE: '' }).bootstrapDisabled).toBe(false);
  });
});

describe('SPA static serving (runtime/static.ts)', (): void => {
  function staticApp(distDir: string): { app: ReturnType<typeof buildApp>; services: ApiServices } {
    const services = createDefaultServices();
    const app = buildApp(services, { version: '0.1.0-test' });
    registerStatic(app, distDir);
    return { app, services };
  }

  it('serves index + assets with content types; API routes stay ahead; SPA fallback', async (): Promise<void> => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-static-'));
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>fmd</title><div id="app"></div>');
    fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("spa")');
    const { app } = staticApp(dist);

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');
    expect(root.body).toContain('<div id="app">');

    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.body).toContain('console.log');

    // Deep link / asset miss → SPA fallback (hash routing renders client-side).
    const fallback = await app.inject({ method: 'GET', url: '/some/missing/path' });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toContain('<div id="app">');

    // API 404 envelope still wins over the fallback (registered first).
    const apiMiss = await app.inject({ method: 'GET', url: '/api/definitely-missing' });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.json()).toMatchObject({ error: { code: 'not_found' } });

    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('traversal is jailed to the dist dir', async (): Promise<void> => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-static-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>fmd</title>');
    const { app } = staticApp(dist);

    const evil = await app.inject({ method: 'GET', url: '/..%2f..%2f..%2fetc%2fpasswd' });
    expect(evil.statusCode).toBe(200);
    expect(evil.body).toBe('<!doctype html><title>fmd</title>'); // fallback, not the file

    fs.rmSync(dist, { recursive: true, force: true });
  });
});
