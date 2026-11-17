/**
 * The §10 Fastify application (DESIGN.md §10): one `buildApp(deps,
 * options)` used by BOTH the integration tests (`fastify.inject`, fully
 * offline) and the runtime entry (main.ts bridges raw http → app.inject).
 *
 * Wiring per route: zod parses at the boundary (`parseOr400`) and
 * handlers receive inferred, narrowed types; outgoing bodies are
 * re-validated through the same response schemas (parse before send —
 * the schemas stay the single source of truth both ways); failures map
 * onto the typed error envelope via the central error handler.
 * Services are ports (see services.ts) — SQLite adapters land with the
 * db story.
 */
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  CatalogFallbackStore,
  CatalogPage,
  CatalogSearchQuery,
  HealthStatus,
  ReadinessStatus,
} from '@fmd/contract';
import { CatalogFallbackError } from '@fmd/contract';
import type { FmdMetrics } from '../observability/metrics.js';
import { ApiError, toErrorBody, notFound } from './errors.js';
import {
  AccountListResponseSchema,
  AccountLoginResponseSchema,
  AccountResponseSchema,
  AccountUpsertRequestSchema,
  AllSitesSearchQuerySchema,
  AllSitesSearchResponseSchema,
  CatalogBrowseQuerySchema,
  CatalogPageResponseSchema,
  CatalogSearchQuerySchema,
  CatalogSyncAllResponseSchema,
  CatalogSyncResponseSchema,
  normalizeGenresParam,
  HealthzResponseSchema,
  InfoRequestSchema,
  InfoResponseSchema,
  JobCreatedResponseSchema,
  JobCreateRequestSchema,
  JobIdSchema,
  JobsListQuerySchema,
  JobsListResponseSchema,
  LibraryListQuerySchema,
  LibraryListResponseSchema,
  ModuleIdSchema,
  ModuleListResponseSchema,
  ModuleSummarySchema,
  ModuleUpdateRequestSchema,
  ProxyUpdateRequestSchema,
  ReadyzResponseSchema,
  SettingsResponseSchema,
  SyncModulesResponseSchema,
  FavoriteCheckResponseSchema,
  FavoriteCreateRequestSchema,
  FavoriteIdSchema,
  FavoriteImportRequestSchema,
  FavoriteListResponseSchema,
  FavoriteResponseSchema,
  FavoriteUpdateRequestSchema,
  parseOr400,
  type AccountListResponseT,
  type AccountLoginResponseT,
  type AccountResponseT,
  type CatalogPageResponseT,
  type AllSitesSearchResponseT,
  type FavoriteCheckResponseT,
  type FavoriteResponseT,
  type FavoriteT,
  type FavoriteListResponseT,
  type InfoResponseT,
  type JobCreatedResponseT,
  type JobT,
  type JobsListResponseT,
  type LibraryListResponseT,
  type ModuleListResponseT,
  type SettingsResponseT,
  type ModuleSummaryT,
  type ReadyzResponseT,
} from './schemas.js';
import { registerAuth, AuthService, type AuthConfig } from './auth.js';
import { attachWebSocketHub, type WsAttachment } from './ws/attach.js';
import type { WsHub } from './ws/hub.js';
import { InMemoryAccountService, type AccountService } from '../accounts/account-service.js';
import {
  InfoResponseCache,
  InMemorySettingsService,
  type CatalogService,
  type FavoriteService,
  type InfoService,
  type JobRecord,
  type JobService,
  type LibraryService,
  type ModuleService,
  type NormalizedInfo,
  type SettingsService,
  type SyncService,
} from './services.js';
import { UnionSearchService } from './search-service.js';

/** Aggregate of the §10 domain seams (all required; tests pass fakes). */
export interface ApiServices {
  readonly modules: ModuleService;
  readonly catalogs: CatalogService;
  readonly info: InfoService;
  readonly jobs: JobService;
  readonly sync: SyncService;
  /** §7.1 library listing/download (finalized chapter artifacts). */
  readonly library: LibraryService;
  /** §7.2 favorites (DoCheck engine + scheduler). */
  readonly favorites: FavoriteService;
  /**
   * §9/§10 settings (global proxy + §5.11 browser profile). Optional
   * with an in-memory default so hosts without the settings story yet
   * keep compiling; the runtime assembly always wires the real one.
   */
  readonly settings?: SettingsService;
  /**
   * §8.6/D4 module accounts (CRUD + the OnLogin flow). Optional with an
   * in-memory default (login lands in asUnknown) so hosts without the
   * accounts assembly keep compiling; the runtime wires the SQLite
   * service + the engine login driver.
   */
  readonly accounts?: AccountService;
  /**
   * §6.8 live-scrape fallback (browse without an FMD2-DB catalog).
   * Optional: absent → catalog-only lookups (404 for catalog-less ids);
   * present → catalog-first, live directory walk second, typed error
   * otherwise. Responses carry the `source` discriminator either way.
   */
  readonly catalogFallback?: CatalogFallbackStore;
  /** Readiness probe input (default: always ready). */
  readonly readiness?: () => ReadinessStatus;
}

export interface AppOptions {
  readonly version: string;
  /** When undefined, auth is disabled and every route is open. */
  readonly auth?: AuthConfig;
  /** POST /api/info response cache TTL (default 60 s). */
  readonly infoCacheTtlMs?: number;
  /**
   * When present, `GET /ws` upgrades are answered by the D19 hub
   * (§10): hello → backfill/resync → live job events. Disposed on app
   * close. Callers serving behind their own raw http server (main.ts /
   * runtime-entry.ts) attach the SAME hub to that server instead —
   * `app.inject` never sees upgrades.
   */
  readonly wsHub?: WsHub;
  /**
   * §4/§15 observability: when present, `GET /api/metrics` serves the
   * Prometheus exposition and `/api/info` feeds the per-module request
   * latency/error series. Absent → the route is not mounted (API-only
   * test fakes stay minimal).
   */
  readonly metrics?: FmdMetrics;
}

export const DEFAULT_INFO_CACHE_TTL_MS = 60_000;

/** Map a JobRecord onto the wire shape, omitting absent optionals. */
function toJobWire(job: JobRecord): JobT {
  return {
    id: job.id,
    type: job.type,
    moduleId: job.moduleId,
    payload: job.payload,
    state: job.state,
    priority: job.priority,
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.idempotencyKey !== undefined ? { idempotencyKey: job.idempotencyKey } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function toInfoWire(info: NormalizedInfo): InfoResponseT {
  return {
    title: info.title,
    altTitles: info.altTitles,
    authors: info.authors,
    artists: info.artists,
    genres: info.genres,
    status: info.status,
    summary: info.summary,
    coverLink: info.coverLink,
    url: info.url,
    link: info.link,
    chapterLinks: [...info.chapterLinks],
    chapterNames: [...info.chapterNames],
    numChapter: info.numChapter,
  };
}

/** Catalog store failures other than the typed ones (db gone, cursor
 * rebinding) map onto the envelope: cursor complaints → 400, rest → 502. */
function catalogFailure(err: unknown): ApiError {
  if (err instanceof ApiError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase().includes('cursor')) {
    return new ApiError(400, 'bad_request', message);
  }
  return new ApiError(502, 'upstream_error', `catalog read failed: ${message}`);
}

/**
 * §6.8 fallback failures map onto the envelope: `walk_failed` → 502
 * (upstream module failed; NEVER a partial page leaks), `lane_closed`
 * → 503, and cursor-scheme complaints (plain Errors carrying "cursor")
 * → 400 — the same mapping class as the catalog store's cursors.
 */
function fallbackFailure(err: unknown): ApiError {
  if (err instanceof ApiError) {
    return err;
  }
  if (err instanceof CatalogFallbackError) {
    if (err.kind === 'lane_closed') {
      return new ApiError(503, 'upstream_error', err.message);
    }
    return new ApiError(502, 'upstream_error', `live directory walk failed: ${err.message}`);
  }
  return catalogFailure(err);
}

function toCatalogPageWire(
  page: {
    entries: readonly {
      link: string;
      title: string;
      alttitles: string;
      authors: string;
      artists: string;
      genres: string;
      status: string;
      summary: string;
      numChapter: number;
      jdn: number;
    }[];
    nextCursor?: string;
    total?: number;
  },
  source: CatalogPageResponseT['source'],
): CatalogPageResponseT {
  return {
    entries: page.entries.map((entry) => ({ ...entry })),
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    ...(page.total !== undefined ? { total: page.total } : {}),
    source,
  };
}

/**
 * Build the §10 application. Deterministic and side-effect free —
 * listening is the entry point's business (`startServer` in main.ts).
 */
export function buildApp(services: ApiServices, options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const infoCache: InfoResponseCache = new InfoResponseCache(
    options.infoCacheTtlMs ?? DEFAULT_INFO_CACHE_TTL_MS,
  );
  // §8.6/D4 accounts — optional seam, in-memory default (see ApiServices).
  const accounts: AccountService = services.accounts ?? new InMemoryAccountService();

  // Typed error envelope — the ONE non-2xx shape (§10).
  app.setErrorHandler((err, _req, reply): void => {
    const { status, body } = toErrorBody(err);
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((_req, reply): void => {
    void reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
  });

  registerAuth(app, new AuthService(options.auth ?? { password: undefined }));

  // ── /ws (§10 + D19) — real-socket upgrades only; inject never sees them ──
  let wsAttachment: WsAttachment | undefined;
  if (options.wsHub !== undefined) {
    wsAttachment = attachWebSocketHub(app.server, options.wsHub);
    app.addHook('onClose', async (): Promise<void> => {
      wsAttachment?.dispose();
    });
  }

  // ── health (never gated) ──────────────────────────────────────────
  app.get('/healthz', async (): Promise<HealthStatus> => {
    return HealthzResponseSchema.parse({ status: 'ok', version: options.version });
  });

  app.get('/readyz', async (_req, reply): Promise<ReadyzResponseT> => {
    const probe = services.readiness ?? ((): ReadinessStatus => ({ ready: true }));
    const status = probe();
    const body = ReadyzResponseSchema.parse(status);
    // Readiness semantics (§10): NOT ready → 503 so probe tools
    // (wait-on, load balancers, the e2e healthcheck gate) key on the
    // status code, with the envelope carrying the human reason
    // (e.g. the D20 bootstrap stage for the SPA banner).
    if (!body.ready) {
      void reply.code(503);
    }
    return body;
  });

  // ── metrics (§4/§15; mounted only with a registry bound) ─────────
  if (options.metrics !== undefined) {
    const metrics = options.metrics;
    app.get('/api/metrics', async (_req, reply): Promise<string> => {
      void reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      return metrics.registry.render();
    });
  }

  // ── modules ───────────────────────────────────────────────────────
  const settings: SettingsService = services.settings ?? new InMemorySettingsService();

  app.get('/api/modules', async (): Promise<ModuleListResponseT> => {
    const modules: ModuleSummaryT[] = services.modules.list();
    return ModuleListResponseSchema.parse({ modules, count: modules.length });
  });

  app.put('/api/modules/:id', async (req): Promise<ModuleSummaryT> => {
    const id = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['id'], 'module id');
    const patch = parseOr400(ModuleUpdateRequestSchema, req.body, 'module update body');
    if (
      patch.enabled === undefined &&
      patch.options === undefined &&
      patch.cookies === undefined &&
      patch.proxy === undefined
    ) {
      throw new ApiError(400, 'validation_error', 'empty module update (nothing to change)');
    }
    return ModuleSummarySchema.parse(
      services.modules.update(id, {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.options !== undefined ? { options: patch.options } : {}),
        ...(patch.cookies !== undefined ? { cookies: patch.cookies } : {}),
        ...(patch.proxy !== undefined ? { proxy: patch.proxy } : {}),
      }),
    );
  });

  // ── accounts (§8.6/D4 CRUD + login) ───────────────────────────────
  app.get('/api/accounts', async (): Promise<AccountListResponseT> => {
    const rows = accounts.list();
    return AccountListResponseSchema.parse({ accounts: rows, count: rows.length });
  });

  app.put('/api/accounts/:moduleId', async (req, reply): Promise<AccountResponseT> => {
    const moduleId = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['moduleId'], 'module id');
    const body = parseOr400(AccountUpsertRequestSchema, req.body, 'account body');
    const account = accounts.upsert({
      moduleId,
      username: body.username,
      ...(body.password !== undefined ? { password: body.password } : {}),
      ...(body.cookies !== undefined ? { cookies: body.cookies } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    });
    void reply.code(201);
    return AccountResponseSchema.parse({ account });
  });

  app.delete('/api/accounts/:moduleId', async (req, reply): Promise<{ ok: true }> => {
    const moduleId = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['moduleId'], 'module id');
    accounts.remove(moduleId);
    void reply.code(200);
    return { ok: true };
  });

  // §8.6/D4 login flow: the module's real OnLogin through the event
  // runtime (account-status constants bound); the handler-set
  // Account.Status + Account.Cookies are persisted (account row + §5.3
  // module_state). Live-fetch failures are upstream 502s.
  app.post('/api/accounts/:moduleId/login', async (req): Promise<AccountLoginResponseT> => {
    const moduleId = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['moduleId'], 'module id');
    let account;
    try {
      account = await accounts.login(moduleId);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(
        502,
        'upstream_error',
        `module OnLogin failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return AccountLoginResponseSchema.parse({ account, ok: true });
  });

  // ── settings (global proxy + §5.11 browser profile state) ────────
  app.get('/api/settings', async (): Promise<SettingsResponseT> => {
    return SettingsResponseSchema.parse(settings.get());
  });

  app.put('/api/settings/proxy', async (req): Promise<SettingsResponseT> => {
    const proxy = parseOr400(ProxyUpdateRequestSchema, req.body, 'proxy update body');
    return SettingsResponseSchema.parse(settings.setProxy(proxy));
  });

  // ── sync ──────────────────────────────────────────────────────────
  app.post('/api/sync/modules', async (): Promise<unknown> => {
    const outcome = await services.sync.syncModules();
    return SyncModulesResponseSchema.parse({
      ok: true,
      summary: {
        ...outcome.summary,
        failures: [...outcome.summary.failures],
        knownBroken: Object.fromEntries(
          Object.entries(outcome.summary.knownBroken).map(([k, v]) => [k, [...v]]),
        ),
        eventCoverage: { ...outcome.summary.eventCoverage },
      },
    });
  });

  app.post('/api/sync/catalog/:id', async (req): Promise<unknown> => {
    const id = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['id'], 'catalog id');
    const outcome = await services.sync.syncCatalog(id);
    return CatalogSyncResponseSchema.parse({
      ok: true,
      result: {
        ...outcome,
        ...(outcome.dbSha !== undefined ? { dbSha: outcome.dbSha } : {}),
        ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      },
    });
  });

  app.post('/api/sync/catalog/all', async (): Promise<unknown> => {
    const outcomes = await services.sync.syncAllCatalogs();
    return CatalogSyncAllResponseSchema.parse({
      ok: true,
      results: outcomes.map((outcome) => ({
        ...outcome,
        ...(outcome.dbSha !== undefined ? { dbSha: outcome.dbSha } : {}),
        ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      })),
    });
  });

  // ── catalog browse/search (§6.6 + §6.8 live fallback) ────────────
  // Lookup order: installed catalog first (§6.4), then the §6.8 live
  // directory walk (module declares both directory events), then the
  // typed 404 envelope. The `source` discriminator tells the UI which
  // channel served the page. Cursor/error mapping is identical for
  // both channels (cursor complaints → 400; upstream failures → 502).
  const resolveCatalogPage = async (
    id: string,
    fromCatalog: () => CatalogPage,
    fromLive: (fallback: CatalogFallbackStore) => Promise<CatalogPage>,
  ): Promise<CatalogPageResponseT> => {
    if (services.catalogs.getMeta(id) !== undefined) {
      try {
        return CatalogPageResponseSchema.parse(toCatalogPageWire(fromCatalog(), 'catalog'));
      } catch (err: unknown) {
        throw catalogFailure(err);
      }
    }
    const fallback = services.catalogFallback;
    if (fallback === undefined || !fallback.supports(id)) {
      throw new ApiError(
        404,
        'not_found',
        `no catalog installed for ${id} and the module cannot serve a live directory walk ` +
          '(live fallback requires OnGetDirectoryPageNumber + OnGetNameAndLink, §6.8)',
      );
    }
    try {
      return CatalogPageResponseSchema.parse(toCatalogPageWire(await fromLive(fallback), 'live'));
    } catch (err: unknown) {
      throw fallbackFailure(err);
    }
  };

  app.get('/api/catalog/:id/latest', async (req): Promise<CatalogPageResponseT> => {
    const id = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['id'], 'catalog id');
    const query = parseOr400(CatalogBrowseQuerySchema, req.query, 'browse query');
    return resolveCatalogPage(
      id,
      (): CatalogPage => services.catalogs.latest(id, { page: query.page, limit: query.limit }),
      (fb): Promise<CatalogPage> => fb.latest(id, { page: query.page, limit: query.limit }),
    );
  });

  app.get('/api/catalog/:id/title', async (req): Promise<CatalogPageResponseT> => {
    const id = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['id'], 'catalog id');
    const query = parseOr400(CatalogBrowseQuerySchema, req.query, 'browse query');
    return resolveCatalogPage(
      id,
      (): CatalogPage => services.catalogs.byTitle(id, { page: query.page, limit: query.limit }),
      (fb): Promise<CatalogPage> => fb.byTitle(id, { page: query.page, limit: query.limit }),
    );
  });

  app.get('/api/catalog/:id/search', async (req): Promise<CatalogPageResponseT> => {
    const id = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['id'], 'catalog id');
    // Boundary normalization: `genres` accepts repeated params or one
    // comma-separated param (FMD2 custom-genres semantics) — both
    // become the array wire form before zod parsing.
    const rawQuery: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
    const genres: unknown = normalizeGenresParam(rawQuery['genres']);
    if (Array.isArray(genres) && genres.length > 0) {
      rawQuery['genres'] = genres;
    } else {
      delete rawQuery['genres'];
    }
    const query = parseOr400(CatalogSearchQuerySchema, rawQuery, 'search query');
    const searchInput: CatalogSearchQuery = {
      ...(query.q !== undefined && query.q !== '' ? { query: query.q } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
      ...(query.status !== undefined && query.status !== '' ? { status: query.status } : {}),
      ...(query.genre !== undefined && query.genre !== '' ? { genre: query.genre } : {}),
      ...(query.authors !== undefined && query.authors !== '' ? { authors: query.authors } : {}),
      ...(query.genres !== undefined && query.genres.length > 0 ? { genres: query.genres } : {}),
      genresMode: query.genresMode,
      ...(query.newDays !== undefined ? { newDays: query.newDays } : {}),
    };
    return resolveCatalogPage(
      id,
      (): CatalogPage => services.catalogs.search(id, searchInput),
      (fb): Promise<CatalogPage> => fb.search(id, searchInput),
    );
  });

  // ── all-sites union search (FMD2 cbSearchFromAllSites parity) ────
  // GET /api/search fans out over every INSTALLED catalog (never the
  // §6.8 live fallback — the FMD2 union is over local DBs), merges by
  // the documented comparator, and surfaces typed partial state.
  const unionSearch = new UnionSearchService(services.modules, services.catalogs);

  app.get('/api/search', async (req): Promise<AllSitesSearchResponseT> => {
    // Boundary normalization: `genres` accepts repeated params or one
    // comma-separated param (same wire forms as the per-site search).
    const rawQuery: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
    const genres: unknown = normalizeGenresParam(rawQuery['genres']);
    if (Array.isArray(genres) && genres.length > 0) {
      rawQuery['genres'] = genres;
    } else {
      delete rawQuery['genres'];
    }
    const query = parseOr400(AllSitesSearchQuerySchema, rawQuery, 'all-sites search query');
    return AllSitesSearchResponseSchema.parse(
      await unionSearch.search({
        ...(query.q !== undefined && query.q !== '' ? { q: query.q } : {}),
        ...(query.status !== undefined && query.status !== '' ? { status: query.status } : {}),
        ...(query.genres !== undefined && query.genres.length > 0 ? { genres: query.genres } : {}),
        genresMode: query.genresMode,
        ...(query.authors !== undefined && query.authors !== '' ? { authors: query.authors } : {}),
        ...(query.newDays !== undefined ? { newDays: query.newDays } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        limit: query.limit,
      }),
    );
  });

  // ── live info (§5.8, cached) ─────────────────────────────────────
  // §15 per-module series: every REAL module-engine call feeds the
  // request latency histogram + outcome counters (cache hits never
  // reach the engine and are not module requests).
  const instrumentInfo = async (
    moduleId: string,
    call: () => Promise<NormalizedInfo>,
  ): Promise<NormalizedInfo> => {
    if (options.metrics === undefined) {
      return call();
    }
    const started = performance.now();
    try {
      const info = await call();
      options.metrics.observeModuleRequest(moduleId, performance.now() - started, 'ok');
      return info;
    } catch (err: unknown) {
      options.metrics.observeModuleRequest(moduleId, performance.now() - started, 'error');
      throw err;
    }
  };

  app.post('/api/info', async (req): Promise<InfoResponseT> => {
    const body = parseOr400(InfoRequestSchema, req.body, 'info body');
    const key = infoCache.key(body.moduleId, body.url);
    const cached = infoCache.get(key, Date.now());
    if (cached !== undefined) {
      return InfoResponseSchema.parse(toInfoWire(cached));
    }
    let info: NormalizedInfo;
    try {
      info = await instrumentInfo(body.moduleId, () => services.info.getInfo(body.moduleId, body.url));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(
        502,
        'upstream_error',
        `module GetInfo failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    infoCache.set(key, info, Date.now());
    return InfoResponseSchema.parse(toInfoWire(info));
  });

  // ── jobs (§7.1, idempotent create) ───────────────────────────────
  app.post('/api/jobs/download', async (req, reply): Promise<JobCreatedResponseT> => {
    const body = parseOr400(JobCreateRequestSchema, req.body, 'download job body');
    const { job, replayed } = services.jobs.createDownload(
      {
        moduleId: body.moduleId,
        mangaUrl: body.mangaUrl,
        ...(body.mangaTitle !== undefined ? { mangaTitle: body.mangaTitle } : {}),
        chapterLink: body.chapterLink,
        ...(body.chapterName !== undefined ? { chapterName: body.chapterName } : {}),
      },
      body.idempotencyKey,
    );
    const wire = toJobWire(job);
    void reply.code(replayed ? 200 : 201);
    return JobCreatedResponseSchema.parse({ job: wire });
  });

  app.get('/api/jobs', async (req): Promise<JobsListResponseT> => {
    const query = parseOr400(JobsListQuerySchema, req.query, 'jobs query');
    const page = services.jobs.list({
      ...(query.state !== undefined ? { state: query.state } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    return JobsListResponseSchema.parse({
      jobs: page.jobs.map(toJobWire),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get('/api/jobs/:id', async (req): Promise<JobCreatedResponseT> => {
    const id = parseOr400(JobIdSchema, (req.params as Record<string, unknown>)['id'], 'job id');
    const job = services.jobs.get(id);
    if (job === undefined) {
      throw notFound('Job', id);
    }
    return JobCreatedResponseSchema.parse({ job: toJobWire(job) });
  });

  // §7.1 user cancellation: queued/running/retry → cancelled; the lane
  // aborts in-flight images (§4) and the persisted markers keep the
  // resume contract for the next attempt.
  app.post('/api/jobs/:id/cancel', async (req): Promise<JobCreatedResponseT> => {
    const id = parseOr400(JobIdSchema, (req.params as Record<string, unknown>)['id'], 'job id');
    const job = services.jobs.cancel(id);
    return JobCreatedResponseSchema.parse({ job: toJobWire(job) });
  });

  // ── library (§7.1 listing/download) ───────────────────────────────
  app.get('/api/library', async (req): Promise<LibraryListResponseT> => {
    const query = parseOr400(LibraryListQuerySchema, req.query, 'library query');
    const page = services.library.list({
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    return LibraryListResponseSchema.parse({
      files: page.files,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get('/api/library/:id/file', async (req, reply): Promise<unknown> => {
    const id = parseOr400(JobIdSchema, (req.params as Record<string, unknown>)['id'], 'library file id');
    const record = services.library.get(id);
    const path = services.library.resolveFile(id);
    if (record === undefined || path === undefined) {
      throw notFound('Library file', id);
    }
    const stream = createReadStream(path);
    void reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', record.bytes)
      .header('content-disposition', `attachment; filename="${record.fileName.replace(/"/g, '')}"`);
    return stream;
  });

  // ── favorites (§7.2 DoCheck engine + scheduler) ───────────────────
  app.get('/api/favorites', async (): Promise<FavoriteListResponseT> => {
    const favorites: FavoriteT[] = services.favorites.list();
    return FavoriteListResponseSchema.parse({ favorites });
  });

  app.post('/api/favorites', async (req, reply): Promise<FavoriteResponseT> => {
    const body = parseOr400(FavoriteCreateRequestSchema, req.body, 'favorite body');
    const favorite = await services.favorites.create(body);
    void reply.code(201);
    return FavoriteResponseSchema.parse({ favorite });
  });

  // D4 import path — the tag-100 transfer-favorite bulk-ingest.
  app.post('/api/favorites/import', async (req, reply): Promise<FavoriteResponseT> => {
    const body = parseOr400(FavoriteImportRequestSchema, req.body, 'favorite import body');
    let favorite: FavoriteT;
    try {
      favorite = await services.favorites.import(body);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(502, 'upstream_error', `module GetInfo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    void reply.code(201);
    return FavoriteResponseSchema.parse({ favorite });
  });

  app.get('/api/favorites/:id', async (req): Promise<FavoriteResponseT> => {
    const id = parseOr400(FavoriteIdSchema, (req.params as Record<string, unknown>)['id'], 'favorite id');
    const favorite = services.favorites.get(id);
    if (favorite === undefined) {
      throw notFound('Favorite', id);
    }
    return FavoriteResponseSchema.parse({ favorite });
  });

  // Title + the auto-download toggle (§7.2 pipeline eligibility).
  app.put('/api/favorites/:id', async (req): Promise<FavoriteResponseT> => {
    const id = parseOr400(FavoriteIdSchema, (req.params as Record<string, unknown>)['id'], 'favorite id');
    const patch = parseOr400(FavoriteUpdateRequestSchema, req.body, 'favorite update body');
    if (patch.title === undefined && patch.autoDownload === undefined) {
      throw new ApiError(400, 'validation_error', 'empty favorite update (nothing to change)');
    }
    return FavoriteResponseSchema.parse({ favorite: services.favorites.update(id, patch) });
  });

  app.delete('/api/favorites/:id', async (req, reply): Promise<{ ok: true }> => {
    const id = parseOr400(FavoriteIdSchema, (req.params as Record<string, unknown>)['id'], 'favorite id');
    services.favorites.remove(id);
    void reply.code(200);
    return { ok: true };
  });

  // Manual check-now: the immediate DoCheck cycle for ONE favorite
  // (live info → immediate CurrentChapter/Status update → diff →
  // auto-download when enabled). Live-fetch failures are upstream 502s.
  app.post('/api/favorites/:id/check', async (req): Promise<FavoriteCheckResponseT> => {
    const id = parseOr400(FavoriteIdSchema, (req.params as Record<string, unknown>)['id'], 'favorite id');
    try {
      const result = await services.favorites.checkNow(id);
      return FavoriteCheckResponseSchema.parse(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(502, 'upstream_error', `module GetInfo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return app;
}

export type {
  JobRecord,
  JobService,
  ModuleService,
  InfoService,
  SyncService,
  CatalogService,
  InfoResponseCache,
  AuthConfig,
  HealthStatus,
  ReadinessStatus,
};
export type { JobT as ApiJobT };
export { WsHub } from './ws/hub.js';
export type { WsHubOptions, WsHubStats, HubSocket } from './ws/hub.js';
export { attachWebSocketHub, DEFAULT_WS_PATH } from './ws/attach.js';
export type { WsAttachOptions, WsAttachment } from './ws/attach.js';
