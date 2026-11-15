/**
 * OpenAPI 3.1 generation from the §10 zod schemas (DESIGN.md §10,
 * contract-based API). The zod schemas in `schemas.ts` are the single
 * source of truth: this module converts them with zod's native JSON
 * Schema output (draft 2020-12), hoists shared definitions into
 * `components.schemas`, and assembles the document. The result is
 * committed as a snapshot (`openapi.snapshot.json`) and a test fails
 * on any unintended drift; regenerate intentionally with
 * `API_OPENAPI_SNAPSHOT=write npm test -- openapi`.
 */
import { z } from 'zod';
import {
  ApiErrorEnvelopeSchema,
  CatalogEntrySchema,
  HealthzResponseSchema,
  InfoRequestSchema,
  InfoResponseSchema,
  FavoriteCheckResponseSchema,
  FavoriteCreateRequestSchema,
  FavoriteListResponseSchema,
  FavoriteResponseSchema,
  FavoriteSchema,
  FavoriteUpdateRequestSchema,
  JobCreateRequestSchema,
  JobCreatedResponseSchema,
  JobSchema,
  JobsListQuerySchema,
  JobsListResponseSchema,
  LibraryFileSchema,
  LibraryListQuerySchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LibraryListResponseSchema,
  ModuleCapabilitiesSchema,
  ModuleListResponseSchema,
  ModuleOptionDescriptorSchema,
  ModuleSummarySchema,
  ModuleUpdateRequestSchema,
  ProxySettingsSchema,
  ProxyUpdateRequestSchema,
  ReadyzResponseSchema,
  SettingsResponseSchema,
  CatalogBrowseQuerySchema,
  CatalogPageResponseSchema,
  CatalogSearchQuerySchema,
  CatalogSyncResponseSchema,
  CatalogSyncAllResponseSchema,
  SyncModulesResponseSchema,
  TimestampSchema,
  AccountListResponseSchema,
  AccountLoginResponseSchema,
  AccountResponseSchema,
  AccountUpsertRequestSchema,
  AccountViewSchema,
} from './schemas.js';

/**
 * Shared schemas, registered so cross-route references render as
 * `#/components/schemas/<name>` instead of duplicated subtrees.
 */
const REGISTRY: readonly [z.ZodType, string][] = [
  [ApiErrorEnvelopeSchema, 'ApiErrorEnvelope'],
  [ModuleOptionDescriptorSchema, 'ModuleOptionDescriptor'],
  [ModuleCapabilitiesSchema, 'ModuleCapabilities'],
  [ModuleSummarySchema, 'ModuleSummary'],
  [ProxySettingsSchema, 'ProxySettings'],
  [SettingsResponseSchema, 'SettingsResponse'],
  [CatalogEntrySchema, 'CatalogEntry'],
  [FavoriteSchema, 'Favorite'],
  [AccountViewSchema, 'AccountView'],
  [InfoRequestSchema, 'InfoRequest'],
  [InfoResponseSchema, 'InfoResponse'],
  [JobSchema, 'Job'],
  [LibraryFileSchema, 'LibraryFile'],
  // The SAME instance schemas.ts uses — registering it here keeps
  // zod's internal datetime dedup from leaking a version-specific
  // anonymous name (`__schema0`) into the snapshot.
  [TimestampSchema, 'Timestamp'],
];
for (const [schema, id] of REGISTRY) {
  z.globalRegistry.add(schema, { id });
}

/** One documented operation. `query` is a zod object of query params. */
interface RouteOperation {
  readonly method: 'get' | 'post' | 'put' | 'delete';
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  /** False when the route accepts an absent body (sync triggers). */
  readonly bodyRequired?: boolean;
  readonly responses: Readonly<Record<string, ResponseEntry>>;
}

interface ResponseEntry {
  readonly description: string;
  readonly schema: z.ZodType;
  /** Response media type (default `application/json`; metrics = text). */
  readonly contentType?: string;
}

const errorResponse = (status: number, description: string): [string, ResponseEntry] => [
  String(status),
  { description, schema: ApiErrorEnvelopeSchema },
];

const validation = (): [string, ResponseEntry] =>
  errorResponse(400, 'Request failed schema validation (typed error envelope)');
const unauthorized = (): [string, ResponseEntry] =>
  errorResponse(401, 'Missing/invalid session (state-changing route with FMD_WEB_PASSWORD set)');
const notFound = (what: string): [string, ResponseEntry] => errorResponse(404, `${what} not found`);
const upstream = (why: string): [string, ResponseEntry] => errorResponse(502, why);
const malformedCursor = (): [string, ResponseEntry] => errorResponse(400, 'Malformed cursor');
const internal = (): [string, ResponseEntry] => errorResponse(500, 'Unhandled server failure (typed error envelope)');

/** Merge error responses into a status-keyed record (stable order). */
function errors(...pairs: readonly [string, ResponseEntry][]): Record<string, ResponseEntry> {
  return Object.fromEntries(pairs);
}

/** The §10 surface, one row per operation (WS /ws is documented out —
 * it is an upgrade channel, not a JSON operation). */
const OPERATIONS: readonly RouteOperation[] = [
  {
    method: 'get',
    path: '/api/modules',
    operationId: 'listModules',
    summary: 'Module registry with capability + known-broken flags',
    description:
      'One row per registered module (§9 module_state registry columns): identity, §5.1 options ' +
      '(combobox options carry `items`; the STORED value is the item INDEX), and §5.10 capability ' +
      'detection incl. the D3 known-broken flag ids. `live_scrape_fallback` (§6.8) marks modules ' +
      'declaring both directory events — browsable without an FMD2-DB catalog via the live walk.',
    tags: ['modules'],
    responses: {
      200: { description: 'Module list', schema: ModuleListResponseSchema },
      ...errors(validation(), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/modules/{id}',
    operationId: 'updateModule',
    summary: 'Enable/disable a module, set options, cookies and the proxy override',
    description:
      'Option values are validated against the module descriptors: checkbox → boolean, edit → string, ' +
      'spinedit → integer, combobox → integer item INDEX within `items` range (§5.1). Unknown option ' +
      'names are rejected with 400. `proxy` sets the per-module proxy override (null clears it back ' +
      'to "inherit the global proxy"; §9/§10 settings, SetProxy field semantics).',
    tags: ['modules'],
    body: ModuleUpdateRequestSchema,
    responses: {
      200: { description: 'Updated module', schema: ModuleSummarySchema },
      ...errors(validation(), unauthorized(), notFound('Module'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/accounts',
    operationId: 'listAccounts',
    summary: 'Module accounts (§8.6/D4)',
    description:
      'One row per module account: username, enabled flag and the module AccountState ' +
      '(§5.2 account-status constants). The password is write-only — it is sealed at rest ' +
      '(FMD_WEB_SECRET, AES-256-GCM) and never returned.',
    tags: ['accounts'],
    responses: {
      200: { description: 'Account list', schema: AccountListResponseSchema },
      ...errors(unauthorized(), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/accounts/{moduleId}',
    operationId: 'upsertAccount',
    summary: 'Create/replace the account for one module',
    description:
      'Module-scoped account upsert (FMD2 keeps exactly one account per module). Omitted ' +
      '`password`/`cookies` KEEP the stored values — the credential never round-trips ' +
      'through the API. All three fields are sealed with FMD_WEB_SECRET before the write.',
    tags: ['accounts'],
    body: AccountUpsertRequestSchema,
    responses: {
      201: { description: 'Stored account projection', schema: AccountResponseSchema },
      ...errors(validation(), unauthorized(), internal()),
    },
  },
  {
    method: 'delete',
    path: '/api/accounts/{moduleId}',
    operationId: 'deleteAccount',
    summary: 'Remove the account for one module',
    description: 'Deletes the sealed account row (§9 `account`). The module_state cookies are NOT touched.',
    tags: ['accounts'],
    responses: {
      200: { description: 'Removed', schema: z.object({ ok: z.literal(true) }) },
      ...errors(validation(), unauthorized(), notFound('Account'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/accounts/{moduleId}/login',
    operationId: 'loginAccount',
    summary: 'Run the module OnLogin flow (event runtime)',
    description:
      'Dispatches the §5.2 `Login` event with the account-status constants bound and ' +
      'MODULE.Account seeded from the sealed row; the handler-set `MODULE.Account.Status` ' +
      'and `MODULE.Account.Cookies` are read back and persisted (account row + §5.3 ' +
      'module_state cookies). Engine/dispatch failures are 502 upstream_error.',
    tags: ['accounts'],
    responses: {
      200: { description: 'Login outcome', schema: AccountLoginResponseSchema },
      ...errors(
        validation(),
        unauthorized(),
        notFound('Account'),
        errorResponse(409, 'Account disabled or the module binds no OnLogin handler'),
        errorResponse(502, 'The module OnLogin run failed (typed error envelope)'),
        internal(),
      ),
    },
  },
  {
    method: 'get',
    path: '/api/settings',
    operationId: 'getSettings',
    summary: 'Global proxy config + browser sidecar profile state',
    description:
      'The §9/§10 settings projection: the global proxy (SetProxy five-string semantics, ' +
      'httpsendthread.pas:838-874 — type HTTP|SOCKS4|SOCKS5, the empty type is "no proxy") and the ' +
      '§5.11 browser profile state (enabled ⇒ the D2 sidecar is wired and the satisfied §5.10 ' +
      'known-broken flags are dropped from /api/modules).',
    tags: ['settings'],
    responses: {
      200: { description: 'Settings snapshot', schema: SettingsResponseSchema },
      ...errors(unauthorized(), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/settings/proxy',
    operationId: 'updateProxy',
    summary: 'Replace the global proxy config',
    description:
      'Full replacement with SetProxy semantics: a config with a non-empty type requires a host; the ' +
      'all-empty config is the SetNoProxy path. Per-module overrides (PUT /api/modules/{id} proxy) ' +
      'take precedence for their module.',
    tags: ['settings'],
    body: ProxyUpdateRequestSchema,
    responses: {
      200: { description: 'Settings snapshot after the update', schema: SettingsResponseSchema },
      ...errors(validation(), unauthorized(), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/sync/modules',
    operationId: 'syncModules',
    summary: 'Sync the pinned FMD2 lua/ tree (SHA pin + D9 diff report)',
    description:
      'Runs the §2/§6 module syncer: fetch at the pinned commit, validate via the Init pass, ' +
      'atomically swap the tree, record sync_state, and return the deterministic sweep summary.',
    tags: ['sync'],
    body: z.object({}),
    bodyRequired: false,
    responses: {
      200: { description: 'Sync outcome + sweep summary', schema: SyncModulesResponseSchema },
      ...errors(validation(), unauthorized(), upstream('Sync failed (fetch/validate)'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/sync/catalog/{id}',
    operationId: 'syncCatalog',
    summary: 'Sync one FMD2-DB catalog (§6.1–§6.3)',
    description: 'Conditional fetch with the ETag budget, 7z extract, atomic install; 404 for unknown ids.',
    tags: ['sync'],
    body: z.object({}),
    bodyRequired: false,
    responses: {
      200: { description: 'Catalog sync outcome', schema: CatalogSyncResponseSchema },
      ...errors(validation(), unauthorized(), notFound('Catalog'), upstream('Sync failed'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/sync/catalog/all',
    operationId: 'syncAllCatalogs',
    summary: 'Sync all known FMD2-DB catalogs (§6.1–§6.3)',
    description: 'Resumable batch: per-catalog outcomes (unchanged/updated/failed); failures stay pending.',
    tags: ['sync'],
    body: z.object({}),
    bodyRequired: false,
    responses: {
      200: { description: 'Per-catalog outcomes', schema: CatalogSyncAllResponseSchema },
      ...errors(validation(), unauthorized(), upstream('Sync failed'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/catalog/{id}/latest',
    operationId: 'catalogLatest',
    summary: 'Catalog rows ordered by jdn DESC (§6.6)',
    description:
      'Page-number browse over the read-only attached catalog. No popularity ordering exists (D14). ' +
      '§6.8 fallback: with no catalog installed, modules declaring both directory events are served ' +
      'LIVE from their §5.8-normalized directory walk (TTL-cached, update-lane isolated) — every ' +
      'response carries `source: "catalog" | "live"` so the UI can badge it.',
    tags: ['catalog'],
    query: CatalogBrowseQuerySchema,
    responses: {
      200: { description: 'Page of catalog entries (source discriminator per §6.8)', schema: CatalogPageResponseSchema },
      ...errors(validation(), notFound('Catalog'), upstream('Live directory walk failed'), errorResponse(503, 'Live scrape update lane is shutting down'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/catalog/{id}/title',
    operationId: 'catalogByTitle',
    summary: 'Catalog rows ordered by title (§6.6)',
    description:
      'Page-number browse over the read-only attached catalog. §6.8 fallback: catalog-less modules ' +
      'serve their §5.8-normalized directory walk live (title-ordered NOCASE); `source` discriminates.',
    tags: ['catalog'],
    query: CatalogBrowseQuerySchema,
    responses: {
      200: { description: 'Page of catalog entries (source discriminator per §6.8)', schema: CatalogPageResponseSchema },
      ...errors(validation(), notFound('Catalog'), upstream('Live directory walk failed'), errorResponse(503, 'Live scrape update lane is shutting down'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/catalog/{id}/search',
    operationId: 'catalogSearch',
    summary: 'FTS5 search with cursor pagination (§6.5, §10)',
    description:
      'Sanitized FTS MATCH over the sidecar, ranked; `cursor` continues a previous page ' +
      '(opaque, query-bound). Catalogs are read-only after install, so cursors stay stable. ' +
      '§6.8 fallback: catalog-less modules search their §5.8-normalized directory-walk snapshot ' +
      'in memory (title/alttitles/summary terms, exact status, substring genre) with the SAME ' +
      'cursor scheme; `source` discriminates the channel.',
    tags: ['catalog'],
    query: CatalogSearchQuerySchema,
    responses: {
      200: { description: 'Ranked page of catalog entries (source discriminator per §6.8)', schema: CatalogPageResponseSchema },
      ...errors(validation(), malformedCursor(), notFound('Catalog'), upstream('Live directory walk failed'), errorResponse(503, 'Live scrape update lane is shutting down'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/info',
    operationId: 'liveInfo',
    summary: 'Normalized live manga info (§5.8 pipeline, cached)',
    description:
      'Runs the module GetInfo event and applies the §5.8 post-processing pipeline ' +
      '(last-occurrence-wins dedup); responses are cached per (moduleId, url) for the configured TTL.',
    tags: ['info'],
    body: InfoRequestSchema,
    responses: {
      200: { description: 'Normalized MANGAINFO state', schema: InfoResponseSchema },
      ...errors(validation(), unauthorized(), notFound('Module'), upstream('Module GetInfo failed'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/jobs/download',
    operationId: 'createDownloadJob',
    summary: 'Create a download job (idempotent, §10)',
    description:
      'With `idempotencyKey`: an identical-key replay returns the ORIGINAL job with 200 while it is ' +
      'live (queued/running/retry); key reuse with a DIFFERENT payload returns 409. Re-enqueueing a ' +
      'TERMINAL original (done/failed/cancelled) starts a FRESH job chained under the same key ' +
      '(`<key>#<n>`, 201) — the re-download semantic; the fresh attempt resumes from the persisted ' +
      "chapter markers ('D' slots skip their images). Fresh creates return 201.",
    tags: ['jobs'],
    body: JobCreateRequestSchema,
    responses: {
      201: { description: 'Created job', schema: z.object({ job: JobSchema }) },
      200: { description: 'Idempotent replay of the original job', schema: z.object({ job: JobSchema }) },
      ...errors(validation(), unauthorized(), errorResponse(409, 'Idempotency key reused with a different payload'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/jobs',
    operationId: 'listJobs',
    summary: 'Job list with state filter + keyset cursor',
    description:
      'Newest-first page (`limit` ≤ 100). `cursor` is the keyset boundary (the last job id of the ' +
      'previous page) — stable under concurrent inserts: newly created jobs never shift pages.',
    tags: ['jobs'],
    query: JobsListQuerySchema,
    responses: {
      200: { description: 'Page of jobs', schema: JobsListResponseSchema },
      ...errors(validation(), malformedCursor(), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/jobs/{id}',
    operationId: 'getJob',
    summary: 'One job snapshot',
    description: 'The current §7.1 row (state, progress, error) — the polling fallback beside the WS stream.',
    tags: ['jobs'],
    responses: {
      200: { description: 'The job snapshot', schema: JobCreatedResponseSchema },
      ...errors(validation(), notFound('Job'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/cancel',
    operationId: 'cancelJob',
    summary: 'User-cancel a download job (§7.1)',
    description:
      "queued/running/retry → cancelled (200). A running chapter aborts its in-flight images and " +
      "persists the 'W'/'D' markers, so the next enqueue of the same chapter resumes (only the " +
      'remaining images are fetched). A terminal row is 409 — nothing to cancel.',
    tags: ['jobs'],
    body: z.object({}),
    bodyRequired: false,
    responses: {
      200: { description: 'The cancelled job snapshot', schema: JobCreatedResponseSchema },
      ...errors(validation(), unauthorized(), notFound('Job'), errorResponse(409, 'Job is already terminal'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/library',
    operationId: 'listLibrary',
    summary: 'Finalized chapter artifacts (§7.1 library listing)',
    description:
      'Newest-first page over the library rows (one per packed chapter file, `library/<module>/<manga>/<file>`). ' +
      '`cursor` is the keyset boundary like /api/jobs.',
    tags: ['library'],
    query: LibraryListQuerySchema,
    responses: {
      200: { description: 'Page of library files', schema: LibraryListResponseSchema },
      ...errors(validation(), malformedCursor(), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/library/{id}/file',
    operationId: 'downloadLibraryFile',
    summary: 'Download one packed chapter artifact',
    description:
      'Streams the artifact bytes (application/octet-stream, attachment Content-Disposition). ' +
      'The ZIP/CBZ structure is client-validatable (central directory walk).',
    tags: ['library'],
    responses: {
      200: { description: 'The artifact bytes', schema: z.object({}) },
      ...errors(validation(), notFound('Library file'), errorResponse(410, 'Artifact file missing on disk'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/favorites',
    operationId: 'listFavorites',
    summary: 'Favorites listing (§7.2 DoCheck engine)',
    description:
      'One row per favorite (`id` = LowerCase(ModuleID+Link)): `currentChapter`/`status` from the ' +
      'last successful check (immediate update parity), `newChapterCount` for the UI badge, and the ' +
      'auto-download flag gating pipeline enqueues.',
    tags: ['favorites'],
    responses: {
      200: { description: 'Favorites list', schema: FavoriteListResponseSchema },
      ...errors(validation(), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/favorites',
    operationId: 'createFavorite',
    summary: 'Create a favorite and run its initial check',
    description:
      'Inserts the favorite and immediately runs the §7.2 DoCheck cycle: live GetInfoFromURL ' +
      '(§5.8-normalized), immediate CurrentChapter/Status update, new-chapter diff against the ' +
      'stored downloaded list.',
    tags: ['favorites'],
    body: FavoriteCreateRequestSchema,
    responses: {
      201: { description: 'Created favorite', schema: FavoriteResponseSchema },
      ...errors(validation(), errorResponse(409, 'Favorite already exists'), errorResponse(502, 'Module GetInfo failed'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/favorites/import',
    operationId: 'importFavorite',
    summary: 'Tag-100 transfer-favorite bulk-ingest (D4)',
    description:
      'The favorites-import path: the created favorite immediately runs the transfer branch of ' +
      'DoCheck — every live chapter is marked downloaded in ITS stored list (global ' +
      'downloaded_chapters untouched), so nothing re-downloads.',
    tags: ['favorites'],
    body: FavoriteCreateRequestSchema,
    responses: {
      201: { description: 'Imported favorite', schema: FavoriteResponseSchema },
      ...errors(validation(), errorResponse(502, 'Module GetInfo failed'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/favorites/{id}',
    operationId: 'getFavorite',
    summary: 'One favorite',
    description: 'The `id` is LowerCase(ModuleID+Link), URL-encoded in the path.',
    tags: ['favorites'],
    responses: {
      200: { description: 'The favorite', schema: FavoriteResponseSchema },
      ...errors(validation(), notFound('Favorite'), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/favorites/{id}',
    operationId: 'updateFavorite',
    summary: 'Update title / the auto-download toggle',
    description:
      'The auto-download toggle gates whether new-chapter diff results enqueue through the ' +
      'Phase-3 download pipeline (FMD2 OptionAutoCheckFavDownload, default off).',
    tags: ['favorites'],
    body: FavoriteUpdateRequestSchema,
    responses: {
      200: { description: 'Updated favorite', schema: FavoriteResponseSchema },
      ...errors(validation(), notFound('Favorite'), internal()),
    },
  },
  {
    method: 'delete',
    path: '/api/favorites/{id}',
    operationId: 'deleteFavorite',
    summary: 'Delete a favorite',
    description: 'Removes the favorite row; its downloaded_chapters ledger row is NOT touched.',
    tags: ['favorites'],
    responses: {
      200: { description: 'Deleted', schema: z.object({ ok: z.literal(true) }) },
      ...errors(validation(), notFound('Favorite'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/favorites/{id}/check',
    operationId: 'checkFavoriteNow',
    summary: 'Manual check-now (the immediate DoCheck cycle)',
    description:
      'Live info → immediate CurrentChapter/Status update → case-insensitive new-chapter diff → ' +
      'auto-download + the :1131-1133 dual-write when the toggle is on. Returns the updated ' +
      'favorite, the queued download count and the new-chapter set (live order).',
    tags: ['favorites'],
    responses: {
      200: { description: 'Check result', schema: FavoriteCheckResponseSchema },
      ...errors(validation(), notFound('Favorite'), errorResponse(502, 'Module GetInfo failed'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/auth/login',
    operationId: 'login',
    summary: 'Password login → session cookie (rate-limited 10/min)',
    description:
      'Only mounted/meaningful with FMD_WEB_PASSWORD set (otherwise 400 auth_disabled). ' +
      'Sets an HttpOnly, SameSite=Strict session cookie; the 11th attempt within a minute is 429.',
    tags: ['auth'],
    body: LoginRequestSchema,
    responses: {
      200: { description: 'Session established', schema: LoginResponseSchema },
      ...errors(
        validation(),
        errorResponse(400, 'Auth disabled (no FMD_WEB_PASSWORD)'),
        errorResponse(401, 'Invalid credentials'),
        errorResponse(429, 'Login rate limit exceeded'),
        internal(),
      ),
    },
  },
  {
    method: 'get',
    path: '/healthz',
    operationId: 'healthz',
    summary: 'Liveness',
    description: 'Process is up; version reported. Never gated.',
    tags: ['health'],
    responses: {
      200: { description: 'Liveness', schema: HealthzResponseSchema },
      ...errors(internal()),
    },
  },
  {
    method: 'get',
    path: '/readyz',
    operationId: 'readyz',
    summary: 'Readiness',
    description: 'Data dirs opened, registry restored, catalogs attached. 503 + the bootstrap stage while the D20 first-run bootstrap runs.',
    tags: ['health'],
    responses: {
      200: { description: 'Readiness', schema: ReadyzResponseSchema },
      503: { description: 'Bootstrap running / failed', schema: ReadyzResponseSchema },
      ...errors(internal()),
    },
  },
  {
    method: 'get',
    path: '/api/metrics',
    operationId: 'getMetrics',
    summary: 'Prometheus metrics exposition (§4/§15 observability)',
    description:
      'The §4/§15 series in Prometheus text format (version 0.0.4): queue depth per lane, job ' +
      'throughput/failure by state, per-module request latency + error counts, corpus pass rates, ' +
      'engine pool RSS + GC stats, sync progress, and the expression-failure WARN dedup counters. ' +
      'Mounted only when a metrics registry is bound (the production assembly always binds one).',
    tags: ['health'],
    responses: {
      200: {
        description: 'Metrics exposition (text/plain, Prometheus version 0.0.4)',
        schema: z.string(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      },
      ...errors(internal()),
    },
  },
];

type MutableSchema = Record<string, unknown>;

/** Rewrite `#/$defs/X` refs to `#/components/schemas/X` (recursive). */
function rewriteRefs(node: unknown, seen: Set<object>): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) {
    return;
  }
  seen.add(node);
  const record = node as MutableSchema;
  if (typeof record['$ref'] === 'string' && record['$ref'].startsWith('#/$defs/')) {
    record['$ref'] = `#/components/schemas/${record['$ref'].slice('#/$defs/'.length)}`;
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === 'object') {
      rewriteRefs(value, seen);
    }
  }
}

/** Convert one zod schema, stripping `$schema` and hoisting `$defs`. */
function convertSchema(schema: z.ZodType, io: 'input' | 'output'): MutableSchema {
  const converted = z.toJSONSchema(schema, { io, reused: 'ref', unrepresentable: 'any' }) as MutableSchema;
  delete converted['$schema'];
  rewriteRefs(converted, new Set<object>());
  return converted;
}

/** PATH PARAMETERS: `{id}` → OpenAPI path parameter (32-hex module id). */
function pathParameters(path: string): unknown[] {
  const params: unknown[] = [];
  if (path.includes('{id}')) {
    params.push({
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', pattern: '^[0-9a-f]{32}$' },
      description: 'Module/catalog id (32-hex, §5)',
    });
  }
  if (path.includes('{moduleId}')) {
    params.push({
      name: 'moduleId',
      in: 'path',
      required: true,
      schema: { type: 'string', pattern: '^[0-9a-f]{32}$' },
      description: 'Module id (32-hex, §5)',
    });
  }
  return params;
}

/** zod query object → OpenAPI `parameters` entries. */
function queryParameters(query: z.ZodType): unknown[] {
  const json = convertSchema(query, 'input');
  const properties = (json['properties'] ?? {}) as Record<string, MutableSchema>;
  const required = new Set((json['required'] as readonly string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    // Query values arrive as strings and are coerced by the zod schema.
    schema: { ...schema, description: schema['description'] ?? 'string-coerced on the wire' },
  }));
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly servers: readonly { readonly url: string }[];
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    readonly schemas: Record<string, unknown>;
    readonly securitySchemes: Record<string, unknown>;
  };
}

/**
 * Deterministically assemble the document: stable operation order (the
 * OPERATIONS table), sorted component keys — the committed snapshot is
 * byte-stable across runs.
 */
export function generateOpenApiDocument(version: string): OpenApiDocument {
  const components: Record<string, unknown> = {};
  const paths: Record<string, Record<string, unknown>> = {};

  const hoist = (converted: MutableSchema): void => {
    const defs = converted['$defs'];
    if (defs !== undefined && typeof defs === 'object') {
      for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
        if (!(name in components)) {
          components[name] = def;
        }
      }
      delete converted['$defs'];
    }
  };

  for (const [schema, id] of REGISTRY) {
    if (!(id in components)) {
      // Converting a registry-registered schema at the root yields
      // `{ $ref: '#/$defs/<id>', $defs: { <id>: <definition> } }` —
      // the component IS the definition, not a self-pointer.
      const converted = convertSchema(schema, 'input');
      const defs = converted['$defs'];
      const self =
        defs !== undefined && typeof defs === 'object' ? (defs as Record<string, unknown>)[id] : undefined;
      if (self !== undefined) {
        components[id] = self;
        delete converted['$defs'];
      } else {
        components[id] = converted;
      }
    }
  }

  for (const op of OPERATIONS) {
    const responses: Record<string, unknown> = {};
    for (const status of Object.keys(op.responses).map(Number).sort((a, b) => a - b)) {
      const entry = op.responses[String(status)];
      if (entry === undefined) {
        continue;
      }
      const response: Record<string, unknown> = { description: entry.description };
      if (entry.schema !== undefined) {
        const converted = convertSchema(entry.schema, 'output');
        hoist(converted);
        response['content'] = { [entry.contentType ?? 'application/json']: { schema: converted } };
      }
      responses[String(status)] = response;
    }

    const operation: Record<string, unknown> = {
      operationId: op.operationId,
      summary: op.summary,
      description: op.description,
      tags: [...op.tags],
      responses,
    };
    const parameters = [...pathParameters(op.path), ...(op.query !== undefined ? queryParameters(op.query) : [])];
    if (parameters.length > 0) {
      operation['parameters'] = parameters;
    }
    if (op.body !== undefined) {
      const converted = convertSchema(op.body, 'input');
      hoist(converted);
      operation['requestBody'] = {
        required: op.bodyRequired ?? true,
        content: { 'application/json': { schema: converted } },
      };
    }
    if (op.method !== 'get' && op.path !== '/api/auth/login') {
      operation['security'] = [{ sessionCookie: [] }];
    }
    const pathEntry = paths[op.path] ?? {};
    paths[op.path] = pathEntry;
    pathEntry[op.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'fmd-web API',
      version,
      description:
        'fmd-web server API (DESIGN.md §10). Contract-based: every schema here is generated from ' +
        'the zod source of truth (server/src/api/schemas.ts); the committed snapshot ' +
        '(server/src/api/openapi.snapshot.json) fails CI on unintended drift. ' +
        'Errors use one typed envelope: { error: { code, message, details? } }.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'modules', description: 'Module registry + options (§5.1, §5.10)' },
      { name: 'sync', description: 'FMD2 lua/ tree + FMD2-DB catalog sync (§2, §6)' },
      { name: 'catalog', description: 'Catalog browse/search over read-only attached dbs (§6.4–§6.6) + the §6.8 live-scrape fallback' },
      { name: 'info', description: 'Live module info, normalized (§5.8)' },
      { name: 'jobs', description: 'Download job queue (§7.1) with idempotent create' },
      { name: 'auth', description: 'Optional password session (FMD_WEB_PASSWORD)' },
      { name: 'health', description: 'Liveness/readiness probes' },
    ],
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'fmd_session',
          description: 'Session cookie minted by POST /api/auth/login (only when FMD_WEB_PASSWORD is set).',
        },
      },
    },
  };
}
