/**
 * §10 API schemas — THE single source of truth for request/response
 * shapes. Every route validates through zod at the boundary and every
 * TS type is INFERRED from these schemas (z.infer) — nothing is
 * hand-duplicated. The OpenAPI document is generated from the same
 * schemas (see `openapi.ts`); Fastify's AJV is deliberately NOT used so
 * there is exactly one validation implementation (zod) and no
 * schema-copy drift.
 *
 * Shapes reuse the §5/§9 boundaries where they exist (`ModuleOptionDescriptor`
 * combobox-index semantics, `CatalogEntry`, `HealthStatus`, job states).
 *
 * Payloads that ALSO travel over `/ws` (the D19 job-event snapshots)
 * are defined ONCE in the contract package (`@fmd/contract` — same zod
 * source for the REST routes, the WS hub and the SPA) and re-exported
 * here; the server-side wire-drift test pins the committed OpenAPI
 * snapshot to that shared schema.
 */
import { z } from 'zod';
import type { ZodType } from 'zod';
import { ApiError } from './errors.js';

// ── REST/WS-shared payloads (contract package = the source) ──────────

// Import for local composition + re-export for existing import paths:
// ONE definition, both surfaces.
import { JobSchema, JobStateSchema, TimestampSchema } from '@fmd/contract';
import type { TimestampT, JobStateT, JobT } from '@fmd/contract';
export {
  TimestampSchema,
  JobStateSchema,
  JobSchema,
  type TimestampT,
  type JobStateT,
  type JobT,
};

// ── shared primitives ────────────────────────────────────────────────

/** 32-hex module id (§5) — the join key across modules/catalogs/DB. */
export const ModuleIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'expected 32-hex module id');
export type ModuleIdT = z.infer<typeof ModuleIdSchema>;

/** Typed error envelope — the ONE non-2xx shape (see errors.ts). */
export const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum([
      'validation_error',
      'unauthorized',
      'not_found',
      'conflict',
      'rate_limited',
      'bad_request',
      'upstream_error',
      'internal_error',
      // [parity-sweep] M14 open-by-URL host resolution failures.
      'no_site_match',
      'ambiguous_site',
    ]),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorEnvelopeT = z.infer<typeof ApiErrorEnvelopeSchema>;

// ── health ───────────────────────────────────────────────────────────

export const HealthzResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
export type HealthzResponseT = z.infer<typeof HealthzResponseSchema>;

export const ReadyzResponseSchema = z.object({
  ready: z.boolean(),
  reason: z.string().optional(),
});
export type ReadyzResponseT = z.infer<typeof ReadyzResponseSchema>;

// ── auth ─────────────────────────────────────────────────────────────

export const LoginRequestSchema = z.object({
  password: z.string().min(1),
});
export type LoginRequestT = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({ ok: z.literal(true) });
export type LoginResponseT = z.infer<typeof LoginResponseSchema>;

/** Session cookie name (HttpOnly, SameSite=Strict). */
export const SESSION_COOKIE = 'fmd_session';

// ── proxy settings (§5.4 SetProxy parity, global + per-module) ───────

/**
 * One proxy configuration — EXACTLY the five SetProxy strings
 * (httpsendthread.pas:838-874): `type` HTTP|SOCKS4|SOCKS5 (the empty
 * string is the "no proxy" config — GetProxy returns five empty
 * strings), host, port (string form), user, pass.
 */
export const ProxySettingsSchema = z
  .object({
    type: z.enum(['', 'HTTP', 'SOCKS4', 'SOCKS5']),
    host: z.string(),
    port: z.string(),
    user: z.string(),
    pass: z.string(),
  })
  .refine((p) => p.type === '' || p.host !== '', {
    message: 'host is required when a proxy type is set',
  });
export type ProxySettingsT = z.infer<typeof ProxySettingsSchema>;

/**
 * Output defaults (FMD2 Save-to options parity, additive — the
 * server-supported subset). `format` maps onto the §7.3 packers
 * (zip/cbz/pdf/epub; FMD2's `None` loose-images mode is DEFERRED — the
 * §7.1 library model is one packed artifact per chapter).
 * `chapterNameTemplate` is FMD2's custom rename (edOptionMangaCustomRename,
 * frmMain.lfm:3983; %WEBSITE%/%MANGA%/%AUTHOR%/%ARTIST%/%CHAPTER%/
 * %NUMBERING%/%FILENAME% via resolveChapterFileName) — '' disables it
 * (chapter-name fallback, the previous behavior). The itemized rename
 * subset ([parity-sweep] M5/M6/M8): `unicodeReplacement` +
 * `unicodeReplacementChar` (FMD2 lfm:3947/4183 — non-ASCII filename
 * chars replaced; off = byte-parity default), `digitPadding`
 * (lfm:4026 chapter-numbering digits — minimum page-name width inside
 * the archive, 0 = server default 3), `removeMangaName` (lfm:4014 —
 * strip a leading manga-title prefix from the chapter filename).
 * PDF quality stays DEFERRED (D16 streaming packer is DCT passthrough
 * — no re-encode knob; see docs/UX-PARITY.md).
 */
export const OutputDefaultsSchema = z.object({
  format: z.enum(['zip', 'cbz', 'pdf', 'epub']).default('zip'),
  chapterNameTemplate: z.string().max(500).default(''),
  /** FMD2 lfm:3947/4183: replace non-ASCII filename chars (off = parity). */
  unicodeReplacement: z.boolean().default(false),
  /** The replacement char (exactly one; '_' FMD2-style default). */
  unicodeReplacementChar: z.string().min(1).max(1).default('_'),
  /** FMD2 lfm:4026: minimum page-numbering width in archive entry names. */
  digitPadding: z.number().int().min(0).max(6).default(0),
  /** FMD2 lfm:4014: strip a leading manga-title prefix from chapter names. */
  removeMangaName: z.boolean().default(false),
});
export type OutputDefaultsT = z.infer<typeof OutputDefaultsSchema>;

// ── favorites scheduler settings (Options → Updates parity) ─────────

/** `OptionAutoCheckFavIntervalMinutes` + `OptionCheckFavoritesAtStart`. */
export const FavoriteSchedulerSettingsSchema = z.object({
  /** Minutes between scheduled checks; 0 = scheduled checks off. */
  intervalMinutes: z.number().int().min(0).max(20160),
  /** Run a check sweep at startup. */
  checkAtStartup: z.boolean(),
});
export type FavoriteSchedulerSettingsT = z.infer<typeof FavoriteSchedulerSettingsSchema>;

// ── [parity-sweep] settings groups (M10/M2/M4/M13) ───────────────────

/**
 * Performance (FMD2 Options → Connections, lfm:3394-3866 — the
 * server-exposeable subset): `requestTimeoutSeconds` seeds the HTTP
 * pipeline default (module code may still override per request),
 * `retryCount` is the per-image retry budget (FMD2 RetryCount),
 * `threadsPerChapter` the per-chapter image-worker width
 * (MaxThreadPerTaskLimit), `parallelChapters` the download-lane slot
 * count (applies at server start — lane slots are fixed at boot).
 * Lane thread-caps beyond these are SKIP (tuned defaults,
 * env-overridable; see docs/UX-PARITY.md Part 4 M10).
 */
export const PerformanceSettingsSchema = z.object({
  requestTimeoutSeconds: z.number().int().min(1).max(300),
  retryCount: z.number().int().min(0).max(10),
  parallelChapters: z.number().int().min(1).max(8),
  threadsPerChapter: z.number().int().min(1).max(8),
});
export type PerformanceSettingsT = z.infer<typeof PerformanceSettingsSchema>;

/**
 * Job-history retention (FMD2 M2 delete-completed-tasks parity): the
 * terminal-job history prunes after N days; 0 = keep forever.
 */
export const RetentionSettingsSchema = z.object({
  days: z.number().int().min(0).max(3650),
});
export type RetentionSettingsT = z.infer<typeof RetentionSettingsSchema>;

/**
 * Filename policy (D5, FMD2 M4 long-path parity): `true` = the
 * Linux-normalized mode. Precedence: the `FMD_NORMALIZE_PATHS` env /
 * `--normalize-paths` flag OVERRIDES this setting (env > setting >
 * windows-parity default) — the checkbox is disabled in the UI when
 * the env is set.
 */
export const FilenamePolicySettingsSchema = z.object({
  normalizePaths: z.boolean(),
});
export type FilenamePolicySettingsT = z.infer<typeof FilenamePolicySettingsSchema>;

/**
 * Diagnostics (FMD2 M13 log settings parity): structured-log enable +
 * minimum level. The live log VIEWER is v0.4; /metrics + the runbook
 * are linked from the UI.
 */
export const DiagnosticsSettingsSchema = z.object({
  logEnabled: z.boolean(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
});
export type DiagnosticsSettingsT = z.infer<typeof DiagnosticsSettingsSchema>;

/**
 * R4 single app-wide API token state (GET /api/settings/api-token +
 * POST /api/settings/api-token/regenerate). ONE token value ever
 * (Sonarr/Radarr model); `token` is null when nothing is stored or the
 * env pin owns the secret (read it from the deployment environment).
 */
export const ApiTokenModeSchema = z.enum(['none', 'password', 'api-token', 'password+api-token']);
export type ApiTokenModeT = z.infer<typeof ApiTokenModeSchema>;
export const ApiTokenResponseSchema = z.object({
  /** The stored token value; null when none stored or env-managed. */
  token: z.string().nullable(),
  /** True when FMD_WEB_API_TOKEN pins the value (env > settings). */
  envManaged: z.boolean(),
  /** The active auth surface (startup-log vocabulary, never the value). */
  mode: ApiTokenModeSchema,
});
export type ApiTokenResponseT = z.infer<typeof ApiTokenResponseSchema>;

/** GET /api/settings — global proxy + output defaults + §5.11 browser profile state. */
export const SettingsResponseSchema = z.object({
  proxy: ProxySettingsSchema,
  output: OutputDefaultsSchema,
  favorites: FavoriteSchedulerSettingsSchema,
  /** [parity-sweep] M10: Performance group (Connections parity subset). */
  performance: PerformanceSettingsSchema,
  /** [parity-sweep] M2: job-history retention (0 = keep forever). */
  retention: RetentionSettingsSchema,
  /** [parity-sweep] M4: filename policy (env > setting > parity default). */
  filenamePolicy: FilenamePolicySettingsSchema,
  /** [parity-sweep] M13: diagnostics log enable + level. */
  diagnostics: DiagnosticsSettingsSchema,
  browser: z.object({
    /** The compose `browser` profile is active (§5.11 sidecar wired). */
    enabled: z.boolean(),
    /** FlareSolverr base URL (empty when disabled). */
    url: z.string(),
  }),
});
export type SettingsResponseT = z.infer<typeof SettingsResponseSchema>;

/** PUT /api/settings/proxy — replaces the global proxy config. */
export const ProxyUpdateRequestSchema = ProxySettingsSchema;
export type ProxyUpdateRequestT = z.infer<typeof ProxyUpdateRequestSchema>;
export const ProxyUpdateResponseSchema = SettingsResponseSchema;
export type ProxyUpdateResponseT = z.infer<typeof ProxyUpdateResponseSchema>;

/** PUT /api/settings/favorites — favorites scheduler settings (additive). */
export const FavoriteSchedulerSettingsUpdateRequestSchema = FavoriteSchedulerSettingsSchema;
export type FavoriteSchedulerSettingsUpdateRequestT = z.infer<
  typeof FavoriteSchedulerSettingsUpdateRequestSchema
>;
export const FavoriteSchedulerSettingsUpdateResponseSchema = SettingsResponseSchema;
export type FavoriteSchedulerSettingsUpdateResponseT = z.infer<
  typeof FavoriteSchedulerSettingsUpdateResponseSchema
>;

/** PUT /api/settings/output — replaces the output defaults (additive). */
export const OutputDefaultsUpdateRequestSchema = OutputDefaultsSchema;
export type OutputDefaultsUpdateRequestT = z.infer<typeof OutputDefaultsUpdateRequestSchema>;
export const OutputDefaultsUpdateResponseSchema = SettingsResponseSchema;

/** PUT /api/settings/performance — replaces the Performance group ([parity-sweep] M10). */
export const PerformanceSettingsUpdateRequestSchema = PerformanceSettingsSchema;
export type PerformanceSettingsUpdateRequestT = z.infer<typeof PerformanceSettingsUpdateRequestSchema>;
export const PerformanceSettingsUpdateResponseSchema = SettingsResponseSchema;
export type PerformanceSettingsUpdateResponseT = z.infer<typeof PerformanceSettingsUpdateResponseSchema>;

/** PUT /api/settings/retention — replaces job-history retention ([parity-sweep] M2). */
export const RetentionSettingsUpdateRequestSchema = RetentionSettingsSchema;
export type RetentionSettingsUpdateRequestT = z.infer<typeof RetentionSettingsUpdateRequestSchema>;
export const RetentionSettingsUpdateResponseSchema = SettingsResponseSchema;
export type RetentionSettingsUpdateResponseT = z.infer<typeof RetentionSettingsUpdateResponseSchema>;

/** PUT /api/settings/filename-policy — replaces the filename policy ([parity-sweep] M4). */
export const FilenamePolicySettingsUpdateRequestSchema = FilenamePolicySettingsSchema;
export type FilenamePolicySettingsUpdateRequestT = z.infer<typeof FilenamePolicySettingsUpdateRequestSchema>;
export const FilenamePolicySettingsUpdateResponseSchema = SettingsResponseSchema;
export type FilenamePolicySettingsUpdateResponseT = z.infer<typeof FilenamePolicySettingsUpdateResponseSchema>;

/** PUT /api/settings/diagnostics — replaces diagnostics settings ([parity-sweep] M13). */
export const DiagnosticsSettingsUpdateRequestSchema = DiagnosticsSettingsSchema;
export type DiagnosticsSettingsUpdateRequestT = z.infer<typeof DiagnosticsSettingsUpdateRequestSchema>;
export const DiagnosticsSettingsUpdateResponseSchema = SettingsResponseSchema;
export type DiagnosticsSettingsUpdateResponseT = z.infer<typeof DiagnosticsSettingsUpdateResponseSchema>;
export type OutputDefaultsUpdateResponseT = z.infer<typeof OutputDefaultsUpdateResponseSchema>;

// ── modules (§5.1 options API — combobox stores the INDEX) ───────────

export const ModuleOptionKindSchema = z.enum(['checkbox', 'edit', 'spinedit', 'combobox']);
export type ModuleOptionKindT = z.infer<typeof ModuleOptionKindSchema>;

export const ModuleOptionDescriptorSchema = z.object({
  name: z.string(),
  kind: ModuleOptionKindSchema,
  defaultValue: z.union([z.boolean(), z.string(), z.number()]),
  /** Combobox items — the STORED value is the item INDEX, not the text. */
  items: z.array(z.string()).optional(),
});
export type ModuleOptionDescriptorT = z.infer<typeof ModuleOptionDescriptorSchema>;

export const ModuleCapabilitiesSchema = z.object({
  requires_subprocess: z.boolean(),
  requires_browser: z.boolean(),
  bypass_python_gated: z.boolean(),
  /** Own source pulls fmd.imagepuzzle / fmd.mangafoxwatermark (both implemented). */
  requires_imagepuzzle: z.boolean(),
  requires_mangafoxwatermark: z.boolean(),
  /** §5.2 events the module declared via Init `On*` props. */
  events: z.array(z.string()),
  /** Contract CapabilityFlag ids (the D3 known-broken published set). */
  known_broken_flags: z.array(z.string()),
  /**
   * §6.8: the module declares BOTH directory events
   * (OnGetDirectoryPageNumber + OnGetNameAndLink) — a site without an
   * FMD2-DB catalog is still browsable via the live directory walk.
   */
  live_scrape_fallback: z.boolean(),
});
export type ModuleCapabilitiesT = z.infer<typeof ModuleCapabilitiesSchema>;

/**
 * Per-module site availability (dead-site discovery): the persisted
 * record joined onto every /api/modules row. `unknown` = never
 * checked (seeded state, silent — no row exists yet); the record is
 * written opportunistically by existing traffic paths and by the
 * manual per-row Check probe, NEVER by background/scheduled probing.
 */
export const ModuleAvailabilitySchema = z.object({
  status: z.enum(['reachable', 'unreachable', 'unknown']),
  /** ISO timestamp of the last confident write (null while unknown). */
  checkedAt: z.string().nullable(),
  /** Short reason carried by the last unreachable write. */
  reason: z.string().nullable(),
});
export type ModuleAvailabilityT = z.infer<typeof ModuleAvailabilitySchema>;

export const ModuleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  rootURL: z.string(),
  category: z.string(),
  accountSupport: z.boolean(),
  file: z.string(),
  enabled: z.boolean(),
  options: z.array(ModuleOptionDescriptorSchema),
  capabilities: ModuleCapabilitiesSchema,
  /**
   * Catalog install state joined from the CatalogStore receipts
   * (§6.4 getMeta — installed true/false). The site-first Browse
   * picker renders this as a chip and drives auto-provisioning from
   * it; it is NEVER a hex id the user must read (FMD2 parity:
   * cbSelectManga lists sites BY NAME, frmMain.pas:6186).
   */
  catalogInstalled: z.boolean(),
  /**
   * Site availability joined LIVE from the availability store — a
   * DIFFERENT concern from catalogInstalled (catalog = list readiness,
   * availability = last observed site reachability). Never gates
   * anything: a dimmed picker row stays clickable.
   */
  availability: ModuleAvailabilitySchema,
  /**
   * Per-module proxy override (§9/§10 settings). null = inherit the
   * global proxy; a config = EXACT SetProxy semantics for this module's
   * HTTP objects (a module's own SetProxy call still overrides at
   * runtime).
   */
  proxy: ProxySettingsSchema.nullable(),
});
export type ModuleSummaryT = z.infer<typeof ModuleSummarySchema>;

/**
 * POST /api/modules/:id/check — the manual per-row Check (Settings
 * registry): ONE probe of the module RootURL through the module's own
 * engine HTTP path. `verdict: none` = ambiguous (HTTP 4xx — origin
 * alive but possibly blocking): the record is intentionally unchanged.
 */
export const ModuleCheckResponseSchema = z.object({
  moduleId: z.string(),
  verdict: z.enum(['reachable', 'unreachable', 'none']),
  /** Human classification note for the UI toast. */
  detail: z.string(),
  availability: ModuleAvailabilitySchema,
});
export type ModuleCheckResponseT = z.infer<typeof ModuleCheckResponseSchema>;

export const ModuleListResponseSchema = z.object({
  modules: z.array(ModuleSummarySchema),
  count: z.number().int().nonnegative(),
});
export type ModuleListResponseT = z.infer<typeof ModuleListResponseSchema>;

/** One option value write — combobox carries the INTEGER item index. */
export const OptionValueSchema = z.union([z.boolean(), z.string(), z.number()]);
export type OptionValueT = z.infer<typeof OptionValueSchema>;

export const ModuleUpdateRequestSchema = z.object({
  enabled: z.boolean().optional(),
  /** Keyed by option name; validated against the module's descriptors. */
  options: z.record(z.string(), OptionValueSchema).optional(),
  /** FMD2 settings-cookie text form (`a=1; b=2`, §5.3). */
  cookies: z.string().optional(),
  /**
   * Per-module proxy override: a config sets it, explicit null clears
   * it back to "inherit the global proxy" (§9/§10 settings).
   */
  proxy: ProxySettingsSchema.nullable().optional(),
});
export type ModuleUpdateRequestT = z.infer<typeof ModuleUpdateRequestSchema>;

export const ModuleUpdateResponseSchema = ModuleSummarySchema;
export type ModuleUpdateResponseT = z.infer<typeof ModuleUpdateResponseSchema>;

/**
 * POST /api/modules/bulk — FMD2 Websites-tree bulk parity (pas:6400
 * Select All/Unselect All + the per-category tree checkboxes): one
 * enable/disable write over MANY modules. Target resolution: `ids`
 * (explicit list) OR `category` (exact category column match) OR
 * neither (every registered module — the global Select-all/None).
 */
export const ModuleBulkUpdateRequestSchema = z.object({
  enabled: z.boolean(),
  /** Exact category match (the Settings category-header bulk buttons). */
  category: z.string().min(1).max(200).optional(),
  /** Explicit module ids (max one batch sweep). */
  ids: z.array(ModuleIdSchema).max(1000).optional(),
});
export type ModuleBulkUpdateRequestT = z.infer<typeof ModuleBulkUpdateRequestSchema>;

export const ModuleBulkUpdateResponseSchema = z.object({
  modules: z.array(ModuleSummarySchema),
  updated: z.number().int().nonnegative(),
});
export type ModuleBulkUpdateResponseT = z.infer<typeof ModuleBulkUpdateResponseSchema>;

// ── sync ─────────────────────────────────────────────────────────────

/** lua/ tree sync outcome (the SweepSummary projection, D9 report). */
export const SyncModulesResponseSchema = z.object({
  ok: z.literal(true),
  summary: z.object({
    treeSha: z.string(),
    totalFiles: z.number().int().nonnegative(),
    registeredFiles: z.number().int().nonnegative(),
    failedFiles: z.number().int().nonnegative(),
    totalModules: z.number().int().nonnegative(),
    failures: z.array(z.object({ file: z.string(), error: z.string() })),
    knownBroken: z.record(z.string(), z.array(z.string())),
    eventCoverage: z.record(z.string(), z.number()),
  }),
});
export type SyncModulesResponseT = z.infer<typeof SyncModulesResponseSchema>;

/** One FMD2-DB catalog fetch/install outcome (§6.2–§6.3). */
export const CatalogSyncResultSchema = z.object({
  id: z.string(),
  state: z.enum(['unchanged', 'updated', 'failed']),
  dbSha: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type CatalogSyncResultT = z.infer<typeof CatalogSyncResultSchema>;

export const CatalogSyncResponseSchema = z.object({
  ok: z.literal(true),
  result: CatalogSyncResultSchema,
});
export type CatalogSyncResponseT = z.infer<typeof CatalogSyncResponseSchema>;

export const CatalogSyncAllResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(CatalogSyncResultSchema),
});
export type CatalogSyncAllResponseT = z.infer<typeof CatalogSyncAllResponseSchema>;

// ── catalog browse/search (§6.6) ─────────────────────────────────────

export const CatalogEntrySchema = z.object({
  link: z.string(),
  title: z.string(),
  alttitles: z.string(),
  authors: z.string(),
  artists: z.string(),
  genres: z.string(),
  status: z.string(),
  summary: z.string(),
  numChapter: z.number().int().nonnegative(),
  /** Julian day number (Pascal epoch 1899-12-30, §6.7). */
  jdn: z.number().int(),
});
export type CatalogEntryT = z.infer<typeof CatalogEntrySchema>;

/**
 * §6.8 discriminator: `catalog` = served from the installed FMD2-DB
 * db (§6.4–§6.6); `live` = served from the module's §5.8-normalized
 * directory walk (no catalog installed) — the UI badges it.
 */
export const CatalogSourceSchema = z.enum(['catalog', 'live']);
export type CatalogSourceT = z.infer<typeof CatalogSourceSchema>;

export const CatalogPageResponseSchema = z.object({
  entries: z.array(CatalogEntrySchema),
  /** Opaque next-page cursor; absent on the last page. */
  nextCursor: z.string().optional(),
  total: z.number().int().nonnegative().optional(),
  /** Where this page was served from (§6.8). */
  source: CatalogSourceSchema,
});
export type CatalogPageResponseT = z.infer<typeof CatalogPageResponseSchema>;

/** Shared page params for `latest`/`title` (DESIGN §10 `?page=`). */
export const CatalogBrowseQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
export type CatalogBrowseQueryT = z.infer<typeof CatalogBrowseQuerySchema>;

export const CatalogSearchQuerySchema = z
  .object({
    /** FTS5 user query (sanitized downstream by the store, §6.5).
     * Optional when any row filter is set (FMD2 Filter-panel parity —
     * frmMain.pas:3400 filters with empty title text). */
    q: z.string().max(500).optional(),
    status: z.string().max(100).optional(),
    genre: z.string().max(100).optional(),
    /**
     * FMD2 parity (additive): genre multi-select, joined per
     * `genresMode`. Wire forms: repeated params (`?genres=A&genres=B`,
     * the openapi-fetch array form) OR one comma-separated param
     * (`?genres=A,B` — FMD2 custom-genres semantics; the route
     * normalizes both to this array).
     */
    genres: z.array(z.string().min(1).max(100)).max(64).optional(),
    /**
     * FMD2 parity (additive, audit (b)2 fix): `!`/`-` prefixed custom
     * genres — each composes as a `NOT LIKE` exclude (AND among
     * excludes; the genresMode join applies to `genres` only). Same
     * wire forms as `genres` (repeated params or one csv param).
     */
    genresExclude: z.array(z.string().min(1).max(100)).max(64).optional(),
    /** `'all'` (FMD2 rbAll default) ANDs genre clauses; `'any'` ORs. */
    genresMode: z.enum(['all', 'any']).default('all'),
    /** FMD2 parity (additive): authors column LIKE contains. */
    authors: z.string().max(200).optional(),
    /** FMD2 parity (additive): artists column LIKE contains (edFilterArtists). */
    artists: z.string().max(200).optional(),
    /** FMD2 parity (additive): summary column LIKE contains (edFilterSummary). */
    summary: z.string().max(500).optional(),
    /** FMD2 cbOnlyNew parity (jdn-based): jdn > JDN(today) - newDays. */
    newDays: z.coerce.number().int().min(1).max(365).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(20),
  })
  .refine(
    (q): boolean =>
      (q.q !== undefined && q.q !== '') ||
      (q.status !== undefined && q.status !== '') ||
      (q.genre !== undefined && q.genre !== '') ||
      (q.genres !== undefined && q.genres.length > 0) ||
      (q.genresExclude !== undefined && q.genresExclude.length > 0) ||
      (q.authors !== undefined && q.authors !== '') ||
      (q.artists !== undefined && q.artists !== '') ||
      (q.summary !== undefined && q.summary !== '') ||
      q.newDays !== undefined,
    { message: 'search requires q or at least one filter' },
  );
export type CatalogSearchQueryT = z.infer<typeof CatalogSearchQuerySchema>;

/**
 * Normalize raw `genres` query input into the array wire form before
 * zod parsing: a single string becomes a one-element list and every
 * element is comma-split (FMD2 custom-genres semantics — "Separate
 * multiple genres with ','"; empty fragments dropped).
 */
export function normalizeGenresParam(raw: unknown): unknown {
  if (raw === undefined) {
    return undefined;
  }
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  return list.flatMap((item): unknown[] =>
    typeof item === 'string'
      ? item.split(',').map((part): string => part.trim()).filter((part) => part !== '')
      : [item],
  );
}

// ── all-sites union search (FMD2 cbSearchFromAllSites parity) ────────

/**
 * One catalog row tagged with its SOURCE SITE — FMD2 parity
 * (frmMain.pas:5170 vtMangaListGetHint shows RS_InfoWebsite +
 * TModuleContainer(Module).Name when FilterAllSites): every union
 * result row carries the website it came from.
 */
export const SearchEntrySchema = CatalogEntrySchema.extend({
  /** The 32-hex module id of the site whose catalog served this row. */
  site: z.string(),
  /** Human site name (the /api/modules join — never a hex id in the UI). */
  siteName: z.string(),
});
export type SearchEntryT = z.infer<typeof SearchEntrySchema>;

/** Per-site result count for the facet chips (count absent = unknown). */
export const SearchFacetSchema = z.object({
  siteId: z.string(),
  siteName: z.string(),
  count: z.number().int().nonnegative().optional(),
});
export type SearchFacetT = z.infer<typeof SearchFacetSchema>;

/**
 * Typed partial-failure state (never silent, never full failure): one
 * installed catalog that failed to answer — the rest of the union
 * still returns, and the UI shows a warning chip naming this site.
 */
export const SiteSearchFailureSchema = z.object({
  siteId: z.string(),
  siteName: z.string(),
  /** Why the site's search failed (store error message). */
  error: z.string(),
});
export type SiteSearchFailureT = z.infer<typeof SiteSearchFailureSchema>;

/**
 * An ENABLED site excluded from the union because no catalog is
 * installed (FMD2 parity: the all-sites filter unions INSTALLED local
 * DBs — a site without one is never scraped live to fill the gap).
 */
export const ExcludedSiteSchema = z.object({
  siteId: z.string(),
  siteName: z.string(),
  reason: z.literal('no-catalog'),
});
export type ExcludedSiteT = z.infer<typeof ExcludedSiteSchema>;

/**
 * GET /api/search query — the same filter vocabulary as the per-site
 * search (q optional when a filter is set, FMD2 Filter-panel parity).
 * The union runs over INSTALLED catalogs only.
 */
export const AllSitesSearchQuerySchema = z
  .object({
    q: z.string().max(500).optional(),
    status: z.string().max(100).optional(),
    genres: z.array(z.string().min(1).max(100)).max(64).optional(),
    /** `!`-prefixed custom genres — NOT LIKE excludes (same as per-site). */
    genresExclude: z.array(z.string().min(1).max(100)).max(64).optional(),
    genresMode: z.enum(['all', 'any']).default('all'),
    authors: z.string().max(200).optional(),
    artists: z.string().max(200).optional(),
    summary: z.string().max(500).optional(),
    newDays: z.coerce.number().int().min(1).max(365).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(
    (q): boolean =>
      (q.q !== undefined && q.q !== '') ||
      (q.status !== undefined && q.status !== '') ||
      (q.genres !== undefined && q.genres.length > 0) ||
      (q.genresExclude !== undefined && q.genresExclude.length > 0) ||
      (q.authors !== undefined && q.authors !== '') ||
      (q.artists !== undefined && q.artists !== '') ||
      (q.summary !== undefined && q.summary !== '') ||
      q.newDays !== undefined,
    { message: 'search requires q or at least one filter' },
  );
export type AllSitesSearchQueryT = z.infer<typeof AllSitesSearchQuerySchema>;

export const AllSitesSearchResponseSchema = z.object({
  entries: z.array(SearchEntrySchema),
  /** Opaque union cursor; absent on the last page. */
  nextCursor: z.string().optional(),
  /** Per-site totals (facet chips). */
  facets: z.array(SearchFacetSchema),
  /** Installed catalogs that failed — typed partial state. */
  warnings: z.array(SiteSearchFailureSchema),
  /** Enabled sites skipped because no catalog is installed. */
  excluded: z.array(ExcludedSiteSchema),
});
export type AllSitesSearchResponseT = z.infer<typeof AllSitesSearchResponseSchema>;

// ── live info (§5.8 pipeline, cached) ────────────────────────────────

/**
 * [parity-sweep] M14 (FMD2 edURL parity): `moduleId` is OPTIONAL —
 * a url-only request resolves the module by RootURL host match
 * (unknown/ambiguous hosts are typed errors). Exactly one of the two
 * addressing modes applies: explicit moduleId, or host resolution.
 */
export const InfoRequestSchema = z
  .object({
    moduleId: ModuleIdSchema.optional(),
    url: z.string().min(1),
  })
  .refine(
    (body): boolean => {
      // [parity-sweep] M14 url-only mode (host resolution) needs an
      // absolute URL. With an EXPLICIT moduleId a host-relative url is
      // accepted: FMD2-DB catalog links are stored host-relative
      // (RemoveHostFromURLsPair) and the route joins them against the
      // module's RootURL (FMD2 MaybeFillHost parity).
      if (body.moduleId !== undefined) {
        return true;
      }
      try {
        const parsed = new URL(body.url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'url must be an absolute http(s) URL' },
  );
export type InfoRequestT = z.infer<typeof InfoRequestSchema>;

/**
 * Cover proxy query (live-defect covers story): the ADDRESSED module +
 * the absolute cover url that module's GetInfo returned. The url is
 * validated against the module's permitted hosts server-side (RootURL
 * domain + the curated image-CDN allowance) — this is a same-origin
 * cover seam, never an open proxy. Plain GET, never auth-gated (the
 * *arr gate ordering; covers are not secrets).
 */
export const CoverQuerySchema = z.object({
  moduleId: ModuleIdSchema,
  url: z.string().min(1),
});
export type CoverQueryT = z.infer<typeof CoverQuerySchema>;

/**
 * The normalized MANGAINFO state in the oracle's emit order (§5.8) —
 * plus the manga's downloaded-chapter ledger projection: `downloaded`
 * carries the chapter LINKS already recorded in `downloaded_chapters`
 * for this (moduleId, url) (merged text split into lines). It is
 * computed at response time — NEVER cached with the info snapshot — so
 * a just-finished download flips the set on the next call.
 */
export const InfoResponseSchema = z.object({
  /** The module that served this info (explicit or host-resolved). */
  moduleId: ModuleIdSchema,
  title: z.string(),
  altTitles: z.string(),
  authors: z.string(),
  artists: z.string(),
  genres: z.string(),
  status: z.string(),
  summary: z.string(),
  coverLink: z.string(),
  url: z.string(),
  link: z.string(),
  chapterLinks: z.array(z.string()),
  chapterNames: z.array(z.string()),
  numChapter: z.number().int().nonnegative(),
  downloaded: z.array(z.string()),
});
export type InfoResponseT = z.infer<typeof InfoResponseSchema>;

// ── jobs (§7.1, idempotent download create) ──────────────────────────
// `JobSchema` / `JobT` come from @fmd/contract (see header) — the same
// zod source the WS hub serializes event snapshots from.

export const JobCreateRequestSchema = z.object({
  moduleId: ModuleIdSchema,
  /** Manga page URL the chapter belongs to (§7.1 Job = chapter). */
  mangaUrl: z.string().min(1),
  mangaTitle: z.string().min(1).optional(),
  chapterLink: z.string().min(1),
  chapterName: z.string().min(1).optional(),
  /**
   * Idempotency key (§10): identical-key replay → the ORIGINAL job with
   * 200; key reuse with a DIFFERENT payload → 409.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
  /**
   * Add-as-stopped parity (FMD2 cbAddAsStopped, frmMain.lfm:1110): the
   * job is created `queued` but HELD — the download lane does not claim
   * it until POST /api/jobs/:id/resume lifts the hold.
   */
  paused: z.boolean().optional(),
  /**
   * Save-to override (FMD2 edSaveTo parity, frmMain.pas:5613): the
   * directory the finalized artifact lands in — REPLACES the default
   * `library/<module>/<manga>` path. Relative paths resolve against
   * the library root; the file name keeps §7.1 sanitization.
   */
  saveTo: z.string().min(1).max(1024).optional(),
});
export type JobCreateRequestT = z.infer<typeof JobCreateRequestSchema>;

export const JobCreatedResponseSchema = z.object({ job: JobSchema });
export type JobCreatedResponseT = z.infer<typeof JobCreatedResponseSchema>;

/**
 * Batch download-all create (browse row menu, FMD2 pmMangaList
 * miMangaListDownloadAll parity): ONE request per MANGA instead of one
 * chatty request per chapter. `chapters: 'all'` resolves the live
 * chapter list through the §5.8 info path (cached like POST /api/info);
 * an explicit link array enqueues exactly that selection in the given
 * order (no info fetch). The idempotency key is REQUIRED and shared by
 * every derived per-chapter key (`<key>:<index>`) — the whole batch
 * replays as one unit per §10 while its jobs are live.
 */
export const JobBatchCreateRequestSchema = z.object({
  moduleId: ModuleIdSchema,
  /** Manga page URL (§7.1 Job = chapter). */
  mangaUrl: z.string().min(1),
  mangaTitle: z.string().min(1).optional(),
  /** 'all' (live chapter list) or an explicit chapter-link selection. */
  chapters: z.union([z.literal('all'), z.array(z.string().min(1)).min(1)]),
  /**
   * Batch idempotency key (§10): REQUIRED — every per-chapter create
   * derives `<key>:<index>` (index in the resolved chapter order, so the
   * key binds to the chapter SEQUENCE: a shifted/different list under
   * the same key is a 409 different-payload conflict).
   */
  idempotencyKey: z.string().min(1).max(200),
  /** Add-as-stopped parity — applied to every chapter job. */
  paused: z.boolean().optional(),
  /** Save-to override parity — applied to every chapter job. */
  saveTo: z.string().min(1).max(1024).optional(),
});
export type JobBatchCreateRequestT = z.infer<typeof JobBatchCreateRequestSchema>;

/**
 * `replayed` is true only when EVERY chapter job replayed an existing
 * LIVE row (the double-submit case); any fresh or chained create is a
 * 201.
 */
export const JobBatchCreatedResponseSchema = z.object({
  jobs: z.array(JobSchema),
  replayed: z.boolean(),
});
export type JobBatchCreatedResponseT = z.infer<typeof JobBatchCreatedResponseSchema>;

/**
 * Jobs-list query (Downloads parity): `state` keeps the single-state
 * filter (back-compat) while `states` carries the web multi-select
 * (comma-separated JobState values); `q` is a title/chapter substring
 * (case-insensitive, matches mangaTitle or chapterName payload fields);
 * `addedFrom`/`addedTo` bound the created-at window (calendar dates,
 * `addedTo` inclusive of its day — the client computes the FMD2 History
 * windows Today/7d/Month/Older and custom From/To into this range).
 *
 * R5 arrival (additive): `since` is an ISO-timestamp floor on the
 * row's LAST TRANSITION (`updatedAt`) — with `state=done` it selects
 * chapters FINISHED since the timestamp, the 'While you were away'
 * summary's download news source. Absent → unfiltered (back-compat).
 */
export const JobsListQuerySchema = z.object({
  state: JobStateSchema.optional(),
  states: z.string().regex(/^([a-z]+)(,[a-z]+)*$/, 'expected comma-separated job states').optional(),
  q: z.string().min(1).max(200).optional(),
  addedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
  addedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
  since: z.iso.datetime({ offset: false }).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type JobsListQueryT = z.infer<typeof JobsListQuerySchema>;

export const JobsListResponseSchema = z.object({
  jobs: z.array(JobSchema),
  nextCursor: z.string().optional(),
});
export type JobsListResponseT = z.infer<typeof JobsListResponseSchema>;

/** Queue row id (monotonic integer, decimal string). */
export const JobIdSchema = z.string().regex(/^\d+$/, 'expected a numeric job id');
export type JobIdT = z.infer<typeof JobIdSchema>;

// ── downloads-tab task actions (FMD2 pmDownload parity, web-adapted) ──

export {
  JobActionTypeSchema,
  type JobActionTypeT,
  JobActionRequestSchema,
  type JobActionRequestT,
  JobActionResponseSchema,
  type JobActionResponseT,
  JobDeleteQuerySchema,
  type JobDeleteQueryT,
  JobBulkActionSchema,
  type JobBulkActionT,
  JobBulkScopeSchema,
  type JobBulkScopeT,
  JobBulkActionRequestSchema,
  type JobBulkActionRequestT,
  JobBulkActionResponseSchema,
  type JobBulkActionResponseT,
} from '@fmd/contract';

/** DELETE /api/jobs/:id response — the removed row + artifact outcome. */
export const JobDeletedResponseSchema = z.object({
  job: JobSchema,
  dataDeleted: z.boolean(),
});
export type JobDeletedResponseT = z.infer<typeof JobDeletedResponseSchema>;

// ── library (§7.1 listing/download) ──────────────────────────────────

/** One finalized chapter artifact (§9 `library_files` projection). */
export const LibraryFileSchema = z.object({
  id: JobIdSchema,
  moduleId: z.string().min(1),
  manga: z.string().min(1),
  fileName: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  /**
   * [file-state] stat-verified truth ('downloaded' | 'missing') —
   * additive; absent when the deployment has no file-state service.
   */
  state: z.enum(['downloaded', 'missing']).optional(),
  /** [file-state] verification stamp (null = never verified). */
  verifiedAt: TimestampSchema.nullable().optional(),
  /** [file-state] root-relative display path (clamped; omitted when
   * the recorded path resolves outside the library root). */
  path: z.string().min(1).optional(),
  /** [file-state] the recorded absolute path (copy-path target). */
  absolutePath: z.string().min(1).optional(),
  /** [file-state] disk mtime (verified snapshot of a present file). */
  mtime: TimestampSchema.optional(),
});
export type LibraryFileT = z.infer<typeof LibraryFileSchema>;

export const LibraryListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * [file-state] Library page filter chips (URL-as-truth): all (default),
   * missing (stat-verified missing rows), orphans (the LAST RESCAN's
   * persisted orphan list — orphan truth is rescan truth, never a
   * live walk per listing).
   */
  filter: z.enum(['all', 'missing', 'orphans']).optional(),
});
export type LibraryListQueryT = z.infer<typeof LibraryListQuerySchema>;

/** [file-state] one orphan file (rescan truth; root-relative path). */
export const LibraryOrphanFileSchema = z.object({
  path: z.string().min(1),
  absolutePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  mtime: TimestampSchema,
});
export type LibraryOrphanFileT = z.infer<typeof LibraryOrphanFileSchema>;

export const LibraryListResponseSchema = z.object({
  files: z.array(LibraryFileSchema),
  nextCursor: z.string().optional(),
  /** [file-state] filter=orphans serves the persisted rescan orphans here. */
  orphans: z.array(LibraryOrphanFileSchema).optional(),
});
export type LibraryListResponseT = z.infer<typeof LibraryListResponseSchema>;

// ── library file-state (title files, rescan) ─────────────────────────

/** [file-state] GET /api/library/title-files query. */
export const TitleFilesQuerySchema = z.object({
  moduleId: z.string().min(1),
  url: z.string().min(1),
  /** Manga title (legacy row matching by sanitized layout segment). */
  manga: z.string().optional(),
  /** Explicit refresh: force re-verification regardless of staleness. */
  refresh: z.coerce.boolean().optional(),
});
export type TitleFilesQueryT = z.infer<typeof TitleFilesQuerySchema>;

/**
 * [file-state] one chapter file on a title's Files section.
 * state 'not_downloaded' is chapter-side (web merges against the live
 * chapter list); entries here are the tracked (ledger) side.
 */
export const TitleFileEntrySchema = z.object({
  id: JobIdSchema.optional(),
  chapterLink: z.string().optional(),
  fileName: z.string().optional(),
  path: z.string().min(1).optional(),
  absolutePath: z.string().min(1).optional(),
  bytes: z.number().int().nonnegative().optional(),
  mtime: TimestampSchema.optional(),
  state: z.enum(['downloaded', 'missing']),
  verifiedAt: TimestampSchema.optional(),
});
export type TitleFileEntryT = z.infer<typeof TitleFileEntrySchema>;

export const TitleFilesResponseSchema = z.object({
  moduleId: z.string().min(1),
  url: z.string().min(1),
  /** The verification pass stamp (the age anchor for UI tooltips). */
  verifiedAt: TimestampSchema,
  files: z.array(TitleFileEntrySchema),
  orphans: z.array(LibraryOrphanFileSchema),
});
export type TitleFilesResponseT = z.infer<typeof TitleFilesResponseSchema>;

/** [file-state] POST /api/library/rescan query (omit = whole library). */
export const RescanQuerySchema = z.object({
  moduleId: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  manga: z.string().optional(),
});
export type RescanQueryT = z.infer<typeof RescanQuerySchema>;

/** [file-state] the persisted rescan diff report. */
export const RescanReportSchema = z.object({
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  durationMs: z.number().int().nonnegative(),
  scope: z.union([
    z.literal('library'),
    z.object({
      kind: z.literal('title'),
      moduleId: z.string().min(1),
      url: z.string().min(1),
    }),
  ]),
  counts: z.object({
    scanned: z.number().int().nonnegative(),
    present: z.number().int().nonnegative(),
    relinked: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    orphans: z.number().int().nonnegative(),
    outsideRoot: z.number().int().nonnegative(),
  }),
  relinked: z.array(z.object({
    id: JobIdSchema,
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
  })),
  missing: z.array(z.object({
    id: JobIdSchema,
    manga: z.string().min(1),
    fileName: z.string().min(1),
    path: z.string().min(1).optional(),
    /** Ambiguous same-name candidates (the orphan side of the pair). */
    candidates: z.array(z.string().min(1)),
  })),
  orphans: z.array(LibraryOrphanFileSchema),
});
export type RescanReportT = z.infer<typeof RescanReportSchema>;

export const RescanResponseSchema = z.object({
  report: RescanReportSchema,
});
export type RescanResponseT = z.infer<typeof RescanResponseSchema>;

export const LastRescanResponseSchema = z.object({
  report: RescanReportSchema.nullable(),
});
export type LastRescanResponseT = z.infer<typeof LastRescanResponseSchema>;

// ── favorites (§7.2 DoCheck engine + scheduler) ──────────────────────

/** Favorite id — `LowerCase(ModuleID+Link)`; URL-encoded in paths. */
export const FavoriteIdSchema = z.string().min(1);

/** One favorite (§9 `favorite` projection): `id` =
 * `LowerCase(ModuleID+Link)` (the downloaded_chapters join key). */
export const FavoriteSchema = z.object({
  id: z.string().min(1),
  moduleId: z.string().min(1),
  url: z.string().min(1),
  title: z.string().nullable(),
  status: z.string().nullable(),
  /** ChapterLinks.Count at the last successful check (immediate update). */
  currentChapter: z.number().int().nonnegative().nullable(),
  /** New chapters found at the last check (the UI badge). */
  newChapterCount: z.number().int().nonnegative(),
  /** Auto-download eligible new chapters through the pipeline. */
  autoDownload: z.boolean(),
  lastCheck: TimestampSchema.nullable(),
  lastUpdated: TimestampSchema.nullable(),
  /** Per-favorite download directory override ('' = default layout). */
  saveTo: z.string().nullable(),
  /** Disabled favorites are skipped by the scheduler + the enabled-scope batch checks. */
  enabled: z.boolean(),
  /** Creation stamp (FMD2 DateAdded). */
  dateAdded: TimestampSchema.nullable(),
  /**
   * Covers live-defect: the §5.8 coverLink captured at the last
   * successful check — the favorites grid renders covers through the
   * same-origin cover proxy (`GET /api/cover`) off this stored url;
   * null when no check has captured one yet.
   */
  coverLink: z.string().nullable(),
  /**
   * R5 arrival (additive, list-call only): does this favorite have
   * news relative to the caller's `since` query param — a check ran at
   * or after `since` AND found new chapters (`lastCheck >= since &&
   * newChapterCount > 0`)? Absent (no `since` on the call, or a
   * single-favorite route) → undefined.
   */
  newsSince: z.boolean().optional(),
});
export type FavoriteT = z.infer<typeof FavoriteSchema>;

/**
 * R5 arrival (additive): favorites-list query. `since` (ISO timestamp,
 * the client's last-visit stamp) switches each row's additive
 * `newsSince` flag on. No other list behavior changes.
 */
export const FavoriteListQuerySchema = z.object({
  since: z.iso.datetime({ offset: false }).optional(),
});
export type FavoriteListQueryT = z.infer<typeof FavoriteListQuerySchema>;

export const FavoriteListResponseSchema = z.object({ favorites: z.array(FavoriteSchema) });
export type FavoriteListResponseT = z.infer<typeof FavoriteListResponseSchema>;

export const FavoriteResponseSchema = z.object({ favorite: FavoriteSchema });
export type FavoriteResponseT = z.infer<typeof FavoriteResponseSchema>;

export const FavoriteCreateRequestSchema = z.object({
  moduleId: ModuleIdSchema,
  url: z.string().min(1),
  title: z.string().min(1).optional(),
  autoDownload: z.boolean().optional(),
});
export type FavoriteCreateRequestT = z.infer<typeof FavoriteCreateRequestSchema>;

/** Favorite patch — the auto-download toggle, rename, save-to and
 * enable/disable all live here (pmFavorites parity). */
export const FavoriteUpdateRequestSchema = z.object({
  title: z.string().min(1).optional(),
  autoDownload: z.boolean().optional(),
  /** Custom save-to directory ('' resets to the default layout). */
  saveTo: z.string().max(1024).optional(),
  enabled: z.boolean().optional(),
});
export type FavoriteUpdateRequestT = z.infer<typeof FavoriteUpdateRequestSchema>;

/** POST /api/favorites/import — the tag-100 transfer-favorite path (D4). */
export const FavoriteImportRequestSchema = FavoriteCreateRequestSchema;
export type FavoriteImportRequestT = z.infer<typeof FavoriteImportRequestSchema>;

// ── import from FMD2 (two-phase API: analyze → apply) ────────────────

/** One file the upload contained but nothing imports from (report row). */
export const Fmd2NotImportableSchema = z.object({
  source: z.string(),
  reason: z.string(),
});
export type Fmd2NotImportableT = z.infer<typeof Fmd2NotImportableSchema>;

/**
 * POST /api/import/fmd2/analyze response — the preview (parses WITHOUT
 * writing anything). Credential fields are NAMES ONLY; secret values
 * are never echoed in any response.
 */
export const Fmd2ImportPreviewSchema = z.object({
  /** Recognized + consumed file names (favorites.db, settings.json, …). */
  files: z.array(z.string()),
  ignored: z.array(Fmd2NotImportableSchema),
  favorites: z.object({
    total: z.number().int().nonnegative(),
    importable: z.number().int().nonnegative(),
    bySite: z.array(
      z.object({
        moduleId: z.string(),
        siteName: z.string(),
        count: z.number().int().nonnegative(),
        mapped: z.boolean(),
      }),
    ),
    /** Dead/renamed/typo'd catalog ids — surfaced, import proceeds without. */
    unmappedSiteIds: z.array(
      z.object({ id: z.string(), count: z.number().int().nonnegative() }),
    ),
  }),
  downloadedLedger: z.object({
    rows: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
  }),
  settings: z.object({
    mappable: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        source: z.string(),
        /** Sanitized target value (never a secret). */
        preview: z.string(),
        /** Applying needs the explicit credential opt-in. */
        requiresCredentials: z.boolean(),
      }),
    ),
    notImportable: z.array(Fmd2NotImportableSchema),
  }),
  credentials: z.object({
    sites: z.array(
      z.object({
        moduleId: z.string(),
        siteName: z.string(),
        fields: z.array(z.string()),
      }),
    ),
    globalProxyAuth: z.boolean(),
  }),
  /** Server-held staging handle — apply may re-upload OR present this. */
  analyzeToken: z.string(),
});
export type Fmd2ImportPreviewT = z.infer<typeof Fmd2ImportPreviewSchema>;

/**
 * POST /api/import/fmd2/apply request (JSON mode): the analyze token
 * for the staged upload + the user's confirmed selections. The same
 * route accepts multipart (files + a `selections` JSON field) instead.
 * Credential import is OPT-IN (`credentials`, off by default).
 */
export const Fmd2ImportApplyRequestSchema = z.object({
  token: z.string().min(1).optional(),
  favorites: z.boolean().optional(),
  settings: z.array(z.string()).optional(),
  credentials: z.array(z.string()).optional(),
});
export type Fmd2ImportApplyRequestT = z.infer<typeof Fmd2ImportApplyRequestSchema>;

/** POST /api/import/fmd2/apply response — the import report. */
export const Fmd2ImportApplyReportSchema = z.object({
  favorites: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({ label: z.string(), reason: z.string() }),
    ),
    unmappedSiteIds: z.array(
      z.object({ id: z.string(), count: z.number().int().nonnegative() }),
    ),
    /** Desktop save-to paths deliberately not carried (server paths differ). */
    saveToPathsDropped: z.number().int().nonnegative(),
  }),
  downloadedLedgerRowsApplied: z.number().int().nonnegative(),
  credentials: z.object({
    imported: z.array(
      z.object({ moduleId: z.string(), fields: z.array(z.string()) }),
    ),
    skipped: z.array(
      z.object({ moduleId: z.string(), reason: z.string() }),
    ),
  }),
  settings: z.object({
    applied: z.array(
      z.object({ key: z.string(), detail: z.string() }),
    ),
    notImportable: z.array(Fmd2NotImportableSchema),
  }),
});
export type Fmd2ImportApplyReportT = z.infer<typeof Fmd2ImportApplyReportSchema>;

export const FavoriteNewChapterSchema = z.object({
  position: z.number().int().nonnegative(),
  link: z.string(),
  name: z.string(),
});
export type FavoriteNewChapterT = z.infer<typeof FavoriteNewChapterSchema>;

/** Manual check-now result (the immediate DoCheck cycle for one favorite). */
export const FavoriteCheckResponseSchema = z.object({
  favorite: FavoriteSchema,
  queuedDownloads: z.number().int().nonnegative(),
  newChapters: z.array(FavoriteNewChapterSchema),
});
export type FavoriteCheckResponseT = z.infer<typeof FavoriteCheckResponseSchema>;

// ── favorites batch check (btFavoritesCheckNewChapter parity) ───────

/** Which rows a batch check touches (FMD2 Check-for-new-chapter scopes). */
export const FavoriteCheckScopeSchema = z.enum(['all', 'enabled', 'disabled']);
export type FavoriteCheckScopeT = z.infer<typeof FavoriteCheckScopeSchema>;

export const FavoriteCheckBatchRequestSchema = z.object({
  scope: FavoriteCheckScopeSchema.default('all'),
});
export type FavoriteCheckBatchRequestT = z.infer<typeof FavoriteCheckBatchRequestSchema>;

/** One row of the batch result (per-favorite DoCheck outcome). */
export const FavoriteCheckBatchItemSchema = z.object({
  favorite: FavoriteSchema,
  /** 'checked' | 'skipped' (link-less row) | 'failed' (live info error). */
  status: z.enum(['checked', 'skipped', 'failed']),
  newChapters: z.array(FavoriteNewChapterSchema),
  queuedDownloads: z.number().int().nonnegative(),
  /** Failure detail (status='failed' only). */
  error: z.string().optional(),
});
export type FavoriteCheckBatchItemT = z.infer<typeof FavoriteCheckBatchItemSchema>;

export const FavoriteCheckBatchResponseSchema = z.object({
  scope: FavoriteCheckScopeSchema,
  /** true when a cancel landed mid-run (remaining rows untouched). */
  cancelled: z.boolean(),
  checked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  queuedDownloads: z.number().int().nonnegative(),
  results: z.array(FavoriteCheckBatchItemSchema),
});
export type FavoriteCheckBatchResponseT = z.infer<typeof FavoriteCheckBatchResponseSchema>;

export const FavoriteCheckBatchCancelResponseSchema = z.object({
  /** false when no batch run was in flight (idempotent cancel). */
  cancelled: z.boolean(),
});
export type FavoriteCheckBatchCancelResponseT = z.infer<typeof FavoriteCheckBatchCancelResponseSchema>;

// ── favorites website transfer (frmTransferFavorites parity) ────────

export const FavoriteTransferPreviewRequestSchema = z.object({
  targetModuleId: ModuleIdSchema,
});
export type FavoriteTransferPreviewRequestT = z.infer<typeof FavoriteTransferPreviewRequestSchema>;

/** Target-site mapping preview: catalog title-match + GetInfo dry-run. */
export const FavoriteTransferPreviewResponseSchema = z.object({
  targetModuleId: z.string().min(1),
  /** true when the title resolves to a live target-site manga. */
  valid: z.boolean(),
  /** The resolved target link (valid only). */
  targetUrl: z.string().nullable(),
  /** The target-site title found (valid only). */
  matchedTitle: z.string().nullable(),
  /** Why the mapping is invalid ('no-catalog' | 'not-found' | 'get-info-failed' | 'unknown-module'). */
  reason: z.string().optional(),
});
export type FavoriteTransferPreviewResponseT = z.infer<typeof FavoriteTransferPreviewResponseSchema>;

export const FavoriteTransferRequestSchema = z.object({
  targetModuleId: ModuleIdSchema,
  /** Clear the downloaded list and re-ingest the live target-site list. */
  clearDownloadedList: z.boolean().default(false),
});
export type FavoriteTransferRequestT = z.infer<typeof FavoriteTransferRequestSchema>;

export const FavoriteTransferResponseSchema = z.object({
  favorite: FavoriteSchema,
  /** true when the clear-and-reload tag-100 branch ran. */
  reloadedFromServer: z.boolean(),
});
export type FavoriteTransferResponseT = z.infer<typeof FavoriteTransferResponseSchema>;

// ── accounts (§8.6/D4 module-scoped account CRUD + login) ────────────

/** The §5.2 account-status constants (module AccountState), by name. */
export const AccountStatusSchema = z.enum(['asUnknown', 'asChecking', 'asValid', 'asInvalid']);
export type AccountStatusT = z.infer<typeof AccountStatusSchema>;

/** One account projection — NEVER the password (write-only credential). */
export const AccountViewSchema = z.object({
  moduleId: ModuleIdSchema,
  username: z.string(),
  enabled: z.boolean(),
  status: AccountStatusSchema,
});
export type AccountViewT = z.infer<typeof AccountViewSchema>;

export const AccountListResponseSchema = z.object({
  accounts: z.array(AccountViewSchema),
  count: z.number().int().nonnegative(),
});
export type AccountListResponseT = z.infer<typeof AccountListResponseSchema>;

export const AccountResponseSchema = z.object({ account: AccountViewSchema });
export type AccountResponseT = z.infer<typeof AccountResponseSchema>;

/** PUT /api/accounts/:moduleId — omitted password/cookies KEEP the stored
 * values (the credential never round-trips through the API). */
export const AccountUpsertRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().optional(),
  cookies: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type AccountUpsertRequestT = z.infer<typeof AccountUpsertRequestSchema>;

/** POST /api/accounts/:moduleId/login — the OnLogin run result. */
export const AccountLoginResponseSchema = z.object({
  account: AccountViewSchema,
  ok: z.boolean(),
});
export type AccountLoginResponseT = z.infer<typeof AccountLoginResponseSchema>;

// ── parse helper ─────────────────────────────────────────────────────

/**
 * The ONLY validation entry point: parse `data` with `schema`, mapping
 * zod issues onto the typed error envelope (400 validation_error).
 * Handlers receive the inferred, narrowed value — never `any`.
 */
export function parseOr400<T>(schema: ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  throw new ApiError(400, 'validation_error', `invalid ${what}`, { issues });
}
