import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { FileNamePolicyMode, ReadinessStatus } from '@fmd/contract';
import { buildApp, type ApiServices, type AppOptions, DEFAULT_INFO_CACHE_TTL_MS } from '../api/app.js';
import {
  type CatalogSyncOutcome,
  type CatalogSyncPhaseCb,
  type InfoService,
  type JobService,
  type ModuleService,
  type NormalizedInfo,
  type SyncModulesOutcome,
  type SyncService,
  WsPublishingSyncService,
} from '../api/services.js';
import { ApiError } from '../api/errors.js';
import { AuthService, resolveApiTokenBootstrap } from '../api/auth.js';
import { WsHub } from '../api/ws/hub.js';
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
// ENGINE-BOUNDARY (tsk-linear-varnish-restricts): this assembly is the
// composition root and reaches the engine ONLY through the facade — the
// domain-shaped, wasmoon-free door. The substrate (host factory + the
// module services) is injected through the ModuleRuntime interface; the
// wasmoon-backed default is loaded LAZILY via the production door so a
// substituted runtime (the stub-substrate boot test) keeps wasmoon off
// its path entirely.
import {
  EgressPolicy,
  FlareSolverrBypassExecutor,
  InMemoryModuleRegistryPersistence,
  LoopbackHttpTransport,
  ModuleStateService,
  SyncHostGate,
  normalizeProxyConfig,
  setDefaultRequestTimeoutMs,
  type ModuleRuntime,
  type ModuleSharedState,
  type ProxyConfig,
  type RegistrationRecord,
  type ModuleTreeSweepPort as RegistrySweep,
  type BootResult,
} from '../engine/facade.js';
import type { ModuleSummaryT, OptionValueT } from '../api/schemas.js';
import { createModuleSyncService } from '../sync/modules/service.js';
import { loadModuleSyncConfig, type ModuleSyncConfig } from '../sync/modules/config.js';
import { CatalogSync } from '../sync/db/sync-service.js';
import { DEFAULT_BOOTSTRAP_CATALOGS } from './catalog-defaults.js';
import { DEFAULT_LIVE_SCRAPE_TTL_MS, LiveScrapeCatalogStore } from '../catalog/live-scrape-store.js';
import { UpdateLaneScrapeGate } from '../catalog/update-lane-gate.js';
import type { CatalogFileStore } from '../sync/db/catalog-store.js';
import { InMemoryModuleService, InMemorySettingsService } from '../api/services.js';
import type {
  DiagnosticsSettingsT,
  FilenamePolicySettingsT,
  OutputDefaultsT,
  PerformanceSettingsT,
  RetentionSettingsT,
} from '../api/schemas.js';
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
  /** D20 bootstrap catalogs: FMD_BOOTSTRAP_CATALOGS csv override, else the curated defaults. */
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
  /**
   * §10 cookie flow: non-empty FMD_WEB_PASSWORD enables the login
   * route + the state-changing cookie gate (unset = no cookie flow).
   */
  readonly password: string | undefined;
  /**
   * R4 single app-wide API token env pin: non-empty FMD_WEB_API_TOKEN
   * OVERRIDES the stored settings value (precedence env > settings,
   * runbook §API token) — headless/compose deployments keep the secret
   * out of the settings store.
   */
  readonly apiTokenEnv: string | undefined;
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
  // D20 catalogs: an explicit FMD_BOOTSTRAP_CATALOGS csv OVERRIDES the
  // curated defaults entirely (compose/e2e/dev stay override-driven);
  // unset/empty = the curated, live-verified DEFAULT_BOOTSTRAP_CATALOGS.
  const bootstrapCsv = csvEnv(env['FMD_BOOTSTRAP_CATALOGS']);
  return {
    dataDir,
    port,
    staticDir: staticDir !== undefined && staticDir !== '' ? resolve(staticDir) : undefined,
    moduleSync: loadModuleSyncConfig({ ...env, FMD_DATA_DIR: dataDir }),
    dbUrl: env['FMD_DB_URL'],
    dbApiBase: env['FMD_DB_API_BASE'],
    bootstrapCatalogIds: bootstrapCsv.length > 0 ? bootstrapCsv : [...DEFAULT_BOOTSTRAP_CATALOGS],
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
    // §10/R4 auth env: empty-string FMD_WEB_PASSWORD = unset (compose
    // `env_file` blanks); the token pin likewise only when non-empty.
    password: env['FMD_WEB_PASSWORD'] !== undefined && env['FMD_WEB_PASSWORD'] !== ''
      ? env['FMD_WEB_PASSWORD']
      : undefined,
    apiTokenEnv: env['FMD_WEB_API_TOKEN'] !== undefined && env['FMD_WEB_API_TOKEN'] !== ''
      ? env['FMD_WEB_API_TOKEN']
      : undefined,
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
  /**
   * §10/R4 auth service (cookie sessions + the single API token). The
   * raw-http entry hands `auth.checkUpgradeRequest` to its own /ws
   * attach so upgrades share this app's credential truth.
   */
  readonly auth: AuthService;
  /** Drain: dispose engines + transport + catalog handles + the WS hub. */
  dispose(): Promise<void>;
}

export interface BuildRuntimeOptions {
  readonly config: RuntimeConfig;
  readonly log: (message: string) => void;
  readonly version: string;
  /**
   * ENGINE SUBSTRATE OVERRIDE (engine-boundary story): the module runtime
   * construction surface. Production boots the wasmoon-backed default
   * (lazily, via the engine production door); tests substitute a stub
   * (the stub-substrate swap proof — canned registry rows, scripted
   * results, no wasmoon anywhere on the path).
   */
  readonly substrate?: ModuleRuntime;
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
    private readonly catalogInstalled: (id: string) => boolean = (): boolean => false,
  ) {
    this.current = new InMemoryModuleService(rows, browserProfileEnabled, catalogInstalled);
  }

  refresh(rows: readonly RegistrationRecord[]): void {
    this.current = new InMemoryModuleService(rows, this.browserProfileEnabled, this.catalogInstalled);
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

/** Structural slice of StartupRegistryService the assembly uses (lazy). */
interface StartupRegistryServiceLike {
  boot(): Promise<BootResult>;
  knownBroken(): Readonly<Record<string, readonly string[]>>;
}

export async function buildRuntime(options: BuildRuntimeOptions): Promise<RuntimeAssembly> {
  const { config, log, version } = options;
  const luaRoot = join(config.dataDir, 'lua');
  // The substrate seam: injected (stub/tests) or the wasmoon default,
  // loaded lazily so the substituted path never evaluates wasmoon.
  const substrate: ModuleRuntime =
    options.substrate ?? (await import('../engine/index.js')).createModuleRuntime();
  const luaHostFactory = substrate.createHostFactory();

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
  // FMD_HTTP_ALLOW_HOSTS admits external hosts for live module egress
  // (http AND https — TLS-verified with SNI; `*` = any host). The
  // transport re-asserts the host policy before opening any socket.
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
  const moduleSync = createModuleSyncService(config.moduleSync, { hostFactory: luaHostFactory });
  const sweep: RegistrySweep = substrate.createSweep({ luaRoot, hostFactory: luaHostFactory });
  // A fresh startup service per boot: in-memory persistence means every
  // boot sweeps (§9 SHA-gated caching resumes with the SQLite
  // module_state story) — and a manual re-sync after a tree swap gets a
  // fresh sweep instead of the memoized registry.
  // The registry boot service is behind the production door (its module
  // transitively imports the shim installer): constructed lazily inside
  // bootRegistry() so a substituted substrate never evaluates it.
  let registry: StartupRegistryServiceLike | undefined;
  const catalogSync = new CatalogSync({
    dataDir: config.dataDir,
    ...(config.dbUrl !== undefined ? { dbUrl: config.dbUrl } : {}),
    ...(config.dbApiBase !== undefined ? { apiBase: config.dbApiBase } : {}),
    knownCatalogIds: (): readonly string[] => config.bootstrapCatalogIds,
  });

  // ── registry state (empty until bootstrap's sweep lands) ───────────
  // A substrate that vouches for its own registry rows (the stub proof;
  // a future native-registry substrate) boots pre-seeded — no sweep.
  let moduleRows: readonly RegistrationRecord[] = [...(substrate.initialModules ?? [])];
  let booted = substrate.initialModules !== undefined;
  const bootRegistry = async (): Promise<{ source: string; modules: number; summary?: SweepOutcomeShape }> => {
    const { StartupRegistryService } = await import('../engine/index.js');
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
  // Site-first browse join: /api/modules catalogInstalled is read LIVE
  // from the CatalogStore receipts — a finished provision flips the
  // chip on the next modules read, no cache invalidation needed.
  const moduleService = new RefreshableModuleService(
    [...moduleRows],
    browserProfileEnabled,
    // catalogInstalled join: the InMemoryModuleService constructor wraps
    // this with the non-32-hex id guard (single source, services.ts).
    (id: string): boolean => catalogSync.store.getMeta(id) !== undefined,
  );
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

  const info = substrate.createInfoService({
    luaRoot,
    hostFactory: luaHostFactory,
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
  const liveScrapeWalker = substrate.createDirectoryWalker({
    luaRoot,
    hostFactory: luaHostFactory,
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
  const sqliteQueue = new SqliteJobQueue({
    file: join(config.dataDir, 'app.db'),
    recoverOnOpen: true,
    // [parity-sweep] M2: live retention window (0 days = keep forever).
    retentionMs: (): number => settings.retentionSettings().days * 86_400_000,
  });
  const publishingQueue = new PublishingJobQueue(sqliteQueue, (job): void => {
    wsHub.publish(toJobWire(job));
  });
  // §4 job counters: the instrumented wrapper sits OUTSIDE the WS
  // publisher so every mutation (WS-mirrored or not) feeds the series,
  // and the depth/state gauges snapshot the LIVE queue at scrape.
  const queue = new InstrumentedJobQueue(publishingQueue, metrics);
  const libraryStore = new SqliteLibraryStore({ db, libraryRoot: join(config.dataDir, 'library') });
  const libraryService = new SqliteLibraryService(libraryStore);
  // Downloads parity: the delete(+data) seam — RuntimeJobService hands
  // the recorded artifact path to the store's file+row remover.
  const jobs: JobService = new RuntimeJobService(
    queue,
    (jobId): boolean => active.cancel(jobId),
    (path): boolean => libraryStore.deleteLibraryFileByPath(path),
  );

  // ── [parity-sweep] settings seeds + live sinks (app_settings kv) ──
  // Read BEFORE the lane starts: parallelChapters is fixed at
  // LaneRunner start (M10 restart-to-apply note); everything else is
  // read per-job/per-sweep. Precedence (M4): FMD_NORMALIZE_PATHS env >
  // setting > windows-parity default.
  const envNormalize: FileNamePolicyMode | undefined =
    process.env['FMD_NORMALIZE_PATHS'] === '1' ? 'linux-normalized' : undefined;
  const readParitySweepSeeds = (): {
    performance: PerformanceSettingsT;
    retention: RetentionSettingsT;
    filenamePolicy: FilenamePolicySettingsT;
    diagnostics: DiagnosticsSettingsT;
    output: OutputDefaultsT;
  } => {
    const defaults = settings;
    const perf = readJsonSetting(libraryStore, 'performance.lanes');
    const ret = readJsonSetting(libraryStore, 'retention.jobs');
    const fp = readJsonSetting(libraryStore, 'filenamePolicy.d5');
    const diag = readJsonSetting(libraryStore, 'diagnostics.log');
    const out = readJsonSetting(libraryStore, 'output.defaults');
    return {
      performance: { ...defaults.performanceSettings(), ...(isObject(perf) ? coercePerformance(perf) : {}) },
      retention: { ...defaults.retentionSettings(), ...(isObject(ret) ? coerceRetention(ret) : {}) },
      filenamePolicy: { ...defaults.filenamePolicySettings(), ...(isObject(fp) ? coerceFilenamePolicy(fp) : {}) },
      diagnostics: { ...defaults.diagnosticsSettings(), ...(isObject(diag) ? coerceDiagnostics(diag) : {}) },
      output: { ...defaults.outputDefaults(), ...(isObject(out) ? coerceOutput(out) : {}) },
    };
  };
  const paritySeeds = readParitySweepSeeds();
  settings.setParitySweepSettingsLive(paritySeeds, {
    onPerformance: (next): void => {
      libraryStore.setSetting('performance.lanes', JSON.stringify(next));
      // M10: the HTTP pipeline default applies to NEW pipelines (per-run
      // module state) — live enough for new requests.
      setDefaultRequestTimeoutMs(next.requestTimeoutSeconds * 1000);
    },
    onRetention: (next): void => {
      libraryStore.setSetting('retention.jobs', JSON.stringify(next));
    },
    onFilenamePolicy: (next): void => {
      libraryStore.setSetting('filenamePolicy.d5', JSON.stringify(next));
    },
    onDiagnostics: (next): void => {
      libraryStore.setSetting('diagnostics.log', JSON.stringify(next));
      logger.applyDiagnostics(next);
    },
  });
  // Boot-time apply (seeds): pipeline default timeout + log filter.
  setDefaultRequestTimeoutMs(paritySeeds.performance.requestTimeoutSeconds * 1000);
  logger.applyDiagnostics(paritySeeds.diagnostics);

  // ── R4 single app-wide API token (env pin > settings store) ──────
  // Precedence: a non-empty FMD_WEB_API_TOKEN pin OVERRIDES the stored
  // app_settings `api.token` row (headless/compose deployments keep
  // the secret out of the settings store; the UI shows 'Managed via
  // environment' and regenerate refuses). First-run generation is
  // UNCONDITIONAL (no pin, nothing stored): the token is an *arr-style
  // API key independent of password auth — reverse-proxy deployments
  // (authelia/authentik in front, no local password) get a script key
  // on first start. Password auth stays opt-in for the UI login gate;
  // with it off the API is open to the browser SPA and the token is
  // additionally accepted wherever presented. The effective provider
  // reads the settings store LIVE, so UI regeneration applies to the
  // very next request (old key rejected immediately) and env
  // precedence holds per-request.
  const storedApiTokenRaw = libraryStore.getSetting('api.token');
  const storedApiToken: string | null =
    typeof storedApiTokenRaw === 'string' && /^[0-9a-f]{64}$/.test(storedApiTokenRaw)
      ? storedApiTokenRaw
      : null;
  const apiTokenBootstrap = resolveApiTokenBootstrap({
    envPin: config.apiTokenEnv,
    stored: storedApiToken,
  });
  settings.bindApiTokenPersistence(apiTokenBootstrap.store, (token: string): void => {
    libraryStore.setSetting('api.token', token);
  });
  if (apiTokenBootstrap.store !== null && storedApiToken === null) {
    libraryStore.setSetting('api.token', apiTokenBootstrap.store);
  }
  const effectiveApiToken = (): string | undefined =>
    config.apiTokenEnv ?? (settings.getApiToken() ?? undefined);
  if (apiTokenBootstrap.generated) {
    log('auth: api token generated on first run — copy it from Settings → API');
  }

  // ── §10/R4 auth service (cookie flow + the single API token) ─────
  const authService = new AuthService({
    password: config.password,
    apiToken: effectiveApiToken,
    ...(config.apiTokenEnv !== undefined ? { apiTokenEnvPinned: true } : {}),
  });
  log(
    `auth: ${authService.authMode()} (password ${authService.enabled ? 'on' : 'off'}, ` +
      `api token ${authService.tokenActive ? 'on' : 'off'}${authService.tokenEnvManaged ? ', env-pinned' : ''})`,
  );

  // [parity-sweep] M2: the periodic retention sweep (hourly; §9 said
  // "prunes after 30d" but nothing scheduled it — the sweep IS the
  // honored-in-behavior half of the retention setting).
  const retentionSweepInterval = setInterval((): void => {
    try {
      queue.pruneRetention();
    } catch {
      // queue closing/closed — the drain path owns shutdown
    }
  }, 60 * 60 * 1000);
  retentionSweepInterval.unref?.();
  try {
    queue.pruneRetention();
  } catch {
    // first sweep best-effort
  }

  const lane = startDownloadLane(queue, {
    wsHub,
    library: libraryStore,
    dataDir: config.dataDir,
    // The substrate's download-hooks factory (stub proof substitutes
    // scripted hooks; default = the wasmoon-backed EngineDownloadHooks).
    createHooks: (moduleId, engineOptions): Promise<import('../engine/facade.js').ModuleDownloadHooks> =>
      substrate.createDownloadHooks(moduleId, engineOptions),
    engine: {
      luaRoot,
      hostFactory: luaHostFactory,
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
    // Output defaults (FMD2 Save-to parity): read per-job so a
    // PUT /api/settings/output change applies to NEW jobs only.
    outputDefaults: (): OutputDefaultsT => settings.outputDefaults(),
    // [parity-sweep] M10: per-job Performance knobs + lane slot count
    // (slots are fixed at this start — restart to apply changes).
    performance: (): PerformanceSettingsT => settings.performanceSettings(),
    parallelChapters: settings.performanceSettings().parallelChapters,
    // [parity-sweep] M4: env > setting > parity default, resolved here.
    fileNamePolicy: (): FileNamePolicyMode | undefined =>
      envNormalize ?? (settings.filenamePolicySettings().normalizePaths ? 'linux-normalized' : 'windows-parity'),
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
  // Options → Updates parity: the persisted favorites scheduler settings
  // (app_settings kv) seed the interval + the startup-sweep gate; PUT
  // /api/settings/favorites applies live through the same sink.
  const FAVORITES_SETTINGS_KEY = 'favorites.scheduler';
  const favoritesSettingsSeed = readFavoritesSettings(libraryStore, config.favoriteIntervalMs);
  const favoritesScheduler = new FavoriteScheduler({
    // Disabled favorites are never auto-checked (FMD2 Enabled=False rows
    // stay untouched until re-enabled; manual check-now still works).
    list: (): readonly { mangaKey: string }[] =>
      favoritesEngine.listFavorites().filter((row): boolean => row.enabled !== false),
    check: async (favorite): Promise<void> => {
      await favoritesEngine.checkFavorite(favorite.mangaKey);
    },
    onError: (favorite, error): void => {
      log(`favorites: check failed for ${favorite.mangaKey}: ${error instanceof Error ? error.message : String(error)}`);
    },
    maxConcurrent: config.favoriteMaxConcurrent,
    intervalMs: favoritesSettingsSeed.intervalMinutes * 60_000,
    jitterMs: config.favoriteJitterMs,
  });
  const favoritesService = new SqliteFavoritesService(favoritesEngine, {
    catalogs: catalogSync.store,
    info: infoService,
  });
  settings.setFavoritesSettingsLive(
    {
      intervalMinutes: favoritesSettingsSeed.intervalMinutes,
      checkAtStartup: favoritesSettingsSeed.checkAtStartup,
    },
    (next): void => {
      libraryStore.setSetting(FAVORITES_SETTINGS_KEY, JSON.stringify(next));
      favoritesScheduler.setDefaultIntervalMs(next.intervalMinutes * 60_000);
    },
  );
  if (favoritesSettingsSeed.checkAtStartup) {
    favoritesScheduler.start();
  }

  const syncService: SyncService = {
    syncModules: async (): Promise<SyncModulesOutcome> => {
      const result = await moduleSync.sync();
      const boot = await bootRegistry();
      moduleService.refresh(moduleRows);
      const summary = boot.summary;
      return {
        summary: {
          treeSha: summary?.treeSha ?? sweep.treeSha(),
          totalFiles: sweep.discoverFiles().length,
          registeredFiles: summary === undefined ? boot.modules : summary.modules.length,
          failedFiles: result.report.failures.length,
          totalModules: boot.modules,
          failures: result.report.failures.map((failure) => ({
            file: failure.file,
            error: failure.firstError,
          })),
          knownBroken: registry?.knownBroken() ?? {},
          eventCoverage: {},
        },
      };
    },
    syncCatalog: async (id: string, onProgress?: CatalogSyncPhaseCb): Promise<CatalogSyncOutcome> => {
      const result = await catalogSync.syncCatalog(
        id,
        onProgress === undefined
          ? undefined
          : (phase): void => {
              onProgress(phase);
            },
      );
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
      return {
        sha: result.sha,
        report: { modules: result.report.modules, failures: result.report.failures },
      };
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
    loginDriver: substrate.createLoginSession({
      luaRoot,
      hostFactory: luaHostFactory,
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
    // Site-first browse: catalog provisions stream WS `sync` frames
    // (progress toast) keyed `catalog-sync:<moduleId>`; REST contract
    // unchanged (the decorator is pass-through on the wire).
    sync: new InstrumentedSyncService(
      new WsPublishingSyncService(syncService, (event): void => {
        wsHub.publishSync(event);
      }),
      metrics,
    ),
    readiness,
  };

  const appOptions: AppOptions = {
    version,
    infoCacheTtlMs: DEFAULT_INFO_CACHE_TTL_MS,
    metrics,
    authService,
    // R4 audit trail: settings changes (token rotation) become
    // structured log events — the audit NEVER carries the token value.
    onAudit: (event): void => {
      logger.info(`audit: settings ${event.setting} ${event.action}`, {
        event: 'audit',
        setting: event.setting,
        action: event.action,
      });
    },
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
    logger,
    auth: authService,    dispose: async (): Promise<void> => {
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

/**
 * Options → Updates parity: the persisted favorites scheduler settings
 * (app_settings kv `favorites.scheduler`, written by PUT
 * /api/settings/favorites). Absent/corrupt rows fall back to the env
 * config (FMD_FAVORITE_INTERVAL_MS) with the startup sweep on — the
 * pre-settings behavior.
 */
function readFavoritesSettings(
  store: { getSetting(key: string): string | undefined },
  envIntervalMs: number,
): { intervalMinutes: number; checkAtStartup: boolean } {
  const raw = store.getSetting('favorites.scheduler');
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { intervalMinutes?: unknown; checkAtStartup?: unknown };
      const intervalMinutes =
        typeof parsed.intervalMinutes === 'number' &&
        Number.isInteger(parsed.intervalMinutes) &&
        parsed.intervalMinutes >= 0 &&
        parsed.intervalMinutes <= 20160
          ? parsed.intervalMinutes
          : Math.round(envIntervalMs / 60_000);
      const checkAtStartup =
        typeof parsed.checkAtStartup === 'boolean' ? parsed.checkAtStartup : true;
      return { intervalMinutes, checkAtStartup };
    } catch {
      // corrupt row → env defaults
    }
  }
  return { intervalMinutes: Math.round(envIntervalMs / 60_000), checkAtStartup: true };
}

// ── [parity-sweep] app_settings seed helpers ─────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonSetting(store: { getSetting(key: string): string | undefined }, key: string): unknown {
  const raw = store.getSetting(key);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function coercePerformance(row: Record<string, unknown>): Partial<PerformanceSettingsT> {
  const out: Partial<PerformanceSettingsT> = {};
  if (typeof row.requestTimeoutSeconds === 'number') {
    out.requestTimeoutSeconds = row.requestTimeoutSeconds;
  }
  if (typeof row.retryCount === 'number') {
    out.retryCount = row.retryCount;
  }
  if (typeof row.parallelChapters === 'number') {
    out.parallelChapters = row.parallelChapters;
  }
  if (typeof row.threadsPerChapter === 'number') {
    out.threadsPerChapter = row.threadsPerChapter;
  }
  return out;
}

function coerceRetention(row: Record<string, unknown>): Partial<RetentionSettingsT> {
  return typeof row.days === 'number' ? { days: row.days } : {};
}

function coerceFilenamePolicy(row: Record<string, unknown>): Partial<FilenamePolicySettingsT> {
  return typeof row.normalizePaths === 'boolean' ? { normalizePaths: row.normalizePaths } : {};
}

function coerceDiagnostics(row: Record<string, unknown>): Partial<DiagnosticsSettingsT> {
  const out: Partial<DiagnosticsSettingsT> = {};
  if (typeof row.logEnabled === 'boolean') {
    out.logEnabled = row.logEnabled;
  }
  if (row.logLevel === 'debug' || row.logLevel === 'info' || row.logLevel === 'warn' || row.logLevel === 'error') {
    out.logLevel = row.logLevel;
  }
  return out;
}

function coerceOutput(row: Record<string, unknown>): Partial<OutputDefaultsT> {
  const out: Partial<OutputDefaultsT> = {};
  if (row.format === 'zip' || row.format === 'cbz' || row.format === 'pdf' || row.format === 'epub') {
    out.format = row.format;
  }
  if (typeof row.chapterNameTemplate === 'string') {
    out.chapterNameTemplate = row.chapterNameTemplate;
  }
  if (typeof row.unicodeReplacement === 'boolean') {
    out.unicodeReplacement = row.unicodeReplacement;
  }
  if (typeof row.unicodeReplacementChar === 'string' && row.unicodeReplacementChar.length === 1) {
    out.unicodeReplacementChar = row.unicodeReplacementChar;
  }
  if (typeof row.digitPadding === 'number') {
    out.digitPadding = row.digitPadding;
  }
  if (typeof row.removeMangaName === 'boolean') {
    out.removeMangaName = row.removeMangaName;
  }
  return out;
}
