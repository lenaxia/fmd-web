import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ReadinessStatus } from '@fmd/contract';
import { buildApp, type ApiServices, type AppOptions, DEFAULT_INFO_CACHE_TTL_MS } from '../api/app.js';
import {
  type CatalogSyncOutcome,
  type InfoService,
  type JobService,
  type ModuleService,
  type NormalizedInfo,
  type SyncModulesOutcome,
  type SyncService,
} from '../api/services.js';
import { ApiError } from '../api/errors.js';
import { WsHub } from '../api/ws/hub.js';
import { EngineInfoService } from './engine-info.js';
import { EngineLoginDriver } from './account-login.js';
import { SqliteAccountService } from '../accounts/account-service.js';
import { SqliteAccountStore } from '../accounts/account-store.js';
import { BootstrapRunner } from './bootstrap.js';
import {
  FmdMetrics,
  InstrumentedJobQueue,
  InstrumentedSyncService,
  ReadinessProbe,
  StructuredLogger,
  composeReadiness,
  type CorpusPassRateEntry,
} from '../observability/index.js';
import { EgressPolicy } from '../engine/shims/http-egress.js';
import { normalizeProxyConfig, type ProxyConfig } from '../engine/shims/http-proxy.js';
import { FlareSolverrBypassExecutor } from '../engine/sidecar/bypass-adapter.js';
import { LoopbackHttpTransport } from '../engine/shims/http-transport.js';
import { ModuleStateService, type ModuleSharedState } from '../engine/state/module-state.js';
import { StartupRegistryService } from '../engine/registry/startup.js';
import { ModuleSyncService as RegistrySweep } from '../engine/registry/module-sync.js';
import { InMemoryModuleRegistryPersistence } from '../engine/registry/persistence.js';
import type { RegistrationRecord } from '../engine/registry/capabilities.js';
import type { ModuleSummaryT, OptionValueT } from '../api/schemas.js';
import { createModuleSyncService } from '../sync/modules/service.js';
import { loadModuleSyncConfig, type ModuleSyncConfig } from '../sync/modules/config.js';
import { CatalogSync } from '../sync/db/sync-service.js';
import { DEFAULT_LIVE_SCRAPE_TTL_MS, LiveScrapeCatalogStore } from '../catalog/live-scrape-store.js';
import { UpdateLaneScrapeGate } from '../catalog/update-lane-gate.js';
import { EngineDirectoryWalker } from '../catalog/directory-walk.js';
import { SyncHostGate } from '../engine/shims/http-hostgate.js';
import type { CatalogFileStore } from '../sync/db/catalog-store.js';
import { InMemoryModuleService, InMemorySettingsService } from '../api/services.js';
import { openQueueDb, ensureJobSchema } from '../jobs/queue/connection.js';
import { SqliteJobQueue } from '../jobs/queue/queue.js';
import { SqliteLibraryStore } from '../jobs/library/store.js';
import {
  ActiveDownloadRegistry,
  PublishingJobQueue,
  RuntimeJobService,
  startDownloadLane,
  toJobWire,
} from './download-lane.js';
import type { LaneRunner } from '../jobs/queue/queue.js';
import { SqliteLibraryService } from './library-service.js';
import { SqliteFavoritesService } from './favorites-service.js';
import { FavoritesEngine } from '../jobs/favorites/engine.js';
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_JITTER_MS,
  DEFAULT_MAX_CONCURRENT,
  FavoriteScheduler,
} from '../jobs/favorites/scheduler.js';

/**
 * The PRODUCTION service assembly (DESIGN §4/§9/§10): the real module
 * sync, catalog sync, engine-backed live info and registry boot wired
 * into the §10 ports. Documented stand-ins (until their stories land):
 * the job queue is the in-memory §10 store (SQLite queue = jobs story)
 * and the registry persistence re-sweeps per boot (SQLite module_state
 * = db story). Everything else is the shipped Phase-2 pipeline.
 */

export interface RuntimeConfig {
  readonly dataDir: string;
  readonly port: number;
  /** SPA dist dir served at `/` (undefined = API-only). */
  readonly staticDir: string | undefined;
  readonly moduleSync: ModuleSyncConfig;
  /** Catalog blob base (`<dbUrl>/7z/<ID>.7z`); default = the pinned repo. */
  readonly dbUrl: string | undefined;
  /** Commits API base; default = api.github.com. */
  readonly dbApiBase: string | undefined;
  /** D20 bootstrap catalogs (FMD_BOOTSTRAP_CATALOGS, csv). */
  readonly bootstrapCatalogIds: readonly string[];
  /** Extra (non-loopback) hosts module HTTP may reach (compose mock). */
  readonly httpAllowedHosts: readonly string[];
  /** D20 stage pacing for demo/e2e observability (FMD_BOOTSTRAP_DELAY_MS). */
  readonly bootstrapStageDelayMs: number;
  /**
   * D20 disable switch (FMD_BOOTSTRAP_DISABLE=1): the first-run
   * module+catalog sync is skipped entirely — the bootstrap
   * short-circuits to done, the lua-tree readiness check is dropped
   * (the operator owns provisioning on an empty data dir) and /readyz
   * is green. Unset/false = the auto-bootstrap default.
   */
  readonly bootstrapDisabled: boolean;
  /** §7.2 favorites scheduler: max checks in flight (OptionMaxFavoriteThreads analog). */
  readonly favoriteMaxConcurrent: number;
  /** §7.2 favorites scheduler: per-favorite interval (OptionAutoCheckFavIntervalMinutes analog). */
  readonly favoriteIntervalMs: number;
  /** §7.2 favorites scheduler: random per-check extra delay. */
  readonly favoriteJitterMs: number;
  /**
   * §5.11 browser sidecar profile: non-empty = the compose `browser`
   * profile is active (FMD_WEB_BROWSER_SIDECAR_URL, e.g.
   * http://flaresolverr:8191) — the BypassExecutor adapter is wired,
   * the subprocess stub routes to it, and the satisfied §5.10
   * known-broken flags flip in /api/modules. Empty = known-broken stand.
   */
  readonly browserSidecarUrl: string;
  /** §6.8 live-scrape cache TTL (FMD_CATALOG_LIVE_TTL_MS, default 6 h). */
  readonly liveScrapeTtlMs: number;
  /** §6.8 update-lane scrape slot budget (FMD_CATALOG_LIVE_CONCURRENCY, default 2). */
  readonly liveScrapeConcurrency: number;
  /** §6.8 per-host connection gate limit for scrape page fetches (FMD_CATALOG_LIVE_HOST_LIMIT, default 4). */
  readonly liveScrapeHostLimit: number;
}

function csvEnv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function loadRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const dataDir = resolve(
    env['FMD_WEB_DATA_DIR'] ?? env['FMD_DATA_DIR'] ?? join(process.cwd(), 'data'),
  );
  const portRaw = env['PORT'] ?? '';
  const parsedPort = portRaw !== '' ? Number.parseInt(portRaw, 10) : 3000;
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
  const staticDir = env['FMD_STATIC_DIR'];
  const delayRaw = env['FMD_BOOTSTRAP_DELAY_MS'] ?? '';
  const delayParsed = delayRaw !== '' ? Number.parseInt(delayRaw, 10) : 0;  const favThreadsRaw = env['FMD_FAVORITE_THREADS'] ?? '';
  const favThreadsParsed = favThreadsRaw !== '' ? Number.parseInt(favThreadsRaw, 10) : DEFAULT_MAX_CONCURRENT;
  const favIntervalRaw = env['FMD_FAVORITE_INTERVAL_MS'] ?? '';
  const favIntervalParsed = favIntervalRaw !== '' ? Number.parseInt(favIntervalRaw, 10) : DEFAULT_INTERVAL_MS;
  const favJitterRaw = env['FMD_FAVORITE_JITTER_MS'] ?? '';
  const favJitterParsed = favJitterRaw !== '' ? Number.parseInt(favJitterRaw, 10) : DEFAULT_JITTER_MS;
  return {
    dataDir,
    port,
    staticDir: staticDir !== undefined && staticDir !== '' ? resolve(staticDir) : undefined,
    moduleSync: loadModuleSyncConfig({ ...env, FMD_DATA_DIR: dataDir }),
    dbUrl: env['FMD_DB_URL'],
    dbApiBase: env['FMD_DB_API_BASE'],
    bootstrapCatalogIds: csvEnv(env['FMD_BOOTSTRAP_CATALOGS']),
    httpAllowedHosts: csvEnv(env['FMD_HTTP_ALLOW_HOSTS']),
    bootstrapStageDelayMs: Number.isInteger(delayParsed) && delayParsed > 0 ? delayParsed : 0,
    // Exactly '1' disables (D20 disable switch); every other value keeps
    // the auto-bootstrap default.
    bootstrapDisabled: env['FMD_BOOTSTRAP_DISABLE'] === '1',
    favoriteMaxConcurrent:
      Number.isInteger(favThreadsParsed) && favThreadsParsed > 0 ? favThreadsParsed : DEFAULT_MAX_CONCURRENT,
    favoriteIntervalMs:
      Number.isInteger(favIntervalParsed) && favIntervalParsed > 0 ? favIntervalParsed : DEFAULT_INTERVAL_MS,
    favoriteJitterMs:
      Number.isInteger(favJitterParsed) && favJitterParsed > 0 ? favJitterParsed : DEFAULT_JITTER_MS,
    browserSidecarUrl: (env['FMD_WEB_BROWSER_SIDECAR_URL'] ?? '').trim(),
    liveScrapeTtlMs: positiveIntEnv(env['FMD_CATALOG_LIVE_TTL_MS'], DEFAULT_LIVE_SCRAPE_TTL_MS),
    liveScrapeConcurrency: positiveIntEnv(env['FMD_CATALOG_LIVE_CONCURRENCY'], 2),
    liveScrapeHostLimit: positiveIntEnv(env['FMD_CATALOG_LIVE_HOST_LIMIT'], 4),
  };
}

/** Integer env helper: absent/invalid → default (§6.8 knobs are loose —
 * a bad value must not break boot). */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface RuntimeAssembly {
  readonly app: ReturnType<typeof buildApp>;
  readonly services: ApiServices;
  readonly bootstrap: BootstrapRunner;
  readonly sweep: RegistrySweep;
  /**
   * §10/D19 job-event hub. The raw-http entry (runtime-entry.ts) must
   * `attachWebSocketHub(its server, this hub)` — upgrades bypass the
   * respondAsync bridge; job/progress publishers call `wsHub.publish`.
   */
  readonly wsHub: WsHub;
  /** The download lane runner (drain: stop claiming, in-flight settles). */
  readonly lane: LaneRunner;
  /** §7.2 favorites scheduler (bounded concurrency + interval + jitter). */
  readonly favoritesScheduler: FavoriteScheduler;
  /** Live chapter runs by job id (the cancel endpoint's reach-in). */
  readonly active: ActiveDownloadRegistry;
  /** §4/§15 metrics registry façade (rendered by GET /api/metrics). */
  readonly metrics: FmdMetrics;
  /** §4 structured JSON logger (module-id correlation, dedup bound). */
  readonly logger: StructuredLogger;
  /** Drain: dispose engines + transport + catalog handles + the WS hub. */
  dispose(): Promise<void>;
}

export interface BuildRuntimeOptions {
  readonly config: RuntimeConfig;
  readonly log: (message: string) => void;
  readonly version: string;
  /**
   * §15 corpus pass-rate provider (the nightly corpus run publishes
   * per-module rates; the runtime exports them at scrape). Optional —
   * without it the `fmd_corpus_pass_rate` family stays empty until a
   * corpus report lands.
   */
  readonly corpusPassRates?: () => readonly CorpusPassRateEntry[];
}

/** Module registry that can be refreshed after a (re-)sync (swap-in). */
class RefreshableModuleService implements ModuleService {
  private current: InMemoryModuleService;

  constructor(
    rows: readonly RegistrationRecord[],
    private readonly browserProfileEnabled: boolean = false,
  ) {
    this.current = new InMemoryModuleService(rows, browserProfileEnabled);
  }

  refresh(rows: readonly RegistrationRecord[]): void {
    this.current = new InMemoryModuleService(rows, this.browserProfileEnabled);
  }

  list(): ModuleSummaryT[] {
    return this.current.list();
  }

  get(id: string): ModuleSummaryT | undefined {
    return this.current.get(id);
  }

  update(
    id: string,
    patch: {
      enabled?: boolean;
      options?: Record<string, OptionValueT>;
      cookies?: string;
      proxy?: import('../api/schemas.js').ProxySettingsT | null;
    },
  ): ModuleSummaryT {
    return this.current.update(id, patch);
  }

  /** Settings seam: the per-module proxy override (§9/§10). */
  getProxyOverride(id: string): import('../api/schemas.js').ProxySettingsT | null {
    return this.current.getProxyOverride(id);
  }
}

interface SweepOutcomeShape {
  readonly treeSha: string;
  readonly modules: readonly RegistrationRecord[];
}

export async function buildRuntime(options: BuildRuntimeOptions): Promise<RuntimeAssembly> {
  const { config, log, version } = options;
  const luaRoot = join(config.dataDir, 'lua');

  // ── observability (§4/§15) ─────────────────────────────────────────
  // Structured JSON logs (module-id correlation, expression-failure
  // WARN dedup: max 1 per (module, expression-template) per run) +
  // the Prometheus registry rendered by GET /api/metrics. The legacy
  // `fmd: …` plain lines stay (compose/e2e log assertions) alongside
  // the structured stream.
  const logger = new StructuredLogger();
  const metrics = new FmdMetrics();
  metrics.bindExpressionDedup(() => logger.dedupStats());
  metrics.bindProcessMemory();
  metrics.registry.onScrape(() => {
    const rates = options.corpusPassRates?.() ?? [];
    if (rates.length > 0) {
      metrics.setCorpusPassRates(rates);
    }
  });

  // ── live HTTP path (module engine) ─────────────────────────────────
  // Loopback hosts are always allowed (local mock servers, DESIGN §13);
  // FMD_HTTP_ALLOW_HOSTS adds the compose e2e mock containers. The
  // transport ALSO refuses any host outside loopback ∪ the allow-list,
  // so the egress policy is enforced twice (shim + transport).
  const transport = new LoopbackHttpTransport({ allowedHosts: config.httpAllowedHosts });
  const egress = new EgressPolicy({
    allow: [...config.httpAllowedHosts, '127.0.0.1', 'localhost', '::1'],
  });

  // ── §5.3 per-module shared state (audit F-2) ────────────────────────
  // ONE state service per process: the module cookie jar backs BOTH the
  // MODULE cookie methods (AddServerCookies/GetServerCookies/
  // RemoveCookies/ClearCookies) and every module HTTP object's
  // request-cookie injection, persisted to module_state (§9). The
  // in-memory adapter gives process-lifetime persistence; the app.db
  // adapter stays the db story's boundary (see the accounts comment).
  const moduleStateService = new ModuleStateService();
  const moduleState = (moduleId: string): Promise<ModuleSharedState> =>
    moduleStateService.forModule(moduleId);

  // ── sync services ──────────────────────────────────────────────────
  const moduleSync = createModuleSyncService(config.moduleSync);
  const sweep = new RegistrySweep({ luaRoot });
  // A fresh startup service per boot: in-memory persistence means every
  // boot sweeps (§9 SHA-gated caching resumes with the SQLite
  // module_state story) — and a manual re-sync after a tree swap gets a
  // fresh sweep instead of the memoized registry.
  let registry = new StartupRegistryService(sweep, new InMemoryModuleRegistryPersistence());
  const catalogSync = new CatalogSync({
    dataDir: config.dataDir,
    ...(config.dbUrl !== undefined ? { dbUrl: config.dbUrl } : {}),
    ...(config.dbApiBase !== undefined ? { apiBase: config.dbApiBase } : {}),
    knownCatalogIds: (): readonly string[] => config.bootstrapCatalogIds,
  });

  // ── registry state (empty until bootstrap's sweep lands) ───────────
  let moduleRows: readonly RegistrationRecord[] = [];
  let booted = false;
  const bootRegistry = async (): Promise<{ source: string; modules: number; summary?: SweepOutcomeShape }> => {
    registry = new StartupRegistryService(sweep, new InMemoryModuleRegistryPersistence());
    const result = await registry.boot();
    moduleRows = result.modules;
    booted = true;
    return {
      source: result.source,
      modules: result.modules.length,
      // SweepSummary counts are the fresh-sweep projection; cache boots
      // (SHA unchanged) get the coarse shape instead.
      ...(result.source === 'sweep'
        ? { summary: { treeSha: result.treeSha, modules: result.modules } }
        : {}),
    };
  };

  // ── §9/§10 settings + §5.11 browser sidecar profile ────────────────
  // Non-empty FMD_WEB_BROWSER_SIDECAR_URL = the compose `browser`
  // profile is active: wire the BypassExecutor adapter (bounded
  // concurrency 2, 60 s budget, health-gated), route the subprocess
  // stub to it, and flip the satisfied §5.10 known-broken flags in the
  // API projection. Without it the adapter is undefined and the denied
  // stub + known-broken flags stand.
  const browserProfileEnabled = config.browserSidecarUrl !== '';
  const moduleService = new RefreshableModuleService([], browserProfileEnabled);
  const bypass = browserProfileEnabled
    ? new FlareSolverrBypassExecutor({ baseUrl: config.browserSidecarUrl })
    : undefined;
  const settings = new InMemorySettingsService(moduleService, config.browserSidecarUrl);
  const proxyFor = (moduleId: string): ProxyConfig | undefined => {
    const effective = settings.effectiveProxy(moduleId);
    return effective === undefined
      ? undefined
      : normalizeProxyConfig(effective.type, effective.host, effective.port, effective.user, effective.pass);
  };

  const info = new EngineInfoService({
    luaRoot,
    modules: (): readonly RegistrationRecord[] => moduleRows,
    transport,
    egress,
    moduleState,
    // §4/§5.6: the run's shared expression-failure deduper (max 1 WARN
    // per module+expression-template per run) + the structured-log tee
    // (module print routing + swallow WARNs land as JSON lines).
    swallowDeduper: logger.expressionDedup,
    logSink: (record): void => {
      const scoped = logger.forModule(record.moduleId === '' ? '(host)' : record.moduleId);
      if (record.level === 'warn') {
        scoped.warn(record.message, { event: 'engine_log' });
      } else if (record.level === 'error') {
        scoped.error(record.message, { event: 'engine_log' });
      } else {
        scoped.info(record.message, { event: 'engine_log' });
      }
    },
    proxyFor,
    ...(bypass !== undefined ? { bypass } : {}),
  });
  const infoService: InfoService = {
    getInfo: async (moduleId: string, url: string): Promise<NormalizedInfo> => {
      if (!booted) {
        throw new ApiError(
          503,
          'upstream_error',
          config.bootstrapDisabled
            ? 'module registry not provisioned (FMD_BOOTSTRAP_DISABLE=1) — run POST /api/sync/modules'
            : 'first-run bootstrap still running (registry not ready)',
        );
      }
      return info.getInfo(moduleId, url);
    },
  };

  // ── §6.8 live-scrape fallback (browse without an FMD2-DB catalog) ──
  // The walker drives the real module directory events (§5.2) through
  // one engine per walk; every scrape acquires an UPDATE-lane slot
  // (never a download slot) and every page fetch passes the per-host
  // connection gate. Catalog arrival invalidates the cache and the
  // API's catalog-first lookup order flips the module back.
  const liveScrapeGate = new UpdateLaneScrapeGate(config.liveScrapeConcurrency);
  const liveScrapeWalker = new EngineDirectoryWalker({
    luaRoot,
    modules: (): readonly RegistrationRecord[] => moduleRows,
    transport,
    egress,
    moduleState,
    hostGate: new SyncHostGate({ limit: config.liveScrapeHostLimit }),
    swallowDeduper: logger.expressionDedup,
    logSink: (record): void => {
      const scoped = logger.forModule(record.moduleId === '' ? '(host)' : record.moduleId);
      if (record.level === 'warn') {
        scoped.warn(record.message, { event: 'engine_log' });
      } else if (record.level === 'error') {
        scoped.error(record.message, { event: 'engine_log' });
      } else {
        scoped.info(record.message, { event: 'engine_log' });
      }
    },
    proxyFor,
    ...(bypass !== undefined ? { bypass } : {}),
  });
  const catalogFallback = new LiveScrapeCatalogStore({
    walk: liveScrapeWalker,
    modules: (): readonly RegistrationRecord[] => moduleRows,
    laneGate: liveScrapeGate,
    ttlMs: config.liveScrapeTtlMs,
  });

  // ── job queue + download lane (§4/§7.1, SQLite) ────────────────────
  // app.db holds BOTH the §9 `job` table (queue) and the library
  // tables (§7.1) — one writer connection each, WAL discipline from
  // openQueueDb. The PublishingJobQueue wrapper mirrors every mutation
  // into the §10 WS hub; RuntimeJobService layers the §10 idempotency
  // semantics (terminal re-enqueue chains) over the raw queue.
  const active = new ActiveDownloadRegistry();
  const wsHub = new WsHub();
  // The db opens BEFORE the D20 bootstrap creates its subdirs — make
  // sure the data dir exists (§4: writer connections create the file).
  mkdirSync(config.dataDir, { recursive: true });
  const db = openQueueDb(join(config.dataDir, 'app.db'));
  ensureJobSchema(db);
  const sqliteQueue = new SqliteJobQueue({ file: join(config.dataDir, 'app.db'), recoverOnOpen: true });
  const publishingQueue = new PublishingJobQueue(sqliteQueue, (job): void => {
    wsHub.publish(toJobWire(job));
  });
  // §4 job counters: the instrumented wrapper sits OUTSIDE the WS
  // publisher so every mutation (WS-mirrored or not) feeds the series,
  // and the depth/state gauges snapshot the LIVE queue at scrape.
  const queue = new InstrumentedJobQueue(publishingQueue, metrics);
  const libraryStore = new SqliteLibraryStore({ db, libraryRoot: join(config.dataDir, 'library') });
  const libraryService = new SqliteLibraryService(libraryStore);
  const jobs: JobService = new RuntimeJobService(queue, (jobId): boolean => active.cancel(jobId));
  const lane = startDownloadLane(queue, {
    wsHub,
    library: libraryStore,
    dataDir: config.dataDir,
    engine: {
      luaRoot,
      modules: (): readonly RegistrationRecord[] => moduleRows,
      transport,
      egress,
      moduleState,
      proxyFor,
      ...(bypass !== undefined ? { bypass } : {}),
      swallowDeduper: logger.expressionDedup,
      logSink: (record): void => {
        const scoped = logger.forModule(record.moduleId === '' ? '(host)' : record.moduleId);
        if (record.level === 'warn') {
          scoped.warn(record.message, { event: 'engine_log' });
        } else if (record.level === 'error') {
          scoped.error(record.message, { event: 'engine_log' });
        } else {
          scoped.info(record.message, { event: 'engine_log' });
        }
      },
    },
    active,
    log,
  });

  // ── favorites engine + scheduler (§7.2/D8) ─────────────────────────
  // DoCheck parity over the app.db store; auto-download enqueues
  // through the SAME §10 job service the download route uses (Phase-3
  // pipeline). The scheduler enforces OptionMaxFavoriteThreads (bounded
  // slots), the per-favorite interval (OptionAutoCheckFavIntervalMinutes
  // analog) and per-check jitter; a slow check blocks only its slot.
  const favoritesEngine = new FavoritesEngine({
    store: libraryStore,
    info: infoService,
    downloads: {
      createDownload: (input): { jobId: string } => ({ jobId: jobs.createDownload(input).job.id }),
    },
  });
  const favoritesScheduler = new FavoriteScheduler({
    list: (): readonly { mangaKey: string }[] => favoritesEngine.listFavorites(),
    check: async (favorite): Promise<void> => {
      await favoritesEngine.checkFavorite(favorite.mangaKey);
    },
    onError: (favorite, error): void => {
      log(`favorites: check failed for ${favorite.mangaKey}: ${error instanceof Error ? error.message : String(error)}`);
    },
    maxConcurrent: config.favoriteMaxConcurrent,
    intervalMs: config.favoriteIntervalMs,
    jitterMs: config.favoriteJitterMs,
  });
  const favoritesService = new SqliteFavoritesService(favoritesEngine);
  favoritesScheduler.start();

  const syncService: SyncService = {
    syncModules: async (): Promise<SyncModulesOutcome> => {
      await moduleSync.sync();
      const boot = await bootRegistry();
      moduleService.refresh(moduleRows);
      const summary = boot.summary;
      return {
        summary: {
          treeSha: summary?.treeSha ?? sweep.treeSha(),
          totalFiles: sweep.discoverFiles().length,
          registeredFiles: summary === undefined ? boot.modules : summary.modules.length,
          failedFiles: 0,
          totalModules: boot.modules,
          failures: [],
          knownBroken: registry.knownBroken(),
          eventCoverage: {},
        },
      };
    },
    syncCatalog: async (id: string): Promise<CatalogSyncOutcome> => {
      const result = await catalogSync.syncCatalog(id);
      // §6.8: a fresh install flips the module back to the catalog read
      // side — drop the live-walk snapshot so the cache cannot outlive it.
      if (result.state === 'updated') {
        catalogFallback.invalidate(id);
      }
      return {
        id: result.id,
        state: result.state,
        ...(result.dbSha !== undefined ? { dbSha: result.dbSha } : {}),
        ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    },
    syncAllCatalogs: async (): Promise<readonly CatalogSyncOutcome[]> => {
      const results = await catalogSync.syncChanged(config.bootstrapCatalogIds);
      for (const result of results) {
        if (result.state === 'updated') {
          catalogFallback.invalidate(result.id);
        }
      }
      return results.map(toCatalogOutcome);
    },
  };

  const bootstrap = new BootstrapRunner({
    dataDir: config.dataDir,
    syncModules: async () => {
      const result = await moduleSync.sync();
      return { sha: result.sha, report: { modules: result.report.modules } };
    },
    bootRegistry: async () => {
      const boot = await bootRegistry();
      moduleService.refresh(moduleRows);
      return { source: boot.source, modules: boot.modules };
    },
    syncCatalog: (id) => syncService.syncCatalog(id),
    checkCatalogUpdates: async () => {
      const check = await catalogSync.checkForUpdates();
      return { changed: check.changed, headSha: check.headSha };
    },
    catalogIds: config.bootstrapCatalogIds,
    log,
    ...(config.bootstrapStageDelayMs > 0 ? { stageDelayMs: config.bootstrapStageDelayMs } : {}),
    ...(config.bootstrapDisabled ? { disabled: true } : {}),
  });

  const readiness = composeReadiness(
    (): ReadinessStatus => bootstrap.readiness(),
    // §10 readiness semantics beyond the D20 gate: app db open, every
    // installed catalog attachable, lua tree present (fault-injected
    // by the observability tests). FMD_BOOTSTRAP_DISABLE=1 drops the
    // lua-tree check together with the bootstrap — an empty data dir
    // with the flag set is a valid (provisioning-owned) deployment.
    new ReadinessProbe({
      dataDir: config.dataDir,
      ...(!config.bootstrapDisabled ? {} : { requireLuaTree: false }),
    }).probe,
  );

  // ── §8.6/D4 accounts ─────────────────────────────────────────────
  // CRUD + the OnLogin flow over app.db `account`, sealed at rest with
  // FMD_WEB_SECRET (AES-256-GCM; an unset secret keeps accounts writes
  // failing cleanly until the deployment configures one). The engine
  // login driver runs the module's real OnLogin through the event
  // runtime (§5.2 account-status constants). module_state cookie
  // persistence rides the db story's ModuleStatePersistence adapter
  // (the boundary is optional here; the account row always persists
  // the login outcome).
  const accounts = new SqliteAccountService({
    store: new SqliteAccountStore(db),
    secret: (): string => process.env['FMD_WEB_SECRET'] ?? '',
    loginDriver: new EngineLoginDriver({
      luaRoot,
      modules: (): readonly RegistrationRecord[] => moduleRows,
      transport,
      egress,
      swallowDeduper: logger.expressionDedup,
      logSink: (record): void => {
        const scoped = logger.forModule(record.moduleId === '' ? '(host)' : record.moduleId);
        if (record.level === 'warn') {
          scoped.warn(record.message, { event: 'engine_log' });
        } else if (record.level === 'error') {
          scoped.error(record.message, { event: 'engine_log' });
        } else {
          scoped.info(record.message, { event: 'engine_log' });
        }
      },
    }),
  });

  const services: ApiServices = {
    modules: moduleService,
    settings,
    catalogs: catalogSync.store,
    catalogFallback,
    info: infoService,
    accounts,
    jobs,
    library: libraryService,
    favorites: favoritesService,
    sync: new InstrumentedSyncService(syncService, metrics),
    readiness,
  };

  const appOptions: AppOptions = {
    version,
    infoCacheTtlMs: DEFAULT_INFO_CACHE_TTL_MS,
    metrics,
  };
  const app = buildApp(services, appOptions);
  return {
    app,
    services,
    bootstrap,
    sweep,
    wsHub,
    lane,
    favoritesScheduler,
    active,
    metrics,
    logger,    dispose: async (): Promise<void> => {
      favoritesScheduler.stop();
      await favoritesScheduler.drain();
      await lane.stop();
      wsHub.close();
      await info.dispose();
      bypass?.dispose();
      transport.dispose();
      (catalogSync.store as CatalogFileStore).closeAll();
      sqliteQueue.close();
      db.close();
    },
  };
}
function toCatalogOutcome(result: {
  id: string;
  state: 'unchanged' | 'updated' | 'failed';
  dbSha?: string;
  bytes?: number;
  error?: string;
}): CatalogSyncOutcome {
  return {
    id: result.id,
    state: result.state,
    ...(result.dbSha !== undefined ? { dbSha: result.dbSha } : {}),
    ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}
