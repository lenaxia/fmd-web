/**
 * API service ports (§10 route → domain seams) plus in-memory dev/test
 * implementations. Routes depend ONLY on these interfaces, so the
 * SQLite/db-story adapters can drop in later without touching route
 * code. The in-memory implementations are the documented stand-ins for
 * app.db (same pattern as `InMemoryModuleRegistryPersistence`).
 *
 * Idempotency (§10) lives in the job port: identical-key replay
 * returns the ORIGINAL job; key reuse with a different payload is a
 * 409 conflict. The payload fingerprint is a canonical-JSON sha256
 * over the create body minus the key itself.
 */
import { createHash } from 'node:crypto';
import { existsSync, rmSync, statSync } from 'node:fs';
import type { RegistrationRecord } from '../engine/facade.js';
import { isValidCatalogId } from '../sync/db/catalog-store.js';
import type {
  CatalogStore,
  CatalogSyncProgressT,
  CatalogSyncPhaseT,
  JobActionTypeT,
  JobBulkActionRequestT,
  JobBulkActionResponseT,
  JobStateT,
  NormalizedInfo,
} from '@fmd/contract';
import { catalogSyncJobId } from '@fmd/contract';
import { OutputDefaultsSchema } from './schemas.js';
import type {
  FavoriteCheckBatchItemT,
  FavoriteCheckBatchResponseT,
  FavoriteCheckResponseT,
  FavoriteCheckScopeT,
  FavoriteCreateRequestT,
  FavoriteSchedulerSettingsT,
  FavoriteT,
  FavoriteTransferPreviewResponseT,
  FavoriteUpdateRequestT,
} from './schemas.js';
import type {
  ModuleCapabilitiesT,
  ModuleSummaryT,
  OptionValueT,
  OutputDefaultsT,
  PerformanceSettingsT,
  RetentionSettingsT,
  FilenamePolicySettingsT,
  DiagnosticsSettingsT,
  ProxySettingsT,
  SettingsResponseT,
} from './schemas.js';
import { ApiError } from './errors.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { downloadedChaptersKey } from '../jobs/library/merge.js';
import { UNKNOWN_AVAILABILITY, type SiteAvailabilityRecord } from '../runtime/site-availability.js';

// ── modules ──────────────────────────────────────────────────────────

/** Read/write projection of the §9 module_state registry columns. */
export interface ModuleService {
  list(): ModuleSummaryT[];
  get(id: string): ModuleSummaryT | undefined;
  /** Validate + apply an enable/options/cookies/proxy patch (§9 module_state). */
  update(
    id: string,
    patch: {
      enabled?: boolean;
      options?: Record<string, OptionValueT>;
      cookies?: string;
      proxy?: ProxySettingsT | null;
    },
  ): ModuleSummaryT;
}

/**
 * §5.10 capability flip (D2/§5.11): when the compose `browser` profile
 * is active, the known-broken flag ids it SATISFIES drop from the
 * published set — `fmd.subprocess` (the subprocess stub routes to the
 * sidecar adapter), `madara.run_html_load` and `webdriver.bypass`
 * (FlareSolverr + Chromium answer the browser-dependent paths). The
 * static requires_* booleans stay truthful (they describe what the
 * module NEEDS, not what the runtime currently provides).
 */
export const BROWSER_PROFILE_SATISFIED_FLAGS: readonly string[] = [
  'fmd.subprocess',
  'madara.run_html_load',
  'webdriver.bypass',
];

export function applyBrowserProfile(
  capabilities: ModuleCapabilitiesT,
  profileEnabled: boolean,
): ModuleCapabilitiesT {
  if (!profileEnabled) {
    return capabilities;
  }
  return {
    ...capabilities,
    known_broken_flags: capabilities.known_broken_flags.filter(
      (flag): boolean => !BROWSER_PROFILE_SATISFIED_FLAGS.includes(flag),
    ),
  };
}

function toSummary(
  row: RegistrationRecord,
  enabled: boolean,
  proxy: ProxySettingsT | null,
  browserProfileEnabled: boolean,
  catalogInstalled: (id: string) => boolean,
  availability: (id: string) => SiteAvailabilityRecord,
): ModuleSummaryT {
  return {
    id: row.id,
    name: row.name,
    rootURL: row.rootURL,
    category: row.category,
    accountSupport: row.accountSupport,
    file: row.file,
    enabled,
    options: row.options.map((o) =>
      o.items === undefined
        ? { name: o.name, kind: o.kind, defaultValue: o.defaultValue }
        : { name: o.name, kind: o.kind, defaultValue: o.defaultValue, items: [...o.items] },
    ),
    proxy,
    catalogInstalled: catalogInstalled(row.id),
    availability: availability(row.id),
    capabilities: applyBrowserProfile(
      {
        requires_subprocess: row.capabilities.requires_subprocess,
        requires_browser: row.capabilities.requires_browser,
        bypass_python_gated: row.capabilities.bypass_python_gated,
        requires_imagepuzzle: row.capabilities.requires_imagepuzzle,
        requires_mangafoxwatermark: row.capabilities.requires_mangafoxwatermark,
        events: [...row.capabilities.events],
        known_broken_flags: [...row.capabilities.known_broken_flags],
        live_scrape_fallback: row.capabilities.live_scrape_fallback,
      },
      browserProfileEnabled,
    ),
  };
}

/**
 * §5.1 option-value validation against the module's descriptors —
 * checkbox → boolean, edit → string, spinedit → integer, combobox →
 * INTEGER item index within range (the stored value is the index).
 */
export function validateOptionValues(
  descriptors: readonly { name: string; kind: string; items?: readonly string[] }[],
  values: Record<string, OptionValueT>,
): void {
  const byName = new Map(descriptors.map((d) => [d.name, d]));
  for (const [name, value] of Object.entries(values)) {
    const descriptor = byName.get(name);
    if (descriptor === undefined) {
      throw new ApiError(400, 'validation_error', `unknown option: ${name}`);
    }
    if (descriptor.kind === 'checkbox' && typeof value !== 'boolean') {
      throw new ApiError(400, 'validation_error', `option ${name}: checkbox requires a boolean`);
    }
    if (descriptor.kind === 'edit' && typeof value !== 'string') {
      throw new ApiError(400, 'validation_error', `option ${name}: edit requires a string`);
    }
    if (descriptor.kind === 'spinedit' && !(typeof value === 'number' && Number.isInteger(value))) {
      throw new ApiError(400, 'validation_error', `option ${name}: spinedit requires an integer`);
    }
    if (descriptor.kind === 'combobox') {
      const items = descriptor.items ?? [];
      if (!(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < items.length)) {
        throw new ApiError(
          400,
          'validation_error',
          `option ${name}: combobox stores the item INDEX (0..${String(items.length - 1)})`,
          { items },
        );
      }
    }
  }
}

/** In-memory module_state registry store (dev/test stand-in for app.db).
 * Runtime columns (cookies) are kept per module; reads of cookies are
 * the §5.3 state service's boundary, not the registry projection. */
export class InMemoryModuleService implements ModuleService {
  private readonly enabled = new Map<string, boolean>();
  private readonly cookies = new Map<string, string>();
  private readonly proxy = new Map<string, ProxySettingsT | null>();
  /** Wrapped in the constructor: non-catalogable ids always report false. */
  private readonly catalogInstalled: (id: string) => boolean;

  constructor(
    private readonly rows: readonly RegistrationRecord[],
    /** §5.11 flip input (config-driven; default off = known-broken stand). */
    private readonly browserProfileEnabled: boolean = false,
    /**
     * Catalog install-state lookup (CatalogStore receipts join,
     * site-first browse). Evaluated per list()/get() call so a finished
     * provision is reflected on the next /api/modules read without any
     * cache invalidation. Default: nothing installed.
     */
    catalogInstalled: (id: string) => boolean = (): boolean => false,
    /**
     * Site-availability lookup (dead-site discovery): evaluated per
     * list()/get() call so an opportunistic write or a manual Check is
     * reflected on the next /api/modules read. Default: unknown for
     * every site (the seeded, silent state).
     */
    availability: (id: string) => SiteAvailabilityRecord = (): SiteAvailabilityRecord => UNKNOWN_AVAILABILITY,
  ) {
    // Non-32-hex module ids (upstream typos exist — ColorcitoScan.lua
    // ships '5450026642ecrrd48apotd81e57f8e40') can never have an
    // FMD2-DB catalog: guard the join at this single source (production
    // assembly AND every test harness) so a store's path-safety assert
    // can never take down /api/modules with a 500.
    this.catalogInstalled = (id: string): boolean =>
      isValidCatalogId(id) && catalogInstalled(id);
    this.availability = availability;
    for (const row of rows) {
      this.enabled.set(row.id, true);
    }
  }

  private readonly availability: (id: string) => SiteAvailabilityRecord;

  list(): ModuleSummaryT[] {
    return this.rows.map((row) =>
      toSummary(
        row,
        this.enabled.get(row.id) ?? true,
        this.proxy.get(row.id) ?? null,
        this.browserProfileEnabled,
        this.catalogInstalled,
        this.availability,
      ),
    );
  }

  get(id: string): ModuleSummaryT | undefined {
    const row = this.rows.find((r): boolean => r.id === id);
    if (row === undefined) {
      return undefined;
    }
    return toSummary(
      row,
      this.enabled.get(id) ?? true,
      this.proxy.get(id) ?? null,
      this.browserProfileEnabled,
      this.catalogInstalled,
      this.availability,
    );
  }

  update(
    id: string,
    patch: {
      enabled?: boolean;
      options?: Record<string, OptionValueT>;
      cookies?: string;
      proxy?: ProxySettingsT | null;
    },
  ): ModuleSummaryT {
    const row = this.rows.find((r): boolean => r.id === id);
    if (row === undefined) {
      throw new ApiError(404, 'not_found', `unknown module: ${id}`);
    }
    if (patch.options !== undefined) {
      validateOptionValues(row.options, patch.options);
    }
    if (patch.enabled !== undefined) {
      this.enabled.set(id, patch.enabled);
    }
    if (patch.cookies !== undefined) {
      this.cookies.set(id, patch.cookies);
    }
    if (patch.proxy !== undefined) {
      // explicit null = clear the override (inherit the global config)
      this.proxy.set(id, patch.proxy);
    }
    const current = this.get(id);
    if (current === undefined) {
      throw new ApiError(404, 'not_found', `unknown module: ${id}`);
    }
    return current;
  }

  /** §5.3 cookie-jar read seam (settings-text form; tests + future adapter). */
  getCookies(id: string): string | undefined {
    return this.cookies.get(id);
  }

  /** The module's proxy override ('' type cleared → undefined = inherit). */
  getProxyOverride(id: string): ProxySettingsT | null {
    return this.proxy.get(id) ?? null;
  }
}

// ── settings (§9/§10 — global proxy + §5.11 browser profile) ─────────

/**
 * Typed settings seam: the GLOBAL proxy config (SetProxy five-string
 * semantics) and the §5.11 browser sidecar profile state. The engine
 * reads the EFFECTIVE per-module config here (module override → global
 * → none) and seeds the HTTP shim's initial SetProxy state.
 */
export interface SettingsService {
  get(): SettingsResponseT;
  /** Replace the global proxy config (PUT /api/settings/proxy). */
  setProxy(proxy: ProxySettingsT): SettingsResponseT;
  /** Replace the output defaults (PUT /api/settings/output, additive). */
  setOutput(output: OutputDefaultsT): SettingsResponseT;
  /** [parity-sweep] M10: replace the Performance group (PUT /api/settings/performance). */
  setPerformance(performance: PerformanceSettingsT): SettingsResponseT;
  /** [parity-sweep] M2: replace job-history retention (PUT /api/settings/retention). */
  setRetention(retention: RetentionSettingsT): SettingsResponseT;
  /** [parity-sweep] M4: replace the filename policy (PUT /api/settings/filename-policy). */
  setFilenamePolicy(policy: FilenamePolicySettingsT): SettingsResponseT;
  /** [parity-sweep] M13: replace diagnostics settings (PUT /api/settings/diagnostics). */
  setDiagnostics(diagnostics: DiagnosticsSettingsT): SettingsResponseT;
  /** The effective proxy for one module: override → global → undefined. */
  effectiveProxy(moduleId: string): ProxySettingsT | undefined;
  /** §5.11: the compose `browser` profile is wired (flags flip). */
  browserProfileEnabled(): boolean;
  /** Per-module override read seam (engine effective-proxy resolution). */
  moduleProxyOverride(moduleId: string): ProxySettingsT | null;
  /** Favorites scheduler settings (Options → Updates parity). */
  getFavoritesSettings(): FavoriteSchedulerSettingsT;
  /** Replace the favorites scheduler settings (PUT /api/settings/favorites). */
  setFavoritesSettings(settings: FavoriteSchedulerSettingsT): SettingsResponseT;
  /**
   * R4 single app-wide API token: the STORED settings value (null when
   * nothing is stored). The env pin (FMD_WEB_API_TOKEN) hides the
   * stored value entirely — precedence lives in the auth assembly.
   */
  getApiToken(): string | null;
  /**
   * Rotate/persist the stored token (POST /api/settings/api-token/
   * regenerate). The value NEVER travels in GET /api/settings — only
   * the credential-gated token route exposes it.
   */
  setApiToken(token: string): void;
}

export class InMemorySettingsService implements SettingsService {
  private proxy: ProxySettingsT = { type: '', host: '', port: '', user: '', pass: '' };
  // Every field of OutputDefaultsSchema carries a zod default — parse
  // the empty object to build the default (single source; new fields
  // land here automatically).
  private output: OutputDefaultsT = OutputDefaultsSchema.parse({});
  private favorites: FavoriteSchedulerSettingsT = { intervalMinutes: 60, checkAtStartup: true };
  private favoritesSink: ((settings: FavoriteSchedulerSettingsT) => void) | undefined;
  /** [parity-sweep] groups — defaults mirror the pre-settings server truth. */
  private performance: PerformanceSettingsT = {
    requestTimeoutSeconds: 15,
    retryCount: 2,
    parallelChapters: 1,
    threadsPerChapter: 1,
  };
  private retention: RetentionSettingsT = { days: 30 };
  private filenamePolicy: FilenamePolicySettingsT = { normalizePaths: false };
  private diagnostics: DiagnosticsSettingsT = { logEnabled: true, logLevel: 'info' };
  /** R4: the stored single API token (env pin hides it; null = none). */
  private apiToken: string | null = null;
  private apiTokenSink: ((token: string) => void) | undefined;
  /** Live-apply sinks (assembly: app_settings persistence + runtime apply). */
  private performanceSink: ((p: PerformanceSettingsT) => void) | undefined;
  private retentionSink: ((r: RetentionSettingsT) => void) | undefined;
  private filenamePolicySink: ((p: FilenamePolicySettingsT) => void) | undefined;
  private diagnosticsSink: ((d: DiagnosticsSettingsT) => void) | undefined;

  constructor(
    private readonly modules?: { getProxyOverride(id: string): ProxySettingsT | null },
    /** §5.11 config input: non-empty FMD_WEB_BROWSER_SIDECAR_URL. */
    private readonly browserUrl: string = '',
    /**
     * Favorites scheduler settings seed (assembly reads the persisted
     * app_settings row) + the live-apply sink (scheduler interval).
     */
    favoritesSeed?: FavoriteSchedulerSettingsT,
    onFavoritesSettings?: (settings: FavoriteSchedulerSettingsT) => void,
  ) {
    if (favoritesSeed !== undefined) {
      this.favorites = { ...favoritesSeed };
    }
    if (onFavoritesSettings !== undefined) {
      this.favoritesSink = onFavoritesSettings;
    }
  }

  get(): SettingsResponseT {
    return {
      proxy: { ...this.proxy },
      output: { ...this.output },
      favorites: { ...this.favorites },
      performance: { ...this.performance },
      retention: { ...this.retention },
      filenamePolicy: { ...this.filenamePolicy },
      diagnostics: { ...this.diagnostics },
      browser: {
        enabled: this.browserUrl !== '',
        url: this.browserUrl,
      },
    };
  }

  setProxy(proxy: ProxySettingsT): SettingsResponseT {
    this.proxy = { ...proxy };
    return this.get();
  }

  setOutput(output: OutputDefaultsT): SettingsResponseT {
    this.output = { ...output };
    return this.get();
  }
 
  setPerformance(performance: PerformanceSettingsT): SettingsResponseT {
    this.performance = { ...performance };
    this.performanceSink?.(this.performance);
    return this.get();
  }

  setRetention(retention: RetentionSettingsT): SettingsResponseT {
    this.retention = { ...retention };
    this.retentionSink?.(this.retention);
    return this.get();
  }

  setFilenamePolicy(policy: FilenamePolicySettingsT): SettingsResponseT {
    this.filenamePolicy = { ...policy };
    this.filenamePolicySink?.(this.filenamePolicy);
    return this.get();
  }

  setDiagnostics(diagnostics: DiagnosticsSettingsT): SettingsResponseT {
    this.diagnostics = { ...diagnostics };
    this.diagnosticsSink?.(this.diagnostics);
    return this.get();
  }

  /** [parity-sweep] read seams (assembly: lane knobs, retention sweep, logger). */
  performanceSettings(): PerformanceSettingsT {
    return { ...this.performance };
  }

  retentionSettings(): RetentionSettingsT {
    return { ...this.retention };
  }

  filenamePolicySettings(): FilenamePolicySettingsT {
    return { ...this.filenamePolicy };
  }

  diagnosticsSettings(): DiagnosticsSettingsT {
    return { ...this.diagnostics };
  }

  /**
   * Assembly seam: the persisted app_settings seeds + the live-apply
   * sinks land here after construction (the store exists later). The
   * seeds do NOT fire the sinks (they already reflect persisted state).
   */
  setParitySweepSettingsLive(
    seeds: {
      performance?: PerformanceSettingsT;
      retention?: RetentionSettingsT;
      filenamePolicy?: FilenamePolicySettingsT;
      diagnostics?: DiagnosticsSettingsT;
      output?: OutputDefaultsT;
    },
    sinks?: {
      onPerformance?: (p: PerformanceSettingsT) => void;
      onRetention?: (r: RetentionSettingsT) => void;
      onFilenamePolicy?: (p: FilenamePolicySettingsT) => void;
      onDiagnostics?: (d: DiagnosticsSettingsT) => void;
      onOutput?: (o: OutputDefaultsT) => void;
    },
  ): void {
    if (seeds.performance !== undefined) {
      this.performance = { ...seeds.performance };
    }
    if (seeds.retention !== undefined) {
      this.retention = { ...seeds.retention };
    }
    if (seeds.filenamePolicy !== undefined) {
      this.filenamePolicy = { ...seeds.filenamePolicy };
    }
    if (seeds.diagnostics !== undefined) {
      this.diagnostics = { ...seeds.diagnostics };
    }
    if (seeds.output !== undefined) {
      this.output = { ...seeds.output };
    }
    if (sinks?.onPerformance !== undefined) {
      this.performanceSink = sinks.onPerformance;
    }
    if (sinks?.onRetention !== undefined) {
      this.retentionSink = sinks.onRetention;
    }
    if (sinks?.onFilenamePolicy !== undefined) {
      this.filenamePolicySink = sinks.onFilenamePolicy;
    }
    if (sinks?.onDiagnostics !== undefined) {
      this.diagnosticsSink = sinks.onDiagnostics;
    }
  }

  getFavoritesSettings(): FavoriteSchedulerSettingsT {
    return { ...this.favorites };
  }

  setFavoritesSettings(settings: FavoriteSchedulerSettingsT): SettingsResponseT {
    this.favorites = { ...settings };
    this.favoritesSink?.(settings);
    return this.get();
  }

  /**
   * Assembly seam: the settings instance is constructed BEFORE the
   * favorites scheduler exists, so the persisted seed + the live-apply
   * sink (app_settings write + scheduler interval) land here after the
   * fact. The seed does NOT fire the sink (it already reflects state).
   */
  setFavoritesSettingsLive(
    seed: FavoriteSchedulerSettingsT,
    sink?: (settings: FavoriteSchedulerSettingsT) => void,
  ): void {
    this.favorites = { ...seed };
    this.favoritesSink = sink;
  }

  // ── R4 single app-wide API token (storage; env pin hides it) ──────

  getApiToken(): string | null {
    return this.apiToken;
  }

  setApiToken(token: string): void {
    this.apiToken = token;
    this.apiTokenSink?.(token);
  }

  /**
   * Assembly seam (like the favorites one): the persisted seed (the
   * app_settings `api.token` row) + the write-back sink land after the
   * settings instance exists. Seeding does NOT fire the sink (the row
   * already reflects it); every later rotation does.
   */
  bindApiTokenPersistence(seed: string | null, sink?: (token: string) => void): void {
    this.apiToken = seed;
    this.apiTokenSink = sink;
  }

  /** Output defaults read seam (download lane pack/filename resolution). */
  outputDefaults(): OutputDefaultsT {
    return { ...this.output };
  }

  effectiveProxy(moduleId: string): ProxySettingsT | undefined {
    const override = this.moduleProxyOverride(moduleId);
    if (override !== null) {
      return override.type === '' ? undefined : override;
    }
    return this.proxy.type === '' ? undefined : { ...this.proxy };
  }

  browserProfileEnabled(): boolean {
    return this.browserUrl !== '';
  }

  moduleProxyOverride(moduleId: string): ProxySettingsT | null {
    return this.modules?.getProxyOverride(moduleId) ?? null;
  }
}

// ── catalogs ─────────────────────────────────────────────────────────

/**
 * The catalog routes delegate to the contract's `CatalogStore` boundary
 * (§6.4–§6.6) verbatim — cursor contents are the store's business; the
 * API passes them through opaquely.
 */
export type CatalogService = CatalogStore;

// ── live info ────────────────────────────────────────────────────────

/**
 * [parity-sweep] M14 (FMD2 edURL parity): resolve a module by the
 * URL's host against the registry's RootURL hosts (case-insensitive;
 * port ignored — FMD2 matches origins the same loose way).
 *
 * Returns the module id, or a typed ambiguity/miss report the route
 * maps onto ApiError('no_site_match'|'ambiguous_site').
 */
export function resolveModuleByHost(
  modules: ReadonlyArray<{ id: string; name?: string; rootURL: string }>,
  url: string,
): { moduleId: string } | { noMatch: true } | { ambiguous: true; candidates: readonly string[] } {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { noMatch: true };
  }
  if (host === '') {
    return { noMatch: true };
  }
  const matches = modules.filter((module): boolean => {
    try {
      return new URL(module.rootURL).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  });
  const single = matches.length === 1 ? matches[0] : undefined;
  if (single !== undefined) {
    return { moduleId: single.id };
  }
  if (matches.length > 1) {
    return { ambiguous: true, candidates: matches.map((m): string => m.name ?? m.id) };
  }
  return { noMatch: true };
}

/**
 * The §5.8 GetInfo result now LIVES in @fmd/contract (engine-boundary
 * story: the engine-side module-info service produces it, the API
 * serializes it — a genuine cross-boundary domain shape). Re-exported
 * here so existing api-layer imports stay untouched.
 */
export type { NormalizedInfo } from '@fmd/contract';

/** GetInfo + §5.8 normalization boundary (engine-backed in production). */
export interface InfoService {
  getInfo(moduleId: string, url: string): Promise<NormalizedInfo>;
}

/** Response cache for POST /api/info (§10 "cached"): TTL keyed by
 * sha256(moduleId + '\n' + url). Values are immutable snapshots. */
export class InfoResponseCache {
  private readonly entries = new Map<string, { value: NormalizedInfo; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  key(moduleId: string, url: string): string {
    return createHash('sha256').update(`${moduleId}\n${url}`).digest('hex');
  }

  get(key: string, now: number): NormalizedInfo | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) {
      return undefined;
    }
    if (now >= hit.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: NormalizedInfo, now: number): void {
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}

// ── jobs ─────────────────────────────────────────────────────────────

export interface JobRecord {
  id: string;
  type: 'download';
  moduleId: string;
  payload: Record<string, unknown>;
  state: 'queued' | 'running' | 'retry' | 'done' | 'failed' | 'cancelled';
  priority: number;
  progress?: Record<string, unknown>;
  error?: string;
  idempotencyKey?: string;
  /** Add-as-stopped hold (cbAddAsStopped parity): queued but not claimable. */
  paused?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobCreateInput {
  moduleId: string;
  mangaUrl: string;
  mangaTitle?: string;
  chapterLink: string;
  chapterName?: string;
  /** §7.2 favorites provenance (per-chapter completion dual-writes the favorite side). */
  mangaKey?: string;
  /** Add-as-stopped hold: the lane skips the row until resumed. */
  paused?: boolean;
  /** Save-to directory override honored at library finalize. */
  saveTo?: string;
}

export interface JobsPage {
  jobs: JobRecord[];
  nextCursor?: string;
}

/**
 * Jobs-list filter set (Downloads parity): the pre-existing single
 * `state`, plus the web multi-select (`states`), the title/chapter
 * substring (`q`) and the created-at window (`addedFrom`/`addedTo`,
 * inclusive calendar days parsed as UTC). R5 arrival adds `since` —
 * an ISO-timestamp floor on the row's last transition (`updatedAt`),
 * the finished-since source for the away summary.
 */
export interface JobsListOptions {
  readonly state?: JobRecord['state'];
  readonly states?: readonly JobStateT[];
  readonly q?: string;
  readonly addedFrom?: string;
  readonly addedTo?: string;
  readonly since?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface JobService {
  /** Create a download job; `idempotencyKey` replays per §10. */
  createDownload(input: JobCreateInput, idempotencyKey?: string): { job: JobRecord; replayed: boolean };
  get(id: string): JobRecord | undefined;
  /** Newest-first page with a keyset cursor (stable under inserts). */
  list(opts: JobsListOptions): JobsPage;
  /** §7.1 user cancellation (queued/running/retry → cancelled; terminal → 409). */
  cancel(id: string): JobRecord;
  /** Lift the add-as-stopped hold (cbAddAsStopped parity): queued+paused → claimable. */
  resume(id: string): JobRecord;
  /**
   * Downloads parity (FMD2 pmDownload, web-adapted): apply one task
   * action under the state matrix — illegal applications 409 with
   * `{job, action}` details.
   */
  action(id: string, type: JobActionTypeT): JobRecord;
  /**
   * Delete one job row (any state); `data: true` also removes the
   * finalized artifact when the job recorded one.
   */
  remove(id: string, opts?: { readonly data?: boolean }): { job: JobRecord; dataDeleted: boolean };
  /**
   * Toolbar bulk op (FMD2 tsDownload): pause/resume over scope `all`,
   * delete over scope `completed` (STATUS_FINISH rows only). Idempotent
   * — a settled queue affects 0 rows.
   */
  bulkAction(request: JobBulkActionRequestT): JobBulkActionResponseT;
}

/** Canonical JSON (sorted keys, recursive) — the idempotency fingerprint input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]): number => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function payloadFingerprint(input: JobCreateInput): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/**
 * In-memory job queue store (dev/test stand-in for app.db `job`,
 * §9): numeric monotonic ids (SQLite rowid analog), keyset cursors on
 * the id, and the §10 idempotency table (key → fingerprint + job).
 */
export class InMemoryJobService implements JobService {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly idempotency = new Map<string, { fingerprint: string; jobId: string }>();
  /** In-flight cancel hooks (the real executor registers one per running job). */
  private readonly cancelHooks = new Map<string, () => void>();
  private nextId = 1;

  constructor(
    /** Delete(+data) seam — the harness wires a fake artifact remover. */
    private readonly artifactDeleter: (path: string) => boolean = (): boolean => false,
  ) {}

  /** Register the in-flight cancel hook for one running job id. */
  addCancelHook(id: string, cancel: () => void): void {
    this.cancelHooks.set(id, cancel);
  }

  /**
   * Test seam (harness): force a row's state (+progress, +createdAt —
   * the date-window filter tests backdate rows) — the in-memory analog
   * of the SQLite lane's transitions. Production code never calls
   * this; states arrive via create/cancel/action.
   */
  forceState(
    id: string,
    state: JobRecord['state'],
    progress?: Record<string, unknown>,
    createdAt?: string,
  ): JobRecord {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    const next: JobRecord = {
      ...job,
      state,
      ...(progress !== undefined ? { progress } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(id, next);
    return next;
  }

  removeCancelHook(id: string): void {
    this.cancelHooks.delete(id);
  }

  /** §7.1 user cancellation: queued/running/retry → cancelled; terminal 409. */
  cancel(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') {
      throw new ApiError(409, 'conflict', `job ${id} is ${job.state} — nothing to cancel`);
    }
    this.cancelHooks.get(id)?.();
    const cancelled: JobRecord = { ...job, state: 'cancelled', updatedAt: new Date().toISOString() };
    this.jobs.set(id, cancelled);
    return cancelled;
  }

  createDownload(input: JobCreateInput, idempotencyKey?: string): { job: JobRecord; replayed: boolean } {
    if (idempotencyKey !== undefined) {
      const existing = this.idempotency.get(idempotencyKey);
      if (existing !== undefined) {
        const fingerprint = payloadFingerprint(input);
        if (fingerprint !== existing.fingerprint) {
          throw new ApiError(
            409,
            'conflict',
            `idempotency key ${JSON.stringify(idempotencyKey)} was already used with a different payload`,
          );
        }
        const job = this.jobs.get(existing.jobId);
        if (job !== undefined) {
          return { job, replayed: true };
        }
      }
    }
    const now = new Date().toISOString();
    const id = String(this.nextId);
    this.nextId += 1;
    const job: JobRecord = {
      id,
      type: 'download',
      moduleId: input.moduleId,
      payload: {
        moduleId: input.moduleId,
        mangaUrl: input.mangaUrl,
        ...(input.mangaTitle !== undefined ? { mangaTitle: input.mangaTitle } : {}),
        chapterLink: input.chapterLink,
        ...(input.chapterName !== undefined ? { chapterName: input.chapterName } : {}),
        ...(input.saveTo !== undefined ? { saveTo: input.saveTo } : {}),
      },
      state: 'queued',
      priority: 0,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(input.paused === true ? { paused: true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, { fingerprint: payloadFingerprint(input), jobId: id });
    }
    return { job, replayed: false };
  }

  /** cbAddAsStopped parity: clear the hold on a live row; terminal 409. */
  resume(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') {
      throw new ApiError(409, 'conflict', `job ${id} is ${job.state} — nothing to resume`);
    }
    if (job.paused !== true) {
      return job; // idempotent no-op: the hold is already lifted
    }
    const { paused: _lifted, ...rest } = job;
    void _lifted;
    const resumed: JobRecord = { ...rest, updatedAt: new Date().toISOString() };
    this.jobs.set(id, resumed);
    return resumed;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(opts: JobsListOptions): JobsPage {
    // Keyset cursor on the monotonic id (newest first): the boundary is
    // "ids strictly below the last row of the previous page", so pages
    // never shift under concurrent inserts — new jobs have higher ids
    // and can only appear on page 1 of a fresh listing.
    let boundaryId = Number.MAX_SAFE_INTEGER;
    if (opts.cursor !== undefined) {
      const decoded = decodeCursor(opts.cursor);
      const raw = decoded['id'];
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        throw new ApiError(400, 'bad_request', 'invalid jobs cursor');
      }
      boundaryId = raw;
    }
    // Downloads-parity filters — same semantics as the runtime service
    // (states multi-select, title/chapter substring, created-at window).
    const needle = opts.q !== undefined && opts.q !== '' ? opts.q.toLowerCase() : undefined;
    const fromMs =
      opts.addedFrom !== undefined ? Date.parse(`${opts.addedFrom}T00:00:00.000Z`) : undefined;
    const toMs =
      opts.addedTo !== undefined ? Date.parse(`${opts.addedTo}T23:59:59.999Z`) : undefined;
    // R5 arrival: last-transition floor (with state=done this is the
    // "finished since" set — updatedAt IS the done timestamp).
    const sinceMs = opts.since !== undefined ? Date.parse(opts.since) : undefined;
    const all = [...this.jobs.values()]
      .filter((j) => Number(j.id) < boundaryId)
      .filter((j) => opts.state === undefined || j.state === opts.state)
      .filter((j) => opts.states === undefined || opts.states.includes(j.state))
      .filter((j): boolean => {
        if (needle === undefined) {
          return true;
        }
        const title = typeof j.payload['mangaTitle'] === 'string' ? j.payload['mangaTitle'] : '';
        const chapter = typeof j.payload['chapterName'] === 'string' ? j.payload['chapterName'] : '';
        return title.toLowerCase().includes(needle) || chapter.toLowerCase().includes(needle);
      })
      .filter((j): boolean => {
        if (fromMs === undefined && toMs === undefined) {
          return true;
        }
        const created = Date.parse(j.createdAt);
        if (Number.isNaN(created)) {
          return false;
        }
        return (fromMs === undefined || created >= fromMs) && (toMs === undefined || created <= toMs);
      })
      .filter((j): boolean => {
        if (sinceMs === undefined) {
          return true;
        }
        const updated = Date.parse(j.updatedAt);
        if (Number.isNaN(updated)) {
          return false;
        }
        return updated >= sinceMs;
      })
      .sort((a, b): number => Number(b.id) - Number(a.id));
    const page = all.slice(0, opts.limit);
    const last = page.at(-1);
    if (page.length < all.length && last !== undefined) {
      return { jobs: page, nextCursor: encodeCursor({ id: Number(last.id) }) };
    }
    return { jobs: page };
  }

  /** Downloads parity: the FMD2 pmDownload action matrix (see the
   * runtime service for the table — this in-memory twin keeps the API
   * harness on the SAME legality surface). */
  action(id: string, type: JobActionTypeT): JobRecord {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    const illegal = (): ApiError =>
      new ApiError(
        409,
        'conflict',
        `cannot ${type} job ${id} in state ${job.state}${job.paused === true ? ' (held)' : ''}`,
        { job: { id, state: job.state, paused: job.paused === true }, action: type },
      );
    switch (type) {
      case 'pause':
      case 'disable': {
        if (job.state === 'queued') {
          if (job.paused === true) {
            return job;
          }
          const held: JobRecord = { ...job, paused: true, updatedAt: new Date().toISOString() };
          this.jobs.set(id, held);
          return held;
        }
        if (type === 'pause' && (job.state === 'running' || job.state === 'retry')) {
          return this.cancel(id);
        }
        throw illegal();
      }
      case 'resume':
      case 'enable': {
        if (job.state === 'queued') {
          return this.resume(id);
        }
        if (type === 'resume' && job.state === 'cancelled') {
          return this.reenqueue(job).job;
        }
        throw illegal();
      }
      case 'retry': {
        if (job.state === 'failed') {
          return this.reenqueue(job).job;
        }
        throw illegal();
      }
      case 'redownload': {
        if (job.state === 'done') {
          return this.reenqueue(job).job;
        }
        throw illegal();
      }
    }
  }

  /**
   * Fresh queued copy of a terminal row (the chained re-enqueue
   * analog). Chain-aware like the runtime `<key>#<n>` probe: a
   * terminal row that was ALREADY re-enqueued replays its fresh row
   * (`replayed: true`) — bulk resume-all counts only fresh ones, so a
   * settled queue reports affected: 0.
   */
  private reenqueue(job: JobRecord): { job: JobRecord; replayed: boolean } {
    const existingId = this.resumeChain.get(job.id);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId);
      if (existing !== undefined && existing.state !== 'done' && existing.state !== 'failed' && existing.state !== 'cancelled') {
        return { job: existing, replayed: true }; // the live re-enqueue
      }
    }
    const now = new Date().toISOString();
    const { error: _error, progress: _progress, paused: _paused, ...rest } = job;
    void _error;
    void _progress;
    void _paused;
    const fresh: JobRecord = {
      ...rest,
      id: String(this.nextId),
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    this.nextId += 1;
    this.jobs.set(fresh.id, fresh);
    this.resumeChain.set(job.id, fresh.id);
    return { job: fresh, replayed: false };
  }

  /** original id → live re-enqueued row (the chain probe double). */
  private readonly resumeChain = new Map<string, string>();

  remove(id: string, opts: { readonly data?: boolean } = {}): { job: JobRecord; dataDeleted: boolean } {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    let dataDeleted = false;
    if (opts.data === true) {
      const path =
        job.progress !== undefined && typeof job.progress['libraryPath'] === 'string'
          ? (job.progress['libraryPath'] as string)
          : '';
      if (path !== '') {
        dataDeleted = this.artifactDeleter(path);
      }
    }
    this.jobs.delete(id);
    return { job, dataDeleted };
  }

  bulkAction(request: JobBulkActionRequestT): JobBulkActionResponseT {
    const { action, scope } = request;
    if ((action === 'pause' || action === 'resume') && scope !== 'all') {
      throw new ApiError(400, 'bad_request', `scope "${scope}" does not apply to bulk ${action} — use "all"`);
    }
    if (action === 'delete' && scope !== 'completed') {
      throw new ApiError(400, 'bad_request', `scope "${scope}" does not apply to bulk delete — use "completed"`);
    }
    const rows = [...this.jobs.values()].sort((a, b): number => Number(b.id) - Number(a.id));
    const touched: JobRecord[] = [];
    for (const job of rows) {
      if (action === 'pause') {
        if (job.state === 'queued' && job.paused !== true) {
          touched.push(this.action(job.id, 'disable'));
        } else if (job.state === 'running' || job.state === 'retry') {
          touched.push(this.action(job.id, 'pause'));
        }
      } else if (action === 'resume') {
        if (job.state === 'queued' && job.paused === true) {
          touched.push(this.action(job.id, 'enable'));
        } else if (job.state === 'cancelled') {
          // Chain-aware like the runtime bulk: only FRESH re-enqueues
          // count — a replayed live successor is a no-op (idempotence).
          const successorId = this.resumeChain.get(job.id);
          const successor = successorId !== undefined ? this.jobs.get(successorId) : undefined;
          const replayed =
            successor !== undefined &&
            successor.state !== 'done' &&
            successor.state !== 'failed' &&
            successor.state !== 'cancelled';
          if (!replayed) {
            touched.push(this.action(job.id, 'resume'));
          }
        }
      } else if (job.state === 'done') {
        this.remove(job.id);
        touched.push(job);
      }
    }
    return { action, scope, affected: touched.length, jobs: touched };
  }

  get size(): number {
    return this.jobs.size;
  }
}

// ── library (§7.1 listing/download surface) ──────────────────────────

/** One finalized chapter artifact in the library (§9 `library_files`). */
export interface LibraryFileRecord {
  id: string;
  moduleId: string;
  /** Sanitized manga segment (`library/<module>/<manga>/<file>`). */
  manga: string;
  /** File name inside its manga dir (base name only). */
  fileName: string;
  bytes: number;
  createdAt: string;
}

export interface LibraryPage {
  files: LibraryFileRecord[];
  nextCursor?: string;
}

/** The library listing/download port (routes never touch the fs). */
export interface LibraryService {
  list(opts: { cursor?: string; limit: number }): LibraryPage;
  get(id: string): LibraryFileRecord | undefined;
  /** Absolute path of the artifact (the route streams it); undefined = gone. */
  resolveFile(id: string): string | undefined;
  /**
   * The downloaded-chapter LINK set for one manga (the §9
   * `downloaded_chapters` ledger read behind POST /api/info's embedded
   * `downloaded` array — MangaPage tinting/hide-downloaded parity).
   */
  downloadedChapters(moduleId: string, url: string): string[];
  /**
   * [UX-AUDIT L-2] remove one library artifact: the row AND the file
   * on disk. Returns false when the id is unknown (the route 404s).
   */
  remove(id: string): boolean;
}

/** In-memory library store (dev/test stand-in for `library_files`). */
export class InMemoryLibraryService implements LibraryService {
  private readonly rows = new Map<string, LibraryFileRecord & { path: string }>();
  private nextId = 1;
  /** Test/dev seam: the downloaded_chapters ledger double (per manga key). */
  private readonly downloaded = new Map<string, string[]>();

  /** Seed the ledger double (test harness hook for /api/info embedding). */
  setDownloadedChapters(moduleId: string, url: string, links: readonly string[]): void {
    this.downloaded.set(downloadedChaptersKey(moduleId, url), [...links]);
  }

  downloadedChapters(moduleId: string, url: string): string[] {
    return [...(this.downloaded.get(downloadedChaptersKey(moduleId, url)) ?? [])];
  }

  remove(id: string): boolean {
    // Same safety contract as deleteLibraryFileByPath: remove the
    // artifact only when it is still a regular file on disk.
    const row = this.rows.get(id);
    if (row === undefined) {
      return false;
    }
    try {
      if (statSync(row.path).isFile()) {
        rmSync(row.path);
      }
    } catch {
      // Missing/unreachable file — the row removal still stands.
    }
    return this.rows.delete(id);
  }

  /** Insert-or-replace by absolute path (a re-download swaps the entry). */
  put(entry: { moduleId: string; manga: string; fileName: string; bytes: number; path: string; createdAt?: string }): LibraryFileRecord {
    const existing = [...this.rows.values()].find((row): boolean => row.path === entry.path);
    const createdAt = entry.createdAt ?? new Date().toISOString();
    if (existing !== undefined) {
      const updated: LibraryFileRecord & { path: string } = {
        id: existing.id,
        moduleId: entry.moduleId,
        manga: entry.manga,
        fileName: entry.fileName,
        bytes: entry.bytes,
        createdAt,
        path: entry.path,
      };
      this.rows.set(existing.id, updated);
      return this.toRecord(updated);
    }
    const id = String(this.nextId);
    this.nextId += 1;
    this.rows.set(id, { id, moduleId: entry.moduleId, manga: entry.manga, fileName: entry.fileName, bytes: entry.bytes, createdAt, path: entry.path });
    return this.toRecord(this.rows.get(id) as LibraryFileRecord & { path: string });
  }

  list(opts: { cursor?: string; limit: number }): LibraryPage {
    let boundaryId = Number.MAX_SAFE_INTEGER;
    if (opts.cursor !== undefined) {
      const decoded = decodeCursor(opts.cursor);
      const raw = decoded['id'];
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        throw new ApiError(400, 'bad_request', 'invalid library cursor');
      }
      boundaryId = raw;
    }
    const all = [...this.rows.values()]
      .filter((row): boolean => Number(row.id) < boundaryId)
      .sort((a, b): number => Number(b.id) - Number(a.id));
    const page = all.slice(0, opts.limit);
    const last = page.at(-1);
    if (page.length < all.length && last !== undefined) {
      return { files: page.map((row): LibraryFileRecord => this.toRecord(row)), nextCursor: encodeCursor({ id: Number(last.id) }) };
    }
    return { files: page.map((row): LibraryFileRecord => this.toRecord(row)) };
  }

  get(id: string): LibraryFileRecord | undefined {
    const row = this.rows.get(id);
    return row === undefined ? undefined : this.toRecord(row);
  }

  resolveFile(id: string): string | undefined {
    const row = this.rows.get(id);
    if (row === undefined || !existsSync(row.path)) {
      return undefined;
    }
    return row.path;
  }

  private toRecord(row: LibraryFileRecord & { path: string }): LibraryFileRecord {
    return {
      id: row.id,
      moduleId: row.moduleId,
      manga: row.manga,
      fileName: row.fileName,
      bytes: row.bytes,
      createdAt: row.createdAt,
    };
  }
}

// ── sync ─────────────────────────────────────────────────────────────

/** Shape of the §2 lua/ sync outcome the route returns (SweepSummary projection). */
export interface SyncModulesOutcome {
  summary: {
    treeSha: string;
    totalFiles: number;
    registeredFiles: number;
    failedFiles: number;
    totalModules: number;
    failures: readonly { file: string; error: string }[];
    knownBroken: Readonly<Record<string, readonly string[]>>;
    eventCoverage: Readonly<Record<string, number>>;
  };
}

/** Shape of one §6.2–§6.3 catalog sync outcome. */
export interface CatalogSyncOutcome {
  id: string;
  state: 'unchanged' | 'updated' | 'failed';
  dbSha?: string;
  bytes?: number;
  error?: string;
}

/**
 * Fine-grained catalog provision phases surfaced to the sync-port
 * caller (the WS-publishing decorator streams them as `sync` frames —
 * site-first browse progress toast).
 */
export type CatalogSyncPhaseCb = (phase: 'downloading' | 'extracting' | 'installing') => void;

export interface SyncService {
  syncModules(): Promise<SyncModulesOutcome>;
  /**
   * Provision/sync one catalog. `onProgress` is optional and purely
   * observative (WS streaming); implementors that cannot report phases
   * simply never invoke it.
   */
  syncCatalog(id: string, onProgress?: CatalogSyncPhaseCb): Promise<CatalogSyncOutcome>;
  syncAllCatalogs(): Promise<readonly CatalogSyncOutcome[]>;
}

/**
 * Stable error prefix marking "FMD2-DB has no prebuilt catalog for this
 * site" (HTTP 404 — CatalogBlobMissingError) — distinct from transient
 * network failures. The site-first browse taxonomy keys on it.
 */
export const NO_CATALOG_ERROR_PREFIX = 'no-catalog:';

/** Map a CatalogSyncOutcome onto the WS terminal outcome taxonomy. */
export function catalogSyncOutcomeToTerminal(
  outcome: CatalogSyncOutcome,
): 'updated' | 'unchanged' | 'failed' | 'no-catalog' {
  if (outcome.state === 'failed') {
    return outcome.error !== undefined && outcome.error.startsWith(NO_CATALOG_ERROR_PREFIX)
      ? 'no-catalog'
      : 'failed';
  }
  return outcome.state;
}

/**
 * Site-first browse decorator: streams one catalog provision as WS
 * `sync` frames on the §10 hub — `checking` at entry, the service's
 * fine-grained phases verbatim, and a terminal frame whose `outcome`
 * follows the no-catalog/transient taxonomy. REST responses are passed
 * through UNCHANGED (the sync API contract does not move; the frames
 * are additive WS surface keyed `catalog-sync:<moduleId>`).
 */
export class WsPublishingSyncService implements SyncService {
  constructor(
    private readonly inner: SyncService,
    private readonly publish: (sync: CatalogSyncProgressT) => void,
  ) {}

  syncModules(): Promise<SyncModulesOutcome> {
    return this.inner.syncModules();
  }

  syncCatalog(id: string, onProgress?: CatalogSyncPhaseCb): Promise<CatalogSyncOutcome> {
    const jobId: string = catalogSyncJobId(id);
    const emit = (phase: CatalogSyncPhaseT): void => {
      this.publish({ jobId, moduleId: id, phase });
    };
    const emitDetail = (phase: CatalogSyncPhaseT, detail: string): void => {
      this.publish({ jobId, moduleId: id, phase, detail });
    };
    emit('checking');
    return this.inner
      .syncCatalog(
        id,
        onProgress === undefined
          ? (phase): void => {
              emit(phase);
            }
          : (phase): void => {
              emit(phase);
              onProgress(phase);
            },
      )
      .then((outcome): CatalogSyncOutcome => {
        this.publish({
          jobId,
          moduleId: id,
          phase: 'done',
          outcome: catalogSyncOutcomeToTerminal(outcome),
          ...(outcome.error !== undefined ? { detail: outcome.error } : {}),
        });
        return outcome;
      })
      .catch((err: unknown): CatalogSyncOutcome => {
        const detail: string = err instanceof Error ? err.message : String(err);
        emitDetail('failed', detail);
        throw err;
      });
  }

  syncAllCatalogs(): Promise<readonly CatalogSyncOutcome[]> {
    return this.inner.syncAllCatalogs();
  }
}

/** Scripted sync service for dev/tests (production wires the real syncers). */
export class FakeSyncService implements SyncService {
  constructor(
    private readonly modulesResult: SyncModulesOutcome = {
      summary: {
        treeSha: 'f'.repeat(64),
        totalFiles: 1,
        registeredFiles: 1,
        failedFiles: 0,
        totalModules: 1,
        failures: [],
        knownBroken: {},
        eventCoverage: {},
      },
    },
    private readonly knownCatalogIds: readonly string[] = [],
    private readonly catalogResults: Readonly<Record<string, CatalogSyncOutcome>> = {},
  ) {}

  async syncModules(): Promise<SyncModulesOutcome> {
    return this.modulesResult;
  }

  async syncCatalog(id: string): Promise<CatalogSyncOutcome> {
    if (!this.knownCatalogIds.includes(id)) {
      throw new ApiError(404, 'not_found', `unknown catalog: ${id}`);
    }
    const result = this.catalogResults[id];
    if (result !== undefined) {
      return result;
    }
    return { id, state: 'unchanged' };
  }

  async syncAllCatalogs(): Promise<readonly CatalogSyncOutcome[]> {
    return this.knownCatalogIds.map((id) => this.catalogResults[id] ?? { id, state: 'unchanged' });
  }
}

// ── favorites (§7.2 DoCheck engine + scheduler) ──────────────────────

/**
 * The §10 favorites seam: CRUD + the auto-download toggle + the manual
 * check-now trigger. The production adapter (`SqliteFavoritesService`)
 * drives the §7.2 engine over the app.db store; the in-memory double is
 * the API-test/dev stand-in (check-now behavior injectable).
 */
export interface FavoriteService {
  list(): FavoriteT[];
  get(id: string): FavoriteT | undefined;
  /** Create a favorite (default `autoDownload: false` — FMD2 default). */
  create(input: FavoriteCreateRequestT): Promise<FavoriteT>;
  /** Patch title / auto-download / save-to / enable. */
  update(id: string, patch: FavoriteUpdateRequestT): FavoriteT;
  /** Delete a favorite (its downloaded_chapters row is NOT touched). */
  remove(id: string): void;
  /** Manual check-now: the immediate DoCheck cycle for one favorite. */
  checkNow(id: string): Promise<FavoriteCheckResponseT>;
  /**
   * Batch check (btFavoritesCheckNewChapter parity): every favorite in
   * scope gets one DoCheck cycle, sequentially; a {@link cancelBatch}
   * between rows stops the sweep (the response reports `cancelled`).
   * A run already in flight is a typed 409.
   */
  checkBatch(scope: FavoriteCheckScopeT): Promise<FavoriteCheckBatchResponseT>;
  /** Cancel the in-flight batch check (false when none is running). */
  cancelBatch(): boolean;
  /**
   * Transfer mapping preview (frmTransferFavorites parity): resolve the
   * favorite's title on the target site (catalog search) and dry-run
   * GetInfo on the hit — the dialog's valid/invalid report.
   */
  transferPreview(id: string, targetModuleId: string): Promise<FavoriteTransferPreviewResponseT>;
  /**
   * Apply the website transfer: remap the favorite onto the target
   * module+link (new id), optionally clearing the downloaded list and
   * re-ingesting it from the live target-site chapter list.
   */
  transfer(
    id: string,
    target: { moduleId: string; url: string; clearDownloadedList: boolean },
  ): Promise<{ favorite: FavoriteT; reloadedFromServer: boolean }>;
  /**
   * D4 import path: the tag-100 transfer-favorite bulk-ingest. The
   * optional `seed` switches to the FMD2 favorites.db offline import
   * (MD_ImportToFavorites parity — no live fetch; file fields seed the
   * row, the ledger text merges into downloaded_chapters). Returns the
   * favorite plus the idempotency verdict for the import report.
   */
  import(
    input: FavoriteCreateRequestT & {
      seed?: {
        status?: string;
        currentChapter?: number | null;
        downloadedChapterList?: string;
        enabled?: boolean;
        dateAdded?: number;
        ledgerChapters?: string;
      };
    },
  ): Promise<{ favorite: FavoriteT; importOutcome: 'created' | 'updated' | 'unchanged' }>;
}

/** Create-check behavior for the in-memory double: what a fresh
 * favorite's first check reports (newChapterCount/currentChapter). */
export interface InMemoryFavoriteCheckBehavior {
  readonly currentChapter?: number;
  readonly newChapterCount?: number;
  readonly status?: string;
  readonly queuedDownloads?: number;
  readonly newChapters?: FavoriteCheckResponseT['newChapters'];
}

/** Wire-shape favorite equality (in-memory import verdict). */
function favoriteWireEqual(a: FavoriteT | undefined, b: FavoriteT | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.id === b.id &&
    a.moduleId === b.moduleId &&
    a.url === b.url &&
    a.title === b.title &&
    a.status === b.status &&
    a.currentChapter === b.currentChapter &&
    a.newChapterCount === b.newChapterCount &&
    a.autoDownload === b.autoDownload &&
    a.lastCheck === b.lastCheck &&
    a.lastUpdated === b.lastUpdated &&
    a.saveTo === b.saveTo &&
    a.enabled === b.enabled &&
    a.dateAdded === b.dateAdded
  );
}

/**
 * In-memory favorites store (dev/test stand-in for app.db `favorite`).
 * CRUD is live immediately; `checkNow`/`import` delegate to the
 * injected behavior (default: counts stay as-is, nothing queued), so
 * route tests stay fully offline.
 */
export class InMemoryFavoriteService implements FavoriteService {
  private readonly rows = new Map<string, FavoriteT>();
  private order: string[] = [];
  private counter = 0;
  private batchCancelRequested = false;
  private batchRunning = false;

  public constructor(
    private readonly checkBehavior: (id: string) => InMemoryFavoriteCheckBehavior = (): InMemoryFavoriteCheckBehavior => ({}),
    /**
     * Transfer-mapping stand-in (the production adapter searches the
     * target catalog + dry-runs GetInfo): resolves a target-site title
     * match, a reason-bearing miss (`no-catalog` / `get-info-failed`,
     * mirroring the engine taxonomy), or undefined (`not-found`).
     * Default: nothing resolves (invalid preview).
     */
    private readonly transferIndex: (
      moduleId: string,
      title: string,
    ) => { url: string; title: string } | { reason: 'no-catalog' | 'get-info-failed' } | undefined =
      (): undefined => undefined,
  ) {}

  list(): FavoriteT[] {
    return this.order.map((id) => this.rows.get(id) as FavoriteT);
  }

  get(id: string): FavoriteT | undefined {
    return this.rows.get(id);
  }

  async create(input: FavoriteCreateRequestT): Promise<FavoriteT> {
    const id = `${input.moduleId}${input.url}`.toLowerCase();
    if (this.rows.has(id)) {
      throw new ApiError(409, 'conflict', `favorite already exists: ${id}`);
    }
    const behavior = this.checkBehavior(id);
    const favorite: FavoriteT = {
      id,
      moduleId: input.moduleId,
      url: input.url,
      title: input.title ?? null,
      status: behavior.status ?? null,
      currentChapter: behavior.currentChapter ?? null,
      newChapterCount: behavior.newChapterCount ?? 0,
      autoDownload: input.autoDownload ?? false,
      lastCheck: '2026-01-01T00:00:00Z',
      lastUpdated: null,
      saveTo: null,
      enabled: true,
      dateAdded: '2026-01-01T00:00:00Z',
      coverLink: null,
    };
    this.rows.set(id, favorite);
    this.order.push(id);
    return favorite;
  }

  update(id: string, patch: FavoriteUpdateRequestT): FavoriteT {
    const favorite = this.rows.get(id);
    if (favorite === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    const updated: FavoriteT = {
      ...favorite,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.autoDownload !== undefined ? { autoDownload: patch.autoDownload } : {}),
      ...(patch.saveTo !== undefined ? { saveTo: patch.saveTo } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    };
    this.rows.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    if (!this.rows.delete(id)) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    this.order = this.order.filter((key) => key !== id);
  }

  async checkNow(id: string): Promise<FavoriteCheckResponseT> {
    const favorite = this.rows.get(id);
    if (favorite === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    const behavior = this.checkBehavior(id);
    const updated: FavoriteT = {
      ...favorite,
      ...(behavior.currentChapter !== undefined ? { currentChapter: behavior.currentChapter } : {}),
      ...(behavior.newChapterCount !== undefined ? { newChapterCount: behavior.newChapterCount } : {}),
      ...(behavior.status !== undefined ? { status: behavior.status } : {}),
    };
    this.rows.set(id, updated);
    return {
      favorite: updated,
      queuedDownloads: behavior.queuedDownloads ?? 0,
      newChapters: behavior.newChapters ?? [],
    };
  }

  async import(
    input: FavoriteCreateRequestT & {
      seed?: {
        status?: string;
        currentChapter?: number | null;
        downloadedChapterList?: string;
        enabled?: boolean;
        dateAdded?: number;
        ledgerChapters?: string;
      };
    },
  ): Promise<{ favorite: FavoriteT; importOutcome: 'created' | 'updated' | 'unchanged' }> {
    this.counter += 1;
    void this.counter;
    // Idempotent seed semantics (both entry modes): the row is built
    // DIRECTLY — seeds apply on create AND on re-import; a pre-existing
    // key upserts (never a 409) and the verdict compares before/after.
    const id = `${input.moduleId}${input.url}`.toLowerCase();
    const before = this.rows.get(id);
    const behavior = this.checkBehavior(id);
    const seed = input.seed;
    const favorite: FavoriteT = {
      // Existing row keeps its shape (dates, saveTo…); file values win
      // where present (MD_ImportToFavorites parity).
      ...(before ?? {
        title: null,
        status: behavior.status ?? null,
        currentChapter: behavior.currentChapter ?? null,
        newChapterCount: behavior.newChapterCount ?? 0,
        autoDownload: false,
        lastCheck: '2026-01-01T00:00:00Z',
        lastUpdated: null,
        saveTo: null,
        enabled: true,
        dateAdded: '2026-01-01T00:00:00Z',
        coverLink: null,
      }),
      id,
      moduleId: input.moduleId,
      url: input.url,
      ...(input.title !== undefined && input.title !== '' ? { title: input.title } : {}),
      autoDownload: input.autoDownload ?? before?.autoDownload ?? false,
      ...(seed !== undefined
        ? {
            ...(seed.status !== '' ? { status: seed.status } : {}),
            ...(seed.currentChapter !== null && seed.currentChapter !== undefined
              ? { currentChapter: seed.currentChapter }
              : {}),
            ...(seed.enabled !== undefined ? { enabled: seed.enabled } : {}),
          }
        : {}),
    };
    this.rows.set(id, favorite);
    if (before === undefined) {
      this.order.push(id);
    }
    const importOutcome: 'created' | 'updated' | 'unchanged' =
      before === undefined ? 'created' : favoriteWireEqual(before, favorite) ? 'unchanged' : 'updated';
    return { favorite, importOutcome };
  }

  async checkBatch(scope: FavoriteCheckScopeT): Promise<FavoriteCheckBatchResponseT> {
    if (this.batchRunning) {
      throw new ApiError(409, 'conflict', 'a favorites check batch is already running');
    }
    this.batchRunning = true;
    this.batchCancelRequested = false;
    try {
      const results: FavoriteCheckBatchItemT[] = [];
      let checked = 0;
      const failed = 0;
      let queuedDownloads = 0;
      let cancelled = false;
      for (const id of [...this.order]) {
        if (this.batchCancelRequested) {
          cancelled = true;
          break;
        }
        const favorite = this.rows.get(id);
        if (favorite === undefined) {
          continue;
        }
        if (scope === 'enabled' && favorite.enabled !== true) {
          continue;
        }
        if (scope === 'disabled' && favorite.enabled === true) {
          continue;
        }
        // The in-memory double reuses checkNow (behavior-injectable).
        const result = await this.checkNow(id);
        checked += 1;
        queuedDownloads += result.queuedDownloads;
        results.push({
          favorite: result.favorite,
          status: 'checked',
          newChapters: result.newChapters,
          queuedDownloads: result.queuedDownloads,
        });
      }
      return { scope, cancelled, checked, failed, queuedDownloads, results };
    } finally {
      this.batchRunning = false;
      this.batchCancelRequested = false;
    }
  }

  cancelBatch(): boolean {
    if (!this.batchRunning) {
      return false;
    }
    this.batchCancelRequested = true;
    return true;
  }

  async transferPreview(id: string, targetModuleId: string): Promise<FavoriteTransferPreviewResponseT> {
    const favorite = this.rows.get(id);
    if (favorite === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    const title = favorite.title ?? '';
    const hit = title === '' ? undefined : this.transferIndex(targetModuleId, title);
    if (hit === undefined) {
      return { targetModuleId, valid: false, targetUrl: null, matchedTitle: null, reason: 'not-found' };
    }
    if (!('url' in hit)) {
      return { targetModuleId, valid: false, targetUrl: null, matchedTitle: null, reason: hit.reason };
    }
    return { targetModuleId, valid: true, targetUrl: hit.url, matchedTitle: hit.title };
  }

  async transfer(
    id: string,
    target: { moduleId: string; url: string; clearDownloadedList: boolean },
  ): Promise<{ favorite: FavoriteT; reloadedFromServer: boolean }> {
    const favorite = this.rows.get(id);
    if (favorite === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    const nextId = `${target.moduleId}${target.url}`.toLowerCase();
    const moved: FavoriteT = {
      ...favorite,
      id: nextId,
      moduleId: target.moduleId,
      url: target.url,
      newChapterCount: 0,
    };
    this.rows.delete(id);
    this.order = this.order.map((key): string => (key === id ? nextId : key));
    this.rows.set(nextId, moved);
    return { favorite: moved, reloadedFromServer: target.clearDownloadedList };
  }
}
