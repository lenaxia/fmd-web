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
  AllSitesSearchQuerySchema,
  AllSitesSearchResponseSchema,
  ApiTokenResponseSchema,
  CatalogEntrySchema,
  HealthzResponseSchema,
  InfoRequestSchema,
  InfoResponseSchema,
  FavoriteCheckResponseSchema,
  FavoriteCheckBatchCancelResponseSchema,
  FavoriteCheckBatchRequestSchema,
  FavoriteCheckBatchResponseSchema,
  FavoriteCreateRequestSchema,
  FavoriteListQuerySchema,
  FavoriteListResponseSchema,
  FavoriteResponseSchema,
  FavoriteSchema,
  FavoriteSchedulerSettingsUpdateRequestSchema,
  FavoriteTransferPreviewRequestSchema,
  FavoriteTransferPreviewResponseSchema,
  FavoriteTransferRequestSchema,
  FavoriteTransferResponseSchema,
  FavoriteUpdateRequestSchema,
  JobCreateRequestSchema,
  JobCreatedResponseSchema,
  JobBatchCreateRequestSchema,
  JobBatchCreatedResponseSchema,
  JobSchema,
  JobsListQuerySchema,
  JobsListResponseSchema,
  JobActionRequestSchema,
  JobActionResponseSchema,
  JobDeleteQuerySchema,
  JobBulkActionRequestSchema,
  JobBulkActionResponseSchema,
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
  ModuleBulkUpdateRequestSchema,
  ModuleBulkUpdateResponseSchema,
  OutputDefaultsSchema,
  OutputDefaultsUpdateRequestSchema,
  PerformanceSettingsUpdateRequestSchema,
  RetentionSettingsUpdateRequestSchema,
  FilenamePolicySettingsUpdateRequestSchema,
  DiagnosticsSettingsUpdateRequestSchema,
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
  [OutputDefaultsSchema, 'OutputDefaults'],
  [SettingsResponseSchema, 'SettingsResponse'],
  [ApiTokenResponseSchema, 'ApiTokenResponse'],
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
      'declaring both directory events — browsable without an FMD2-DB catalog via the live walk. ' +
      '`catalogInstalled` joins the CatalogStore receipts (§6.4 getMeta): the site-first Browse ' +
      'picker renders it as a per-site chip and drives auto-provisioning from it (additive).',
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
    method: 'post',
    path: '/api/modules/bulk',
    operationId: 'bulkUpdateModules',
    summary: 'Bulk enable/disable many modules at once',
    description:
      'FMD2 Websites-tree bulk parity (pas:6400 Select All/Unselect All + per-category ' +
      'checkboxes): one enable/disable write over many module_state rows through the SAME ' +
      'update seam (option/cookie/proxy state untouched). Targets: `ids` (explicit list), ' +
      'OR `category` (exact category match), OR neither (every registered module — the ' +
      'global select-all/none). Unknown ids/categories resolve to an empty target set ' +
      '(`updated: 0`, never a 404 — a sweep is idempotent).',
    tags: ['modules'],
    body: ModuleBulkUpdateRequestSchema,
    responses: {
      200: { description: 'The resolved module set after the write + count', schema: ModuleBulkUpdateResponseSchema },
      ...errors(validation(), unauthorized(), internal()),
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
    summary: 'Global proxy config + output defaults + browser sidecar profile state',
    description:
      'The §9/§10 settings projection: the global proxy (SetProxy five-string semantics, ' +
      'httpsendthread.pas:838-874 — type HTTP|SOCKS4|SOCKS5, the empty type is "no proxy"), ' +
      'the output defaults (FMD2 Save-to parity subset: default archive format zip/cbz/pdf/epub ' +
      '+ chapter filename template, honored on NEW download jobs) and the ' +
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
    method: 'put',
    path: '/api/settings/output',
    operationId: 'updateOutputDefaults',
    summary: 'Replace the output defaults (format + chapter rename template)',
    description:
      'FMD2 Save-to options parity (additive, the server-supported subset): `format` picks ' +
      'the §7.3 packer for NEW download jobs (zip/cbz/pdf/epub — FMD2\'s None loose-images mode ' +
      'is deferred; the §7.1 library model is one packed artifact). `chapterNameTemplate` is the ' +
      'FMD2 custom rename (edOptionMangaCustomRename) with the %WEBSITE%/%MANGA%/%AUTHOR%/' +
      '%ARTIST%/%CHAPTER%/%NUMBERING%/%FILENAME% placeholders; \'\' keeps the chapter-name ' +
      'fallback. PDF quality and the digit-padding/unicode rename options are deferred (D16 ' +
      'streaming packer is DCT passthrough — see docs/UX-PARITY.md).',
    tags: ['settings'],
    body: OutputDefaultsUpdateRequestSchema,
    responses: {
      200: { description: 'Settings snapshot after the update', schema: SettingsResponseSchema },
      ...errors(validation(), unauthorized(), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/settings/performance',
    operationId: 'updatePerformanceSettings',
    summary: 'Replace the Performance group (FMD2 Connections subset, additive)',
    description:
      '[parity-sweep] M10: requestTimeoutSeconds seeds the HTTP pipeline default (module ' +
      'code may still override per request); retryCount is the per-image retry budget; ' +
      'threadsPerChapter is the per-chapter image-worker width (FMD2 ' +
      'MaxThreadPerTaskLimit); parallelChapters is the download-lane slot count and ' +
      'applies at SERVER START (lane slots are fixed at boot). Persisted in app.db ' +
      '(app_settings).',
    tags: ['settings'],
    body: PerformanceSettingsUpdateRequestSchema,
    responses: {
      200: { description: 'Settings snapshot after the update', schema: SettingsResponseSchema },
      ...errors(validation(), unauthorized(), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/settings/retention',
    operationId: 'updateRetentionSettings',
    summary: 'Replace job-history retention (auto-delete after N days, additive)',
    description:
      '[parity-sweep] M2: auto-delete finished job history after N days; 0 = keep ' +
      'forever. Drives the periodic prune sweep (hourly; a change applies on the next ' +
      'sweep). Persisted in app.db (app_settings).',
    tags: ['settings'],
    body: RetentionSettingsUpdateRequestSchema,
    responses: {
      200: { description: 'Settings snapshot after the update', schema: SettingsResponseSchema },
      ...errors(validation(), unauthorized(), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/settings/filename-policy',
    operationId: 'updateFilenamePolicySettings',
    summary: 'Replace the filename policy (D5 mode, additive)',
    description:
      '[parity-sweep] M4: true = Linux-normalized filenames; false = the FMD2-desktop ' +
      'parity default. Precedence: the FMD_NORMALIZE_PATHS env / --normalize-paths flag ' +
      'OVERRIDES the setting (env > setting > parity). Persisted in app.db (app_settings).',
    tags: ['settings'],
    body: FilenamePolicySettingsUpdateRequestSchema,
    responses: {
      200: { description: 'Settings snapshot after the update', schema: SettingsResponseSchema },
      ...errors(validation(), unauthorized(), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/settings/diagnostics',
    operationId: 'updateDiagnosticsSettings',
    summary: 'Replace diagnostics settings (log enable + level, additive)',
    description:
      '[parity-sweep] M13: structured-log enable + minimum level, applied live to the ' +
      'running logger. The live log VIEWER is v0.4; /metrics + the runbook are linked ' +
      'from the Diagnostics section. Persisted in app.db (app_settings).',
    tags: ['settings'],
    body: DiagnosticsSettingsUpdateRequestSchema,
    responses: {
      200: { description: 'Settings snapshot after the update', schema: SettingsResponseSchema },
      ...errors(validation(), unauthorized(), internal()),
    },
  },
  {
    method: 'put',
    path: '/api/settings/favorites',
    operationId: 'updateFavoritesSettings',
    summary: 'Replace the favorites scheduler settings (interval + startup check)',
    description:
      'FMD2 Options → Updates parity (additive): `intervalMinutes` is the ' +
      'OptionAutoCheckFavIntervalMinutes analog — 0 disables scheduled checks, other values ' +
      'apply LIVE to the running scheduler (idle favorites re-arm under the new cadence). ' +
      '`checkAtStartup` is OptionCheckFavoritesAtStart — it gates the next boot\'s initial ' +
      'sweep. Persisted in app.db (app_settings) so it survives restarts.',
    tags: ['settings'],
    body: FavoriteSchedulerSettingsUpdateRequestSchema,
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
    summary: 'FTS5 search with cursor pagination (§6.5, §10) + FMD2 filter panel (additive)',
    description:
      'Sanitized FTS MATCH over the sidecar, ranked; `cursor` continues a previous page ' +
      '(opaque, query-bound — it carries the FULL filter state). Catalogs are read-only after ' +
      'install, so cursors stay stable. FMD2 Filter-panel parity (frmMain.pas:3400, additive): ' +
      '`q` is optional when any filter is set (filter-only pages skip the MATCH and order by ' +
      'jdn DESC); `authors` is a LIKE-contains over the authors column; `genres` (repeated ' +
      'params or one comma-separated value) joins per `genresMode` — `all` (FMD2 rbAll default) ' +
      'ANDs the LIKE clauses, `any` (rbAny) ORs them; `genresExclude` (same wire forms, the `!` ' +
      'custom-genre prefix) composes one AND-NOT-LIKE per excluded genre (audit (b)2 fix — ' +
      'excludes AND among themselves regardless of genresMode; a genre in both lists resolves ' +
      'to exclude-only); `newDays` is the only-new window ' +
      '(jdn > JDN(today) - newDays, FMD2 cbOnlyNew). Prefix-LIKE (`x%`) is a documented ' +
      'non-goal: FMD2 semantics are contains (`%x%`). ' +
      '§6.8 fallback: catalog-less modules search their §6.8-normalized directory-walk snapshot ' +
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
    method: 'get',
    path: '/api/search',
    operationId: 'allSitesSearch',
    summary: 'All-sites union search over installed catalogs (FMD2 cbSearchFromAllSites parity)',
    description:
      'FMD2 parity (frmMain.pas:3411-3416): the union runs simultaneously over every ' +
      'INSTALLED catalog of every enabled site — a LOCAL catalog union, never live scraping. ' +
      'Per-site FTS windows (width 2×limit) are merged by a documented deterministic total ' +
      'order — (normalized title, site id, link) — so result order and cursor bytes are ' +
      'identical under any permutation of the site set. `cursor` continues each site window ' +
      '(base64 of per-site consumed-row counts, bound to the issued filter state; page-size ' +
      'independent). Every row carries `site` + `siteName` (FMD2 shows the source Website on ' +
      'union rows, frmMain.pas:5170). Partial failure is TYPED, never silent: a broken ' +
      'catalog yields the rest of the union plus a `warnings[]` entry naming it; enabled ' +
      'sites without an installed catalog are excluded and surfaced in `excluded[]` ' +
      "(reason `no-catalog`) so the UI chip can explain why. `facets[]` carries per-site " +
      'totals for the count chips.',
    tags: ['catalog'],
    query: AllSitesSearchQuerySchema,
    responses: {
      200: { description: 'Merged page of site-tagged entries + facets/warnings/excluded', schema: AllSitesSearchResponseSchema },
      ...errors(validation(), malformedCursor(), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/info',
    operationId: 'liveInfo',
    summary: 'Normalized live manga info + the downloaded-chapter set (§5.8, cached)',
    description:
      'Runs the module GetInfo event and applies the §5.8 post-processing pipeline ' +
      '(last-occurrence-wins dedup); responses are cached per (moduleId, url) for the configured TTL. ' +
      '`downloaded` (MangaPage parity — FMD2 downloaded-chapters tint/hide) carries the chapter LINKS ' +
      'already recorded in the `downloaded_chapters` ledger for this manga: it is computed at response ' +
      'time — never cached with the info snapshot — so a just-finished download flips the set on the ' +
      'next call, cache hit or not. ' +
      '[parity-sweep] M14 (FMD2 edURL parity): `moduleId` is OPTIONAL — a url-only ' +
      'body resolves the module by RootURL host match (registry lookup). Unknown host ' +
      '→ 400 `no_site_match` ("no site matches this URL"); multiple sites on one host → ' +
      '400 `ambiguous_site` naming the candidates. The response embeds the serving ' +
      '`moduleId` so the client can navigate to the manga page.',
    tags: ['info'],
    body: InfoRequestSchema,
    responses: {
      200: { description: 'Normalized MANGAINFO state + downloaded chapter links', schema: InfoResponseSchema },
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
      "chapter markers ('D' slots skip their images). Fresh creates return 201. " +
      'MangaPage parity options (additive): `paused` (FMD2 cbAddAsStopped, frmMain.lfm:1110) creates ' +
      'the job queued-but-held — the download lane will not claim it until POST /api/jobs/{id}/resume; ' +
      '`saveTo` (FMD2 edSaveTo, frmMain.pas:5613) is a custom save directory that REPLACES the ' +
      '`library/<module>/<manga>` prefix at finalize (relative paths resolve against the library root).',
    tags: ['jobs'],
    body: JobCreateRequestSchema,
    responses: {
      201: { description: 'Created job', schema: z.object({ job: JobSchema }) },
      200: { description: 'Idempotent replay of the original job', schema: z.object({ job: JobSchema }) },
      ...errors(validation(), unauthorized(), errorResponse(409, 'Idempotency key reused with a different payload'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/jobs/download/batch',
    operationId: 'createDownloadJobsBatch',
    summary: 'Batch download-all create (idempotent per manga, §10)',
    description:
      'The browse row-menu Download-all (FMD2 pmMangaList miMangaListDownloadAll, frmMain.lfm:5798) as ONE ' +
      'request per manga instead of one chatty request per chapter. `chapters: "all"` resolves the live ' +
      'chapter list through the SAME cached §5.8 info path POST /api/info uses; an explicit link array ' +
      'enqueues exactly that selection in the given order (no info fetch). `idempotencyKey` is REQUIRED: ' +
      'every per-chapter create derives `<key>:<index>` (index in the resolved chapter order), so the whole ' +
      'batch replays as one unit — identical replay while any original is live returns the SAME jobs with ' +
      '200 + `replayed: true` (the double-submit case); a shifted/different chapter sequence under the same ' +
      'key surfaces the per-chapter 409 different-payload conflict; TERMINAL originals chain fresh attempts ' +
      "(`<key>:<index>#<n>`) exactly like the single create — the re-download semantic. `paused`/`saveTo` " +
      'apply to every chapter job.',
    tags: ['jobs'],
    body: JobBatchCreateRequestSchema,
    responses: {
      201: { description: 'Created batch (at least one fresh/chained job)', schema: JobBatchCreatedResponseSchema },
      200: { description: 'Full replay — every chapter returned an existing live job', schema: JobBatchCreatedResponseSchema },
      ...errors(validation(), unauthorized(), errorResponse(409, 'Batch key reused with a different chapter sequence'), upstream('Module GetInfo failed'), notFound('Module'), internal()),
    },
  },
  {
    method: 'get',
    path: '/api/jobs',
    operationId: 'listJobs',
    summary: 'Job list with filters + keyset cursor (Downloads parity)',
    description:
      'Newest-first page (`limit` ≤ 100). `cursor` is the keyset boundary (the last job id of the ' +
      'previous page) — stable under concurrent inserts: newly created jobs never shift pages. ' +
      'Downloads parity filters (FMD2 tsDownload filter tree + search box, web-adapted): `states` ' +
      '(csv multi-select of the §7.1 states), `q` (case-insensitive substring over the job\'s ' +
      'mangaTitle/chapterName) and `addedFrom`/`addedTo` (inclusive created-at calendar days, UTC ' +
      '— the client maps FMD2\'s History windows Today/7d/Month/Older and custom From/To into this ' +
      'range). `state` (single) predates the multi-select and stays for back-compat. ' +
      'R5 arrival adds `since` (ISO 8601 UTC timestamp): a floor on the row\'s LAST TRANSITION ' +
      '(`updatedAt`) — combined with `state=done` it selects chapters FINISHED since the ' +
      "timestamp, the 'While you were away' summary's download-news source.",
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
    method: 'post',
    path: '/api/jobs/{id}/resume',
    operationId: 'resumeJob',
    summary: 'Lift the add-as-stopped hold on a download job (cbAddAsStopped parity)',
    description:
      'A job created with `paused: true` sits in `queued` with the hold set — the download lane ' +
      'does not claim it. This endpoint clears the hold (200, `paused` absent thereafter); the ' +
      'lane picks the row up like any other queued job. Terminal rows are 409; resuming a job ' +
      'without the hold is an idempotent no-op returning the current snapshot.',
    tags: ['jobs'],
    body: z.object({}),
    bodyRequired: false,
    responses: {
      200: { description: 'The resumed job snapshot', schema: JobCreatedResponseSchema },
      ...errors(validation(), unauthorized(), notFound('Job'), errorResponse(409, 'Job is already terminal'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/jobs/{id}/action',
    operationId: 'jobAction',
    summary: 'Apply one downloads-tab task action (FMD2 pmDownload parity, web-adapted)',
    description:
      'ONE typed-union route over the per-job task actions (FMD2 pmDownload menu, ' +
      'frmMain.lfm:5538-5617). `pause` — resume-able stop (miDownloadStop): a queued row gains ' +
      'the hold (`paused: true`, not claimable), a running/retry row user-cancels with markers ' +
      'persisted. `resume` — the inverse (miDownloadResume): a held queued row lifts the hold; a ' +
      'cancelled row re-enqueues a FRESH chained attempt that resumes from the persisted ' +
      'markers. `retry` — failed → fresh chained attempt. `redownload` — done → fresh chained ' +
      'attempt (miDownloadRedownload). `disable` — hold a scheduled-but-not-running row ' +
      '(queued only). `enable` — lift that hold (queued+held only). Holding a held row / ' +
      'lifting an unheld one is an idempotent no-op. Every ILLEGAL application is 409 with the ' +
      'typed envelope carrying `{job: {id, state, paused}, action}` details.',
    tags: ['jobs'],
    body: JobActionRequestSchema,
    responses: {
      200: { description: 'The resulting job snapshot (fresh row for re-enqueue semantics)', schema: JobActionResponseSchema },
      ...errors(
        validation(),
        unauthorized(),
        notFound('Job'),
        errorResponse(409, 'Action illegal in the job current state (state matrix)'),
        internal(),
      ),
    },
  },
  {
    method: 'delete',
    path: '/api/jobs/{id}',
    operationId: 'deleteJob',
    summary: 'Delete a download job row (FMD2 delete task | delete task + data)',
    description:
      'Removes the job row in ANY state (a running chapter aborts first). `?data=true` ' +
      '(miDownloadDeleteTaskData parity) ALSO removes the finalized artifact the job recorded ' +
      'at done — the library file and its `library_files` row; the default (miDownloadDeleteTask) ' +
      'keeps the download on disk. The response echoes the removed snapshot plus `dataDeleted`.',
    tags: ['jobs'],
    query: JobDeleteQuerySchema,
    responses: {
      200: { description: 'The removed job snapshot + artifact outcome', schema: z.object({ job: JobSchema, dataDeleted: z.boolean() }) },
      ...errors(validation(), unauthorized(), notFound('Job'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/jobs/bulk-action',
    operationId: 'jobBulkAction',
    summary: 'Toolbar bulk op: Resume all / Pause all / Delete completed (FMD2 tsDownload toolbar)',
    description:
      '`{action: "pause"|"resume", scope: "all"}` — Stop All / Resume All (frmMain.lfm:291-339): ' +
      'pause holds every queued row and cancels every running/retry row; resume lifts every hold ' +
      'and re-enqueues every cancelled row (markers resume). `{action: "delete", scope: "completed"}` ' +
      '— Delete completed (miDownloadDeleteCompleted = RemoveAllFinishedTasks): removes every `done` ' +
      'row, artifacts KEPT (per-row delete+data is the explicit choice). Idempotent: a settled ' +
      'queue returns `affected: 0`. Other scope/action pairings are 400.',
    tags: ['jobs'],
    body: JobBulkActionRequestSchema,
    responses: {
      200: { description: 'Bulk outcome: count + touched snapshots', schema: JobBulkActionResponseSchema },
      ...errors(validation(), unauthorized(), errorResponse(400, 'Scope does not apply to this action'), internal()),
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
      'auto-download flag gating pipeline enqueues. R5 arrival (additive): `?since=<ISO 8601 UTC>` ' +
      "switches each row's `newsSince` flag on — true when a check ran at/after `since` AND found " +
      'new chapters (`lastCheck >= since && newChapterCount > 0`) — the favorites half of the ' +
      "'While you were away' summary. Without the param the flag is omitted (pre-R5 shape).",
    tags: ['favorites'],
    query: FavoriteListQuerySchema,
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
    summary: 'Rename / auto-download toggle / save-to / enable-disable (pmFavorites parity)',
    description:
      'The favorite patch: `title` is the Rename action, `autoDownload` gates whether ' +
      'new-chapter diff results enqueue through the Phase-3 download pipeline ' +
      '(FMD2 OptionAutoCheckFavDownload, default off), `saveTo` is the per-favorite custom ' +
      'finalize directory (Change "Save to" — \'\' resets to the default layout) and `enabled` ' +
      'is Enable/Disable (disabled rows are skipped by the scheduler and the enabled-scope ' +
      'batch checks).',
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
    path: '/api/favorites/check',
    operationId: 'checkFavoritesBatch',
    summary: 'Batch check with scope (btFavoritesCheckNewChapter parity)',
    description:
      'FMD2 Check-for-new-chapter over a scope (all|enabled|disabled): every favorite in scope ' +
      'runs one sequential DoCheck cycle (auto-download honored per row); the response carries ' +
      'per-row results — favorites with new chapters feed the NewChaptersSheet decision UI. ' +
      'A second call while a batch is in flight is a 409; POST /api/favorites/check/cancel ' +
      'stops the sweep between rows (the response reports `cancelled`).',
    tags: ['favorites'],
    body: FavoriteCheckBatchRequestSchema,
    responses: {
      200: { description: 'Batch result summary', schema: FavoriteCheckBatchResponseSchema },
      ...errors(validation(), errorResponse(409, 'A batch is already running'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/favorites/check/cancel',
    operationId: 'cancelFavoritesCheckBatch',
    summary: 'Cancel the in-flight batch check',
    description:
      'miFavoritesStopCheckNewChapter parity: requests the running batch to stop before its ' +
      'next favorite (already-completed rows keep their results; the batch response reports ' +
      '`cancelled: true`). Idempotent — false when nothing is running.',
    tags: ['favorites'],
    responses: {
      200: { description: 'Cancel accepted', schema: FavoriteCheckBatchCancelResponseSchema },
      ...errors(internal()),
    },
  },
  {
    method: 'post',
    path: '/api/favorites/{id}/transfer/preview',
    operationId: 'previewFavoriteTransfer',
    summary: 'Website-transfer mapping preview (frmTransferFavorites parity)',
    description:
      'Resolves the favorite\'s title on the target site: catalog FTS search → exact ' +
      '(case-insensitive) title match → GetInfo dry-run on the hit. The response reports ' +
      'valid + targetUrl/matchedTitle, or invalid with a reason (no-catalog | not-found | ' +
      'get-info-failed) — the transfer dialog\'s valid/invalid mapping preview.',
    tags: ['favorites'],
    body: FavoriteTransferPreviewRequestSchema,
    responses: {
      200: { description: 'Mapping preview', schema: FavoriteTransferPreviewResponseSchema },
      ...errors(validation(), notFound('Favorite'), internal()),
    },
  },
  {
    method: 'post',
    path: '/api/favorites/{id}/transfer',
    operationId: 'transferFavorite',
    summary: 'Apply the website transfer',
    description:
      'Remaps the favorite onto the target module+link under a new id (title/status/' +
      'currentChapter/saveTo carry over); the old row is deleted (its downloaded_chapters ' +
      'ledger row is NOT touched). `clearDownloadedList: true` runs the tag-100 reload — the ' +
      'stored list resets and the live target-site chapter list is re-ingested as downloaded. ' +
      'A mapping is validated first (transfer/preview semantics); invalid targets are a 409.',
    tags: ['favorites'],
    body: FavoriteTransferRequestSchema,
    responses: {
      200: { description: 'The transferred favorite', schema: FavoriteTransferResponseSchema },
      ...errors(validation(), notFound('Favorite'), errorResponse(409, 'Transfer target invalid'), internal()),
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
        errorResponse(429, 'Login rate limit exceeded (valid Bearer api-token requests bypass it)'),
        internal(),
      ),
    },
  },
  {
    method: 'get',
    path: '/api/settings/api-token',
    operationId: 'getApiToken',
    summary: 'R4 single app-wide API token state (Settings → API)',
    description:
      'The ONE deployment-wide token (Sonarr/Radarr model — never lists, never per-user). ' +
      'Returns the stored value (`null` when the FMD_WEB_API_TOKEN env pin owns the secret — ' +
      'read it from the deployment environment instead), the envManaged flag (UI shows ' +
      "'Managed via environment', hides Regenerate) and the active auth mode " +
      '(none|password|api-token|password+api-token). Credential-gated in EVERY authed mode ' +
      '— the token secret never rides an open read.',
    tags: ['auth'],
    responses: {
      200: { description: 'Token state', schema: ApiTokenResponseSchema },
      ...errors(
        unauthorized(),
        internal(),
      ),
    },
  },
  {
    method: 'post',
    path: '/api/settings/api-token/regenerate',
    operationId: 'regenerateApiToken',
    summary: 'Rotate the single API token in place (audit-logged)',
    description:
      'Generates a new 32-byte-hex value and replaces the old one IMMEDIATELY — the old ' +
      'key is rejected on the next request, so update your scripts right after rotating ' +
      '(docs/API.md key-rotation runbook). Audit-logged as a settings change (the log never ' +
      'carries the value). 409 when FMD_WEB_API_TOKEN pins the token (rotate the env ' +
      'instead) or when no auth is configured at all (set FMD_WEB_PASSWORD or the env pin ' +
      'first — minting a token into an open deployment would lock the UI out, runbook ' +
      '§API token).',
    tags: ['auth'],
    bodyRequired: false,
    responses: {
      200: { description: 'The new token state (value included, shown once)', schema: ApiTokenResponseSchema },
      ...errors(
        unauthorized(),
        errorResponse(409, 'Env-pinned (FMD_WEB_API_TOKEN) or no auth configured'),
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

/** `catalogSearch` → `CatalogSearch` (component-name prefix helper). */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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

/** Rewrite `#/$defs/<old>` refs per a rename map (recursive). */
function applyDefRenames(node: unknown, renames: ReadonlyMap<string, string>, seen: Set<object>): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) {
    return;
  }
  seen.add(node);
  const record = node as MutableSchema;
  const ref: unknown = record['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const key: string = ref.slice('#/$defs/'.length);
    const renamed: string | undefined = renames.get(key);
    if (renamed !== undefined) {
      record['$ref'] = `#/$defs/${renamed}`;
    }
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === 'object') {
      applyDefRenames(value, renames, seen);
    }
  }
}

/**
 * Rename zod's auto-generated `$defs` keys (`__schemaN`) to a stable
 * per-call-site prefix. zod names reused subschemas PER CONVERSION, so
 * one operation's `__schema0` is an unrelated schema to another's —
 * hoisting both into the shared `components.schemas` under the same
 * auto-name would corrupt one of them (first write wins). A prefix
 * derived from the operation makes every hoisted name unique.
 */
function prefixGeneratedDefs(converted: MutableSchema, defsPrefix: string | undefined): void {
  if (defsPrefix === undefined) {
    return;
  }
  const defs = converted['$defs'];
  if (defs === undefined || typeof defs !== 'object') {
    return;
  }
  const renames: Map<string, string> = new Map();
  for (const key of Object.keys(defs as Record<string, unknown>)) {
    const m: RegExpExecArray | null = /^__schema(\d+)$/.exec(key);
    if (m !== null) {
      renames.set(key, `${defsPrefix}${m[1] as string}`);
    }
  }
  if (renames.size === 0) {
    return;
  }
  const renamed: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(defs as Record<string, unknown>)) {
    renamed[renames.get(key) ?? key] = def;
  }
  converted['$defs'] = renamed;
  applyDefRenames(converted, renames, new Set<object>());
}

/**
 * Convert one zod schema, stripping `$schema`, renaming auto-generated
 * `$defs` keys to the per-call-site prefix, and rewriting `$defs` refs
 * to `#/components/schemas/…`.
 */
function convertSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
  defsPrefix?: string,
): MutableSchema {
  const converted = z.toJSONSchema(schema, { io, reused: 'ref', unrepresentable: 'any' }) as MutableSchema;
  delete converted['$schema'];
  prefixGeneratedDefs(converted, defsPrefix);
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

/**
 * zod query object → OpenAPI `parameters` entries. The converted
 * schema's `$defs` (any reused subschema — e.g. when the zod object
 * carries a `.refine`, zod $defs EVERY property) are hoisted into the
 * document's components under the operation-unique prefix.
 */
function queryParameters(
  query: z.ZodType,
  defsPrefix: string,
  hoist: (converted: MutableSchema) => void,
): unknown[] {
  const json = convertSchema(query, 'input', defsPrefix);
  hoist(json);
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
      // the component IS the definition, not a self-pointer. Sibling
      // `$defs` entries (auto-named subschemas the definition
      // references, e.g. ProxySettings' property unions) are hoisted
      // too — under the registry id's prefix, never zod's colliding
      // `__schemaN` auto-names — or the refs inside the definition
      // would dangle.
      const converted = convertSchema(schema, 'input', id);
      const defs = converted['$defs'];
      const self =
        defs !== undefined && typeof defs === 'object' ? (defs as Record<string, unknown>)[id] : undefined;
      if (self !== undefined) {
        components[id] = self;
        if (defs !== undefined && typeof defs === 'object') {
          for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
            if (name !== id && !(name in components)) {
              components[name] = def;
            }
          }
        }
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
        const converted = convertSchema(
          entry.schema,
          'output',
          `${capitalize(op.operationId)}${status}Response`,
        );
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
    const parameters = [
      ...pathParameters(op.path),
      ...(op.query !== undefined
        ? queryParameters(op.query, `${capitalize(op.operationId)}Query`, hoist)
        : []),
    ];
    if (parameters.length > 0) {
      operation['parameters'] = parameters;
    }
    if (op.body !== undefined) {
      const converted = convertSchema(op.body, 'input', `${capitalize(op.operationId)}Body`);
      hoist(converted);
      operation['requestBody'] = {
        required: op.bodyRequired ?? true,
        content: { 'application/json': { schema: converted } },
      };
    }
    if (op.method !== 'get' && op.path !== '/api/auth/login') {
      // R4: gated routes accept EITHER credential (token or session).
      operation['security'] = [{ bearerToken: [] }, { sessionCookie: [] }];
    }
    if (op.path === '/api/settings/api-token') {
      // The token secret rides this GET: credential-gated in EVERY
      // authed mode (unlike the open pre-login reads).
      operation['security'] = [{ bearerToken: [] }, { sessionCookie: [] }];
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
        bearerToken: {
          type: 'http',
          scheme: 'bearer',
          description:
            'R4 SINGLE app-wide API token (Sonarr/Radarr model): `Authorization: Bearer <token>`. ' +
            'One value per deployment — auto-generated on first start, rotated in Settings → API ' +
            '(regenerate) or pinned via FMD_WEB_API_TOKEN (env > settings). Valid on EVERY /api ' +
            'route and the /ws upgrade; with no password set the API runs token-only (API-only ' +
            'mode: reads included). Constant-time verified; never multiple/per-user tokens.',
        },
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
