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

/** GET /api/settings — global proxy + the §5.11 browser profile state. */
export const SettingsResponseSchema = z.object({
  proxy: ProxySettingsSchema,
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
   * Per-module proxy override (§9/§10 settings). null = inherit the
   * global proxy; a config = EXACT SetProxy semantics for this module's
   * HTTP objects (a module's own SetProxy call still overrides at
   * runtime).
   */
  proxy: ProxySettingsSchema.nullable(),
});
export type ModuleSummaryT = z.infer<typeof ModuleSummarySchema>;

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
    /** `'all'` (FMD2 rbAll default) ANDs genre clauses; `'any'` ORs them. */
    genresMode: z.enum(['all', 'any']).default('all'),
    /** FMD2 parity (additive): authors column LIKE contains. */
    authors: z.string().max(200).optional(),
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
      (q.authors !== undefined && q.authors !== '') ||
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
    genresMode: z.enum(['all', 'any']).default('all'),
    authors: z.string().max(200).optional(),
    newDays: z.coerce.number().int().min(1).max(365).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(
    (q): boolean =>
      (q.q !== undefined && q.q !== '') ||
      (q.status !== undefined && q.status !== '') ||
      (q.genres !== undefined && q.genres.length > 0) ||
      (q.authors !== undefined && q.authors !== '') ||
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

export const InfoRequestSchema = z.object({
  moduleId: ModuleIdSchema,
  url: z.string().min(1),
});
export type InfoRequestT = z.infer<typeof InfoRequestSchema>;

/** The normalized MANGAINFO state in the oracle's emit order (§5.8). */
export const InfoResponseSchema = z.object({
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
});
export type JobCreateRequestT = z.infer<typeof JobCreateRequestSchema>;

export const JobCreatedResponseSchema = z.object({ job: JobSchema });
export type JobCreatedResponseT = z.infer<typeof JobCreatedResponseSchema>;

export const JobsListQuerySchema = z.object({
  state: JobStateSchema.optional(),
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

// ── library (§7.1 listing/download) ──────────────────────────────────

/** One finalized chapter artifact (§9 `library_files` projection). */
export const LibraryFileSchema = z.object({
  id: JobIdSchema,
  moduleId: z.string().min(1),
  manga: z.string().min(1),
  fileName: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
});
export type LibraryFileT = z.infer<typeof LibraryFileSchema>;

export const LibraryListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type LibraryListQueryT = z.infer<typeof LibraryListQuerySchema>;

export const LibraryListResponseSchema = z.object({
  files: z.array(LibraryFileSchema),
  nextCursor: z.string().optional(),
});
export type LibraryListResponseT = z.infer<typeof LibraryListResponseSchema>;

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
});
export type FavoriteT = z.infer<typeof FavoriteSchema>;

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

/** Favorite patch — the auto-download toggle lives here. */
export const FavoriteUpdateRequestSchema = z.object({
  title: z.string().min(1).optional(),
  autoDownload: z.boolean().optional(),
});
export type FavoriteUpdateRequestT = z.infer<typeof FavoriteUpdateRequestSchema>;

/** POST /api/favorites/import — the tag-100 transfer-favorite path (D4). */
export const FavoriteImportRequestSchema = FavoriteCreateRequestSchema;
export type FavoriteImportRequestT = FavoriteCreateRequestT;

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
