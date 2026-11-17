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
import { existsSync } from 'node:fs';
import type { RegistrationRecord } from '../engine/registry/capabilities.js';
import type { CatalogStore, CatalogSyncProgressT, CatalogSyncPhaseT } from '@fmd/contract';
import { catalogSyncJobId } from '@fmd/contract';
import type {
  FavoriteCheckResponseT,
  FavoriteCreateRequestT,
  FavoriteT,
  FavoriteUpdateRequestT,
} from './schemas.js';
import type {
  ModuleCapabilitiesT,
  ModuleSummaryT,
  OptionValueT,
  ProxySettingsT,
  SettingsResponseT,
} from './schemas.js';
import { ApiError } from './errors.js';
import { decodeCursor, encodeCursor } from './cursor.js';

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
    private readonly catalogInstalled: (id: string) => boolean = (): boolean => false,
  ) {
    for (const row of rows) {
      this.enabled.set(row.id, true);
    }
  }

  list(): ModuleSummaryT[] {
    return this.rows.map((row) =>
      toSummary(
        row,
        this.enabled.get(row.id) ?? true,
        this.proxy.get(row.id) ?? null,
        this.browserProfileEnabled,
        this.catalogInstalled,
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
  /** The effective proxy for one module: override → global → undefined. */
  effectiveProxy(moduleId: string): ProxySettingsT | undefined;
  /** §5.11: the compose `browser` profile is wired (flags flip). */
  browserProfileEnabled(): boolean;
  /** Per-module override read seam (engine effective-proxy resolution). */
  moduleProxyOverride(moduleId: string): ProxySettingsT | null;
}

export class InMemorySettingsService implements SettingsService {
  private proxy: ProxySettingsT = { type: '', host: '', port: '', user: '', pass: '' };

  constructor(
    private readonly modules?: { getProxyOverride(id: string): ProxySettingsT | null },
    /** §5.11 config input: non-empty FMD_WEB_BROWSER_SIDECAR_URL. */
    private readonly browserUrl: string = '',
  ) {}

  get(): SettingsResponseT {
    return {
      proxy: { ...this.proxy },
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

export interface NormalizedInfo {
  title: string;
  altTitles: string;
  authors: string;
  artists: string;
  genres: string;
  status: string;
  summary: string;
  coverLink: string;
  url: string;
  link: string;
  chapterLinks: string[];
  chapterNames: string[];
  numChapter: number;
}

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
}

export interface JobsPage {
  jobs: JobRecord[];
  nextCursor?: string;
}

export interface JobService {
  /** Create a download job; `idempotencyKey` replays per §10. */
  createDownload(input: JobCreateInput, idempotencyKey?: string): { job: JobRecord; replayed: boolean };
  get(id: string): JobRecord | undefined;
  /** Newest-first page with a keyset cursor (stable under inserts). */
  list(opts: { state?: JobRecord['state']; cursor?: string; limit: number }): JobsPage;
  /** §7.1 user cancellation (queued/running/retry → cancelled; terminal → 409). */
  cancel(id: string): JobRecord;
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

  /** Register the in-flight cancel hook for one running job id. */
  addCancelHook(id: string, cancel: () => void): void {
    this.cancelHooks.set(id, cancel);
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
      },
      state: 'queued',
      priority: 0,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, { fingerprint: payloadFingerprint(input), jobId: id });
    }
    return { job, replayed: false };
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(opts: { state?: JobRecord['state']; cursor?: string; limit: number }): JobsPage {
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
    const all = [...this.jobs.values()]
      .filter((j) => Number(j.id) < boundaryId)
      .filter((j) => opts.state === undefined || j.state === opts.state)
      .sort((a, b): number => Number(b.id) - Number(a.id));
    const page = all.slice(0, opts.limit);
    const last = page.at(-1);
    if (page.length < all.length && last !== undefined) {
      return { jobs: page, nextCursor: encodeCursor({ id: Number(last.id) }) };
    }
    return { jobs: page };
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
}

/** In-memory library store (dev/test stand-in for `library_files`). */
export class InMemoryLibraryService implements LibraryService {
  private readonly rows = new Map<string, LibraryFileRecord & { path: string }>();
  private nextId = 1;

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
  /** Patch title / the auto-download toggle. */
  update(id: string, patch: FavoriteUpdateRequestT): FavoriteT;
  /** Delete a favorite (its downloaded_chapters row is NOT touched). */
  remove(id: string): void;
  /** Manual check-now: the immediate DoCheck cycle for one favorite. */
  checkNow(id: string): Promise<FavoriteCheckResponseT>;
  /** D4 import path: the tag-100 transfer-favorite bulk-ingest. */
  import(input: FavoriteCreateRequestT): Promise<FavoriteT>;
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

  public constructor(
    private readonly checkBehavior: (id: string) => InMemoryFavoriteCheckBehavior = (): InMemoryFavoriteCheckBehavior => ({}),
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

  async import(input: FavoriteCreateRequestT): Promise<FavoriteT> {
    this.counter += 1;
    void this.counter;
    return this.create(input);
  }
}
