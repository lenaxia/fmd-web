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
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import type {
  CatalogFallbackStore,
  CatalogPage,
  CatalogSearchQuery,
  HealthStatus,
  ReadinessStatus,
} from '@fmd/contract';
import { CatalogFallbackError, JobStateSchema, type JobStateT } from '@fmd/contract';
import type { FmdMetrics } from '../observability/metrics.js';
import { ApiError, toErrorBody, notFound, validationError } from './errors.js';
import {
  AccountListResponseSchema,
  AccountLoginResponseSchema,
  AccountResponseSchema,
  AccountUpsertRequestSchema,
  AllSitesSearchQuerySchema,
  AllSitesSearchResponseSchema,
  ApiTokenResponseSchema,
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
  JobBatchCreateRequestSchema,
  JobBatchCreatedResponseSchema,
  JobIdSchema,
  JobsListQuerySchema,
  JobsListResponseSchema,
  JobActionRequestSchema,
  JobActionResponseSchema,
  JobDeleteQuerySchema,
  JobDeletedResponseSchema,
  JobBulkActionRequestSchema,
  JobBulkActionResponseSchema,
  LibraryListQuerySchema,
  LibraryListResponseSchema,
  ModuleIdSchema,
  ModuleListResponseSchema,
  ModuleSummarySchema,
  ModuleUpdateRequestSchema,
  ModuleBulkUpdateRequestSchema,
  ModuleBulkUpdateResponseSchema,
  ModuleCheckResponseSchema,
  type ModuleCheckResponseT,
  OutputDefaultsUpdateRequestSchema,
  PerformanceSettingsUpdateRequestSchema,
  RetentionSettingsUpdateRequestSchema,
  FilenamePolicySettingsUpdateRequestSchema,
  DiagnosticsSettingsUpdateRequestSchema,
  ProxyUpdateRequestSchema,
  ReadyzResponseSchema,
  SettingsResponseSchema,
  SyncModulesResponseSchema,
  FavoriteCheckBatchCancelResponseSchema,
  FavoriteCheckBatchRequestSchema,
  FavoriteCheckBatchResponseSchema,
  FavoriteCheckResponseSchema,
  FavoriteCreateRequestSchema,
  FavoriteIdSchema,
  FavoriteImportRequestSchema,
  FavoriteListQuerySchema,
  FavoriteListResponseSchema,
  FavoriteResponseSchema,
  FavoriteSchedulerSettingsUpdateRequestSchema,
  FavoriteTransferPreviewRequestSchema,
  FavoriteTransferPreviewResponseSchema,
  FavoriteTransferRequestSchema,
  FavoriteTransferResponseSchema,
  FavoriteUpdateRequestSchema,
  Fmd2ImportApplyReportSchema,
  Fmd2ImportApplyRequestSchema,
  Fmd2ImportPreviewSchema,
  CoverQuerySchema,
  parseOr400,
  type AccountListResponseT,
  type AccountLoginResponseT,
  type AccountResponseT,
  type CatalogPageResponseT,
  type AllSitesSearchResponseT,
  type ApiTokenResponseT,
  type FavoriteCheckBatchCancelResponseT,
  type FavoriteCheckBatchResponseT,
  type FavoriteCheckResponseT,
  type FavoriteResponseT,
  type FavoriteTransferPreviewResponseT,
  type FavoriteTransferResponseT,
  type FavoriteT,
  type FavoriteListResponseT,
  type Fmd2ImportApplyReportT,
  type Fmd2ImportApplyRequestT,
  type Fmd2ImportPreviewT,
  type InfoResponseT,
  type JobCreatedResponseT,
  type JobBatchCreatedResponseT,
  type JobActionResponseT,
  type JobBulkActionResponseT,
  type JobDeletedResponseT,
  type JobT,
  type JobsListResponseT,
  type LibraryListResponseT,
  type ModuleBulkUpdateResponseT,
  type ModuleListResponseT,
  type SettingsResponseT,
  type ModuleSummaryT,
  type ReadyzResponseT,
} from './schemas.js';
import { registerAuth, AuthService, type AuthConfig } from './auth.js';
import { attachWebSocketHub, type WsAttachment } from './ws/attach.js';
import type { WsHub } from './ws/hub.js';
import { CoverProxyService } from './cover-proxy.js';
import type { SiteAvailabilityService } from '../runtime/site-availability.js';
import { InMemoryAccountService, type AccountService } from '../accounts/account-service.js';
import { Fmd2ImportService, FMD2_IMPORT_MAX_BYTES, type UploadedPart } from '../import/fmd2/service.js';
import {
  InfoResponseCache,
  InMemorySettingsService,
  resolveModuleByHost,
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
  /**
   * Cover art proxy (covers live-defect): same-origin cover fetching —
   * module-bound url validation (never an open proxy), Referer
   * hotlink posture, https-upgrade, on-disk cache. Optional with the
   * metrics-route posture: absent → GET /api/cover is not mounted
   * (API-only test fakes stay minimal); the runtime assembly always
   * wires the real one under FMD_WEB_DATA_DIR/covers.
   */
  readonly covers?: CoverProxyService;
  /**
   * Site availability (dead-site discovery): the persisted per-module
   * reachability record + the manual per-row Check probe. Optional
   * with the covers posture — absent → POST /api/modules/:id/check is
   * not mounted and /api/modules rows read availability: unknown; the
   * runtime assembly always wires the real one (app.db + the engine
   * thread probe).
   */
  readonly availability?: SiteAvailabilityService;
  /** Readiness probe input (default: always ready). */
  readonly readiness?: () => ReadinessStatus;
}

/**
 * R4 settings-audit event (structured log line; NEVER carries the
 * token value — the audit says WHAT changed, not the secret).
 */
export interface SettingsAuditEvent {
  readonly setting: string;
  readonly action: string;
}

export interface AppOptions {
  readonly version: string;
  /** When undefined, auth is disabled and every route is open. */
  readonly auth?: AuthConfig | undefined;
  /**
   * R4: pre-built auth service (runtime assembly) so the raw server's
   * /ws gate shares the SAME session store + token provider as this
   * app. Absent → built from `auth` above.
   */
  readonly authService?: AuthService;
  /**
   * R4 audit sink: settings-audit events (e.g. API token regeneration).
   * The runtime wires the structured logger; the event NEVER carries
   * the token value.
   */
  readonly onAudit?: (event: SettingsAuditEvent) => void;
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
    ...(job.paused === true ? { paused: true } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** The info wire body minus the addressing `moduleId` (added by the route). */
function toInfoWire(info: NormalizedInfo, downloaded: readonly string[]): Omit<InfoResponseT, 'moduleId'> {
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
    downloaded: [...downloaded],
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

  // ── multipart uploads (import-from-FMD2 only consumer) ───────────
  // buildApp stays sync; fastify queues plugin registration and loads
  // it at ready() — every consumer (inject, listen) triggers ready.
  // Per-file cap = the 100MB upload limit (DESIGN); the route ALSO
  // content-length pre-checks so oversize rejects before buffering.
  void app.register(multipart, {
    limits: {
      fileSize: FMD2_IMPORT_MAX_BYTES,
      files: 8,
      // The apply route carries a small `selections` JSON field too.
      fieldSize: 64 * 1024,
      fields: 4,
    },
  });

  // ── auth (§10 cookie flow + the R4 single API token) ─────────────
  // The runtime assembly may hand in a pre-built service so the raw
  // server's /ws gate (runtime-entry) shares the SAME session store +
  // token provider as this app; tests/buildApp-only hosts get a fresh
  // one from the config.
  const auth: AuthService = options.authService ?? new AuthService(options.auth ?? { password: undefined });
  registerAuth(app, auth);

  // ── /ws (§10 + D19) — real-socket upgrades only; inject never sees them ──
  // R4: the upgrade is credential-gated whenever the single API token
  // is active (header preferred; ?token= for browser clients; the
  // session cookie also grants when the password flow is on). Without
  // a token the hub is exactly as open as today.
  let wsAttachment: WsAttachment | undefined;
  if (options.wsHub !== undefined) {
    wsAttachment = attachWebSocketHub(app.server, options.wsHub, {
      authenticate: (req): boolean => auth.checkUpgradeRequest(req),
    });
    app.addHook('onClose', async (): Promise<void> => {
      wsAttachment?.dispose();
    });
  }

  // ── R4 observability: HTTP requests by auth mode (§4/§15) ────────
  if (options.metrics !== undefined) {
    const metrics = options.metrics;
    app.addHook(
      'onResponse',
      (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
        const route = typeof req.routeOptions?.url === 'string' ? req.routeOptions.url : 'unrouted';
        metrics.observeHttpRequest(auth.resolveRequestAuth(req), req.method.toUpperCase(), route, reply.statusCode);
        done();
      },
    );
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

  // Import-from-FMD2 (two-phase API): favorites go through the ONE
  // import code path (services.favorites.import — offline seed mode),
  // settings through the SettingsService setters, credentials through
  // the account store when one is wired (the in-memory dev default is
  // NOT handed in — an ephemeral store would report false success).
  const fmd2Import = new Fmd2ImportService(services.modules, settings, services.favorites, services.accounts);

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

  // Bulk enable/disable (FMD2 Websites-tree parity, pas:6400 Select
  // All/Unselect All + per-category checkboxes): one write over many
  // module_state rows via the SAME update seam (option/cookie/proxy
  // state is untouched; unknown ids/categories update nothing — the
  // response carries the resolved module set + count).
  app.post('/api/modules/bulk', async (req): Promise<ModuleBulkUpdateResponseT> => {
    const body = parseOr400(ModuleBulkUpdateRequestSchema, req.body, 'module bulk update body');
    const targets: ModuleSummaryT[] = services.modules
      .list()
      .filter((m): boolean =>
        body.ids !== undefined
          ? body.ids.includes(m.id)
          : body.category !== undefined
            ? m.category === body.category
            : true,
      );
    const updated: ModuleSummaryT[] = targets.map((m): ModuleSummaryT =>
      services.modules.update(m.id, { enabled: body.enabled }),
    );
    return ModuleBulkUpdateResponseSchema.parse({ modules: updated, updated: updated.length });
  });

  // ── site availability (dead-site discovery) ───────────────────────
  // Manual per-row Check (Settings registry): ONE probe of the module
  // RootURL through the module's own engine HTTP path (worker-isolated
  // in production). Deliberately SINGLE-site — batch check-all is a
  // documented deferral (anti-bot risk + low value; revisit when
  // cold-start friction is felt). Typed errors only, never a 500 from
  // the probe's own failure classification; a 4xx origin answer is NOT
  // an error — verdict 'none' reports the intentional no-write.
  if (services.availability !== undefined) {
    const availability = services.availability;
    app.post('/api/modules/:id/check', async (req): Promise<ModuleCheckResponseT> => {
      const id = parseOr400(ModuleIdSchema, (req.params as Record<string, unknown>)['id'], 'module id');
      const result = await availability.check(id);
      return ModuleCheckResponseSchema.parse(result);
    });
  }

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

  // Output defaults (FMD2 Save-to options parity, additive): default
  // archive format + chapter filename template — honored by the
  // download lane on NEW jobs (packer selection + §7.1 finalize).
  app.put('/api/settings/output', async (req): Promise<SettingsResponseT> => {
    const output = parseOr400(OutputDefaultsUpdateRequestSchema, req.body, 'output defaults body');
    return SettingsResponseSchema.parse(settings.setOutput(output));
  });

  // [parity-sweep] M10: Performance group (FMD2 Connections subset) —
  // request timeout (HTTP pipeline default), retry count (per-image
  // budget), parallel chapters (lane slots, restart to apply),
  // threads per chapter (image-worker width).
  app.put('/api/settings/performance', async (req): Promise<SettingsResponseT> => {
    const performance = parseOr400(PerformanceSettingsUpdateRequestSchema, req.body, 'performance settings body');
    return SettingsResponseSchema.parse(settings.setPerformance(performance));
  });

  // [parity-sweep] M2: job-history retention — auto-delete finished
  // job history after N days (0 = keep forever); drives the prune sweep.
  app.put('/api/settings/retention', async (req): Promise<SettingsResponseT> => {
    const retention = parseOr400(RetentionSettingsUpdateRequestSchema, req.body, 'retention settings body');
    return SettingsResponseSchema.parse(settings.setRetention(retention));
  });

  // [parity-sweep] M4: filename policy — Linux-normalized vs the
  // FMD2-desktop-parity default (precedence: env > setting > parity).
  app.put('/api/settings/filename-policy', async (req): Promise<SettingsResponseT> => {
    const policy = parseOr400(FilenamePolicySettingsUpdateRequestSchema, req.body, 'filename policy body');
    return SettingsResponseSchema.parse(settings.setFilenamePolicy(policy));
  });

  // [parity-sweep] M13: diagnostics — structured-log enable + level.
  app.put('/api/settings/diagnostics', async (req): Promise<SettingsResponseT> => {
    const diagnostics = parseOr400(DiagnosticsSettingsUpdateRequestSchema, req.body, 'diagnostics settings body');
    return SettingsResponseSchema.parse(settings.setDiagnostics(diagnostics));
  });

  // Favorites scheduler settings (Options → Updates parity, additive):
  // check interval minutes (0 = off) + check-at-startup — the interval
  // applies LIVE to the running scheduler (idle re-arm), the startup
  // toggle gates the next boot's initial sweep.
  app.put('/api/settings/favorites', async (req): Promise<SettingsResponseT> => {
    const body = parseOr400(
      FavoriteSchedulerSettingsUpdateRequestSchema,
      req.body,
      'favorites scheduler settings body',
    );
    return SettingsResponseSchema.parse(settings.setFavoritesSettings(body));
  });

  // ── R4 single app-wide API token (Settings → API) ─────────────────
  // GET is credential-gated in EVERY authed mode (the token secret must
  // never ride an open read — the auth hook holds TOKEN_SECRET_ROUTES);
  // the value only travels here and in the regenerate response.
  app.get('/api/settings/api-token', async (): Promise<ApiTokenResponseT> => {
    return ApiTokenResponseSchema.parse({
      token: auth.tokenEnvManaged ? null : (auth.effectiveApiToken() ?? null),
      envManaged: auth.tokenEnvManaged,
      mode: auth.authMode(),
    });
  });

  // Regenerate rotates the ONE value in place (old key rejected on the
  // next request — the provider reads the store live). Env-pinned
  // deployments refuse: the secret lives in the environment, rotate it
  // there. Rotation needs NO password auth: the token is an *arr-style
  // script key — a reverse-proxy deployment (password unset) rotates it
  // like any other, and with auth off the API stays open to the SPA
  // regardless (token existence never gates).
  app.post('/api/settings/api-token/regenerate', async (): Promise<ApiTokenResponseT> => {
    if (auth.tokenEnvManaged) {
      throw new ApiError(
        409,
        'conflict',
        'API token is pinned via FMD_WEB_API_TOKEN (managed environment) — rotate it in the deployment environment',
      );
    }
    const token = randomBytes(32).toString('hex');
    settings.setApiToken(token);
    options.onAudit?.({ setting: 'api_token', action: 'regenerate' });
    return ApiTokenResponseSchema.parse({ token, envManaged: false, mode: auth.authMode() });
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
    const genresExclude: unknown = normalizeGenresParam(rawQuery['genresExclude']);
    if (Array.isArray(genresExclude) && genresExclude.length > 0) {
      rawQuery['genresExclude'] = genresExclude;
    } else {
      delete rawQuery['genresExclude'];
    }
    const query = parseOr400(CatalogSearchQuerySchema, rawQuery, 'search query');
    const searchInput: CatalogSearchQuery = {
      ...(query.q !== undefined && query.q !== '' ? { query: query.q } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
      ...(query.status !== undefined && query.status !== '' ? { status: query.status } : {}),
      ...(query.genre !== undefined && query.genre !== '' ? { genre: query.genre } : {}),
      ...(query.authors !== undefined && query.authors !== '' ? { authors: query.authors } : {}),
      ...(query.artists !== undefined && query.artists !== '' ? { artists: query.artists } : {}),
      ...(query.summary !== undefined && query.summary !== '' ? { summary: query.summary } : {}),
      ...(query.genres !== undefined && query.genres.length > 0 ? { genres: query.genres } : {}),
      ...(query.genresExclude !== undefined && query.genresExclude.length > 0
        ? { genresExclude: query.genresExclude }
        : {}),
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
    const genresExclude: unknown = normalizeGenresParam(rawQuery['genresExclude']);
    if (Array.isArray(genresExclude) && genresExclude.length > 0) {
      rawQuery['genresExclude'] = genresExclude;
    } else {
      delete rawQuery['genresExclude'];
    }
    const query = parseOr400(AllSitesSearchQuerySchema, rawQuery, 'all-sites search query');
    return AllSitesSearchResponseSchema.parse(
      await unionSearch.search({
        ...(query.q !== undefined && query.q !== '' ? { q: query.q } : {}),
        ...(query.status !== undefined && query.status !== '' ? { status: query.status } : {}),
        ...(query.genres !== undefined && query.genres.length > 0 ? { genres: query.genres } : {}),
        ...(query.genresExclude !== undefined && query.genresExclude.length > 0
          ? { genresExclude: query.genresExclude }
          : {}),
        genresMode: query.genresMode,
        ...(query.authors !== undefined && query.authors !== '' ? { authors: query.authors } : {}),
        ...(query.artists !== undefined && query.artists !== '' ? { artists: query.artists } : {}),
        ...(query.summary !== undefined && query.summary !== '' ? { summary: query.summary } : {}),
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
    // [parity-sweep] M14 (FMD2 edURL parity): a url-only body resolves
    // the module by RootURL host; unknown/ambiguous hosts are TYPED
    // errors ('no site matches this URL').
    let moduleId: string = body.moduleId ?? '';
    if (moduleId === '') {
      const resolved = resolveModuleByHost(services.modules.list(), body.url);
      if ('moduleId' in resolved) {
        moduleId = resolved.moduleId;
      } else if ('ambiguous' in resolved) {
        throw new ApiError(
          400,
          'ambiguous_site',
          `multiple sites match this URL's host: ${resolved.candidates.join(', ')}`,
        );
      } else {
        throw new ApiError(400, 'no_site_match', 'no site matches this URL');
      }
    }
    // Catalog links are stored HOST-RELATIVE (§5.8 RemoveHostFromURLsPair
    // parity) — join against the addressed module's RootURL before any
    // downstream use (FMD2 MaybeFillHost parity). One canonical absolute
    // URL flows to the cache key, the downloaded ledger, and the engine.
    let url: string = body.url;
    if (!/^https?:\/\//i.test(url)) {
      const module = services.modules.list().find((m): boolean => m.id === moduleId);
      const root: string | undefined = module?.rootURL;
      if (root !== undefined && root !== '') {
        try {
          url = new URL(url, root).toString();
        } catch {
          // malformed join — let the engine surface the typed failure
        }
      }
    }
    const key = infoCache.key(moduleId, url);
    // The downloaded set is computed at RESPONSE time (never cached with
    // the info snapshot) so a just-finished download flips the set on
    // the very next call, cache hit or not.
    const downloaded = services.library.downloadedChapters(moduleId, url);
    const cached = infoCache.get(key, Date.now());
    if (cached !== undefined) {
      return InfoResponseSchema.parse({ moduleId, ...toInfoWire(cached, downloaded) });
    }
    let info: NormalizedInfo;
    try {
      info = await instrumentInfo(moduleId, () => services.info.getInfo(moduleId, url));
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
    return InfoResponseSchema.parse({
      moduleId,
      ...toInfoWire(info, services.library.downloadedChapters(moduleId, url)),
    });
  });

  // ── cover art proxy (covers live-defect; mounted only when the
  // service is bound) ───────────────────────────────────────────────
  // Module GetInfo returns ABSOLUTE CDN cover urls the browser can
  // never load behind `img-src 'self' data: blob:` (+ mixed content on
  // the http:// forms) — this is the ONE same-origin seam. The service
  // validates the url against the ADDRESSED module's permitted hosts
  // (RootURL domain + curated image-CDN allowance; foreign hosts 400,
  // never an open proxy), fetches with the module HTTP posture
  // (Referer = RootURL for the fmcdn hotlink check) and serves the
  // upstream image/* bytes with cache-friendly headers backed by the
  // FMD_WEB_DATA_DIR/covers disk cache. A plain GET — never gated
  // (the *arr ordering; covers are not secrets).
  if (services.covers !== undefined) {
    const covers = services.covers;
    app.get('/api/cover', async (req, reply): Promise<Uint8Array> => {
      const query = parseOr400(CoverQuerySchema, req.query, 'cover query');
      const cover = await covers.get(query.moduleId, query.url);
      void reply
        .code(200)
        .header('content-type', cover.contentType)
        .header('cache-control', `public, max-age=${cover.maxAgeSeconds}`)
        .header('x-fmd-cover-cache', cover.fromCache ? 'hit' : 'miss')
        .send(cover.bytes);
      return cover.bytes;
    });
  }

  // ── jobs (§7.1, idempotent create) ───────────────────────────────
  // One canonical absolute manga URL (v0.3.1 /api/info principle): the
  // download settle cascade keys `downloaded_chapters` by job.mangaUrl —
  // joining host-relative links against the module RootURL here keeps
  // the ledger key identical to the /api/info lookup key.
  const canonicalMangaUrl = (moduleId: string, url: string): string => {
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    const root = services.modules.list().find((m): boolean => m.id === moduleId)?.rootURL;
    if (root !== undefined && root !== '') {
      try {
        return new URL(url, root).toString();
      } catch {
        // malformed join — enqueue verbatim; the engine surfaces it
      }
    }
    return url;
  };

  app.post('/api/jobs/download', async (req, reply): Promise<JobCreatedResponseT> => {
    const body = parseOr400(JobCreateRequestSchema, req.body, 'download job body');
    const { job, replayed } = services.jobs.createDownload(
      {
        moduleId: body.moduleId,
        mangaUrl: canonicalMangaUrl(body.moduleId, body.mangaUrl),
        ...(body.mangaTitle !== undefined ? { mangaTitle: body.mangaTitle } : {}),
        chapterLink: body.chapterLink,
        ...(body.chapterName !== undefined ? { chapterName: body.chapterName } : {}),
        ...(body.paused !== undefined ? { paused: body.paused } : {}),
        ...(body.saveTo !== undefined ? { saveTo: body.saveTo } : {}),
      },
      body.idempotencyKey,
    );
    const wire = toJobWire(job);
    void reply.code(replayed ? 200 : 201);
    return JobCreatedResponseSchema.parse({ job: wire });
  });

  // ── batch download-all (browse row menu; FMD2 pmMangaList
  // miMangaListDownloadAll parity — one task per MANGA mental model).
  //
  // `chapters: 'all'` resolves the live chapter list through the SAME
  // cached §5.8 info path POST /api/info uses; an explicit selection
  // enqueues verbatim (no info fetch). Every per-chapter create reuses
  // the §10 idempotent createDownload with a derived key
  // `<batchKey>:<index>` — replay while live returns the SAME jobs, a
  // changed chapter sequence under the same key surfaces the per-chapter
  // 409 (different payload), and terminal originals chain re-downloads
  // exactly like the single-chapter endpoint.
  app.post('/api/jobs/download/batch', async (req, reply): Promise<JobBatchCreatedResponseT> => {
    const body = parseOr400(JobBatchCreateRequestSchema, req.body, 'download batch body');
    const mangaUrl = canonicalMangaUrl(body.moduleId, body.mangaUrl);
    let chapterLinks: string[];
    let chapterNames: ReadonlyMap<string, string>;
    if (Array.isArray(body.chapters)) {
      chapterLinks = [...body.chapters];
      chapterNames = new Map();
    } else {
      const key = infoCache.key(body.moduleId, mangaUrl);
      const cached = infoCache.get(key, Date.now());
      let info: NormalizedInfo | undefined = cached;
      if (info === undefined) {
        try {
          info = await instrumentInfo(body.moduleId, () =>
            services.info.getInfo(body.moduleId, mangaUrl),
          );
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
      }
      chapterLinks = [...info.chapterLinks];
      chapterNames = new Map(
        info.chapterNames
          .map((name, i): [string, string] | undefined =>
            info!.chapterLinks[i] !== undefined ? [info!.chapterLinks[i], name] : undefined,
          )
          .filter((pair): pair is [string, string] => pair !== undefined),
      );
    }
    const results = chapterLinks.map((chapterLink, index) => {
      const chapterName = chapterNames.get(chapterLink);
      return services.jobs.createDownload(
        {
          moduleId: body.moduleId,
          mangaUrl,
          ...(body.mangaTitle !== undefined ? { mangaTitle: body.mangaTitle } : {}),
          chapterLink,
          ...(chapterName !== undefined ? { chapterName } : {}),
          ...(body.paused !== undefined ? { paused: body.paused } : {}),
          ...(body.saveTo !== undefined ? { saveTo: body.saveTo } : {}),
        },
        `${body.idempotencyKey}:${String(index)}`,
      );
    });
    void reply.code(results.length > 0 && results.every((r): boolean => r.replayed) ? 200 : 201);
    return JobBatchCreatedResponseSchema.parse({
      jobs: results.map((r): JobT => toJobWire(r.job)),
      replayed: results.length > 0 && results.every((r): boolean => r.replayed),
    });
  });

  app.get('/api/jobs', async (req): Promise<JobsListResponseT> => {
    const query = parseOr400(JobsListQuerySchema, req.query, 'jobs query');
    // Downloads parity: `states` is a csv multi-select — validate every
    // member against the §7.1 enum (400 validation_error on a bad one).
    let states: JobStateT[] | undefined;
    if (query.states !== undefined) {
      const parsed = query.states.split(',').map((value): JobStateT => {
        const result = JobStateSchema.safeParse(value);
        if (!result.success) {
          throw validationError(`unknown job state in states filter: ${JSON.stringify(value)}`, result.error.issues);
        }
        return result.data;
      });
      if (parsed.length > 0) {
        states = parsed;
      }
    }
    const page = services.jobs.list({
      ...(query.state !== undefined ? { state: query.state } : {}),
      ...(states !== undefined ? { states } : {}),
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.addedFrom !== undefined ? { addedFrom: query.addedFrom } : {}),
      ...(query.addedTo !== undefined ? { addedTo: query.addedTo } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
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

  // cbAddAsStopped parity: lift the add-as-stopped hold on a live job —
  // the row was created queued+paused and becomes claimable; terminal
  // rows are 409 (nothing to resume), an unpaused row is a no-op replay.
  app.post('/api/jobs/:id/resume', async (req): Promise<JobCreatedResponseT> => {
    const id = parseOr400(JobIdSchema, (req.params as Record<string, unknown>)['id'], 'job id');
    const job = services.jobs.resume(id);
    return JobCreatedResponseSchema.parse({ job: toJobWire(job) });
  });

  // ── downloads parity (FMD2 pmDownload, web-adapted) ────────────────
  // ONE typed-union action route (pause/resume/retry/redownload/enable/
  // disable); the legality matrix lives in the job services and illegal
  // applications surface the typed 409 envelope with {job, action}
  // details. Re-enqueue semantics (resume-of-cancelled, retry,
  // redownload) chain a FRESH attempt that resumes from markers.
  app.post('/api/jobs/:id/action', async (req): Promise<JobActionResponseT> => {
    const id = parseOr400(JobIdSchema, (req.params as Record<string, unknown>)['id'], 'job id');
    const body = parseOr400(JobActionRequestSchema, req.body, 'job action body');
    const job = services.jobs.action(id, body.type);
    return JobActionResponseSchema.parse({ job: toJobWire(job) });
  });

  // Delete task (FMD2 miDownloadDeleteTask | miDownloadDeleteTaskData):
  // `?data=true` also removes the finalized artifact recorded by the
  // job (library file + row) — "job only" keeps the download on disk.
  app.delete('/api/jobs/:id', async (req): Promise<JobDeletedResponseT> => {
    const id = parseOr400(JobIdSchema, (req.params as Record<string, unknown>)['id'], 'job id');
    const query = parseOr400(JobDeleteQuerySchema, req.query, 'job delete query');
    const { job, dataDeleted } = services.jobs.remove(id, { ...(query.data === true ? { data: true } : {}) });
    return JobDeletedResponseSchema.parse({ job: toJobWire(job), dataDeleted });
  });

  // Toolbar bulk ops (FMD2 tsDownload toolbar): Resume all / Pause all
  // over scope `all`, Delete completed over scope `completed`
  // (RemoveAllFinishedTasks — done rows only). Idempotent: a settled
  // queue returns affected: 0.
  app.post('/api/jobs/bulk-action', async (req): Promise<JobBulkActionResponseT> => {
    const body = parseOr400(JobBulkActionRequestSchema, req.body, 'job bulk action body');
    const result = services.jobs.bulkAction(body);
    return JobBulkActionResponseSchema.parse({
      action: result.action,
      scope: result.scope,
      affected: result.affected,
      jobs: result.jobs,
    });
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

  // [UX-AUDIT L-2] delete-one-artifact from the library row (the
  // finished-file management that previously lived only on the
  // Downloads job's delete+data action — a job deleted after
  // finalization left its file unreachable from the UI).
  app.delete('/api/library/:id', async (req): Promise<{ ok: true }> => {
    const id = parseOr400(JobIdSchema, (req.params as Record<string, unknown>)['id'], 'library file id');
    if (!services.library.remove(id)) {
      throw notFound('Library file', id);
    }
    return { ok: true };
  });

  // ── favorites (§7.2 DoCheck engine + scheduler) ───────────────────
  // R5 arrival (additive): `?since=<ISO>` switches each row's additive
  // `newsSince` flag on — "a check ran at/after `since` and found new
  // chapters" — the favorites half of the away summary. Without the
  // param the rows are exactly the pre-R5 shape (flag omitted).
  app.get('/api/favorites', async (req): Promise<FavoriteListResponseT> => {
    const query = parseOr400(FavoriteListQuerySchema, req.query, 'favorites query');
    const sinceMs = query.since !== undefined ? Date.parse(query.since) : undefined;
    const favorites: FavoriteT[] = services.favorites.list().map((favorite): FavoriteT => {
      if (
        sinceMs === undefined ||
        favorite.lastCheck === null ||
        favorite.newChapterCount <= 0 ||
        Date.parse(favorite.lastCheck) < sinceMs
      ) {
        return favorite;
      }
      return { ...favorite, newsSince: true };
    });
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
      ({ favorite } = await services.favorites.import(body));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(502, 'upstream_error', `module GetInfo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    void reply.code(201);
    return FavoriteResponseSchema.parse({ favorite });
  });

  // Composite favorite ids are `<moduleId>/<url>` and the url is often
  // HOST-RELATIVE (catalog links, §5.8) — the id carries slashes and
  // the browser percent-encodes them (`%2F`). This app's `:id` routes
  // decode that form fine, but intermediary hops (reverse proxies, the
  // dev-preview tunnel) routinely decode `%2F` into literal path
  // slashes before the request arrives — find-my-way matches `:id` as
  // ONE segment and refuses mid-path wildcards, so the decoded shape
  // died as a routing 404 (the owner-reported auto-download toggle
  // failure on an existing favorite). BOTH wire shapes are now
  // accepted: the `:id` routes keep the encoded form; `*` routes catch
  // the decoded form and reassemble the tail into the composite id.
  // The POST family's id-suffixed routes (`/check`, `/transfer`,
  // `/transfer/preview`) dispatch by suffix inside the wildcard
  // handler — find-my-way orders static > param > wildcard, so
  // `/api/favorites/check`, `/check/cancel` and `/import` keep their
  // exact routes either way.
  const normalizeFavoriteId = (id: string): string => {
    // A double-encoding hop (`%252F`) leaves the separator literally
    // in the param. The verbatim key stays authoritative; the decoded
    // spelling is only tried when it alone resolves a stored row.
    if (!/%2[fF]/.test(id)) {
      return id;
    }
    const decoded = id.replace(/%2[fF]/g, '/');
    return services.favorites.get(decoded) !== undefined && services.favorites.get(id) === undefined
      ? decoded
      : id;
  };

  const favoriteId = (req: FastifyRequest): string => {
    const params = req.params as Record<string, unknown>;
    const raw = typeof params['*'] === 'string' ? params['*'] : params['id'];
    return parseOr400(FavoriteIdSchema, normalizeFavoriteId(typeof raw === 'string' ? raw : ''), 'favorite id');
  };

  const favoriteGet = async (id: string): Promise<FavoriteResponseT> => {
    const favorite = services.favorites.get(id);
    if (favorite === undefined) {
      throw notFound('Favorite', id);
    }
    return FavoriteResponseSchema.parse({ favorite });
  };

  // Title + the auto-download toggle + save-to + enable/disable
  // (§7.2 pipeline eligibility, pmFavorites parity).
  const favoriteUpdate = async (id: string, req: FastifyRequest): Promise<FavoriteResponseT> => {
    const patch = parseOr400(FavoriteUpdateRequestSchema, req.body, 'favorite update body');
    if (
      patch.title === undefined &&
      patch.autoDownload === undefined &&
      patch.saveTo === undefined &&
      patch.enabled === undefined
    ) {
      throw new ApiError(400, 'validation_error', 'empty favorite update (nothing to change)');
    }
    return FavoriteResponseSchema.parse({ favorite: services.favorites.update(id, patch) });
  };

  const favoriteRemove = (id: string): { ok: true } => {
    services.favorites.remove(id);
    return { ok: true };
  };

  // Manual check-now: the immediate DoCheck cycle for ONE favorite
  // (live info → immediate CurrentChapter/Status update → diff →
  // auto-download when enabled). Live-fetch failures are upstream 502s.
  const favoriteCheckNow = async (id: string): Promise<FavoriteCheckResponseT> => {
    try {
      const result = await services.favorites.checkNow(id);
      return FavoriteCheckResponseSchema.parse(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(502, 'upstream_error', `module GetInfo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  app.get('/api/favorites/:id', async (req): Promise<FavoriteResponseT> => favoriteGet(favoriteId(req)));
  app.get('/api/favorites/*', async (req): Promise<FavoriteResponseT> => favoriteGet(favoriteId(req)));

  app.put('/api/favorites/:id', async (req): Promise<FavoriteResponseT> => favoriteUpdate(favoriteId(req), req));
  app.put('/api/favorites/*', async (req): Promise<FavoriteResponseT> => favoriteUpdate(favoriteId(req), req));

  app.delete('/api/favorites/:id', async (req, reply): Promise<{ ok: true }> => {
    void reply.code(200);
    return favoriteRemove(favoriteId(req));
  });
  app.delete('/api/favorites/*', async (req, reply): Promise<{ ok: true }> => {
    void reply.code(200);
    return favoriteRemove(favoriteId(req));
  });

  app.post('/api/favorites/:id/check', async (req): Promise<FavoriteCheckResponseT> => favoriteCheckNow(favoriteId(req)));

  // ── favorites batch check (btFavoritesCheckNewChapter + cancel) ──
  app.post('/api/favorites/check', async (req): Promise<FavoriteCheckBatchResponseT> => {
    const body = parseOr400(FavoriteCheckBatchRequestSchema, req.body ?? {}, 'favorite check batch body');
    return FavoriteCheckBatchResponseSchema.parse(await services.favorites.checkBatch(body.scope));
  });

  app.post('/api/favorites/check/cancel', async (): Promise<FavoriteCheckBatchCancelResponseT> => {
    return FavoriteCheckBatchCancelResponseSchema.parse({ cancelled: services.favorites.cancelBatch() });
  });

  // ── favorites website transfer (frmTransferFavorites parity) ─────
  const favoriteTransferPreview = async (
    id: string,
    req: FastifyRequest,
  ): Promise<FavoriteTransferPreviewResponseT> => {
    const body = parseOr400(
      FavoriteTransferPreviewRequestSchema,
      req.body,
      'favorite transfer preview body',
    );
    return FavoriteTransferPreviewResponseSchema.parse(
      await services.favorites.transferPreview(id, body.targetModuleId),
    );
  };

  const favoriteTransfer = async (id: string, req: FastifyRequest): Promise<FavoriteTransferResponseT> => {
    const body = parseOr400(FavoriteTransferRequestSchema, req.body, 'favorite transfer body');
    // Resolve the mapping first (the dry-run validation IS the gate —
    // an invalid target is a typed 409, never a silent remap).
    const preview = await services.favorites.transferPreview(id, body.targetModuleId);
    if (!preview.valid || preview.targetUrl === null) {
      throw new ApiError(
        409,
        'conflict',
        `transfer target invalid (${preview.reason ?? 'not-found'}): ${body.targetModuleId}`,
      );
    }
    const result = await services.favorites.transfer(id, {
      moduleId: body.targetModuleId,
      url: preview.targetUrl,
      clearDownloadedList: body.clearDownloadedList,
    });
    return FavoriteTransferResponseSchema.parse(result);
  };

  app.post('/api/favorites/:id/transfer/preview', async (req): Promise<FavoriteTransferPreviewResponseT> =>
    favoriteTransferPreview(favoriteId(req), req),
  );

  app.post('/api/favorites/:id/transfer', async (req): Promise<FavoriteTransferResponseT> =>
    favoriteTransfer(favoriteId(req), req),
  );

  // Decoded composite id + suffix dispatch (see the favorites id block
  // comment above): `POST /api/favorites/<id-with-slashes>/check` and
  // the transfer variants. A tail carrying none of the suffixes is NOT
  // a route (there is no bare `POST /api/favorites/:id`) — the typed
  // route-not-found envelope answers, exactly as before.
  app.post('/api/favorites/*', async (req): Promise<unknown> => {
    const tail = (req.params as Record<string, unknown>)['*'];
    if (typeof tail !== 'string') {
      throw new ApiError(404, 'not_found', 'route not found');
    }
    for (const suffix of ['/transfer/preview', '/transfer', '/check']) {
      if (!tail.endsWith(suffix)) {
        continue;
      }
      const id = parseOr400(
        FavoriteIdSchema,
        normalizeFavoriteId(tail.slice(0, tail.length - suffix.length)),
        'favorite id',
      );
      if (suffix === '/transfer/preview') {
        return favoriteTransferPreview(id, req);
      }
      if (suffix === '/transfer') {
        return favoriteTransfer(id, req);
      }
      return favoriteCheckNow(id);
    }
    throw new ApiError(404, 'not_found', 'route not found');
  });

  // ── import from FMD2 (two-phase: analyze → apply) ────────────────
  app.post('/api/import/fmd2/analyze', async (req): Promise<Fmd2ImportPreviewT> => {
    const upload = await collectMultipartUpload(req, 'FMD2 analyze');
    const preview = fmd2Import.analyze(upload.parts);
    return Fmd2ImportPreviewSchema.parse(preview);
  });

  app.post('/api/import/fmd2/apply', async (req): Promise<Fmd2ImportApplyReportT> => {
    let parts: readonly UploadedPart[];
    let selections: Fmd2ImportApplyRequestT;
    if (typeof req.isMultipart === 'function' && req.isMultipart()) {
      const upload = await collectMultipartUpload(req, 'FMD2 apply');
      parts = upload.parts;
      selections =
        upload.fields['selections'] === undefined
          ? {}
          : parseOr400(Fmd2ImportApplyRequestSchema, safeJson(upload.fields['selections']), 'FMD2 apply selections field');
    } else {
      const body = parseOr400(Fmd2ImportApplyRequestSchema, req.body, 'FMD2 apply body');
      if (body.token === undefined) {
        throw new ApiError(400, 'bad_request', 'FMD2 apply needs either the multipart upload or the analyze token');
      }
      parts = fmd2Import.stagedParts(body.token);
      selections = body;
    }
    const report = await fmd2Import.apply(parts, selections);
    return Fmd2ImportApplyReportSchema.parse(report);
  });

  return app;
}

// ── multipart upload collection (import-from-FMD2) ──────────────────

interface CollectedUpload {
  readonly parts: readonly UploadedPart[];
  readonly fields: Readonly<Record<string, string>>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Collect one multipart request into file parts + form fields, mapping
 * every failure mode to a typed 400 (never a 500): wrong content type,
 * the 100MB cap (content-length pre-check AND the per-file stream
 * limit), malformed bodies. An upload with NO files lets the analyze
 * service render its own 'no recognizable FMD2 file' 400.
 */
async function collectMultipartUpload(req: FastifyRequest, what: string): Promise<CollectedUpload> {
  if (typeof req.isMultipart !== 'function' || !req.isMultipart()) {
    throw new ApiError(400, 'bad_request', `${what}: multipart/form-data with the FMD2 file(s) is required`);
  }
  const contentLength = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(contentLength) && contentLength > FMD2_IMPORT_MAX_BYTES + 1024 * 1024) {
    throw new ApiError(400, 'bad_request', `${what}: upload exceeds the 100 MB cap`);
  }
  const parts: UploadedPart[] = [];
  const fields: Record<string, string> = {};
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.filename === '') {
          continue; // empty file input (nothing chosen)
        }
        if (part.file.truncated) {
          throw new ApiError(400, 'bad_request', `${what}: ${part.filename} exceeds the 100 MB cap`);
        }
        const bytes = await part.toBuffer();
        if (bytes.length > FMD2_IMPORT_MAX_BYTES) {
          throw new ApiError(400, 'bad_request', `${what}: ${part.filename} exceeds the 100 MB cap`);
        }
        parts.push({ name: part.filename, bytes });
      } else {
        fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value ?? '');
      }
    }
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    // @fastify/multipart limit errors (RequestFileTooLargeError etc.)
    throw new ApiError(
      400,
      'bad_request',
      `${what}: unreadable multipart body (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return { parts, fields };
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
