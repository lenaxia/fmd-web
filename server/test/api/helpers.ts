/**
 * §10 API integration-test harness (offline — fastify.inject only, no
 * sockets): fixture module registrations, an in-memory CatalogStore
 * double with contract-exact pagination semantics, a counting fake
 * info service, and the real in-memory job service (idempotency +
 * keyset cursors exercised through the API).
 */
import { expect } from 'vitest';
import type {
  CatalogEntry,
  CatalogMeta,
  CatalogPage,
  CatalogSearchQuery,
  CatalogStore,
  ModuleId,
} from '@fmd/contract';
import type { FastifyInstance } from 'fastify';
import type { RegistrationRecord } from '../../src/engine/registry/capabilities.js';
import { encodeCursor } from '../../src/api/cursor.js';
import { dateToJdn } from '../../src/sync/db/jdn.js';
import { buildApp } from '../../src/api/app.js';
import type { AppOptions } from '../../src/api/app.js';
import type { AuthConfig } from '../../src/api/auth.js';
import {
  InMemoryFavoriteService,
  InMemoryJobService,
  InMemoryLibraryService,
  InMemoryModuleService,
  type NormalizedInfo,
  type SyncService,
} from '../../src/api/services.js';
import { InMemorySettingsService } from '../../src/api/services.js';
import { InMemoryAccountService } from '../../src/accounts/account-service.js';
import { ApiError } from '../../src/api/errors.js';

export const MODULE_A_ID = 'a'.repeat(32);
export const MODULE_B_ID = 'b'.repeat(32);
export const CATALOG_ID = 'c'.repeat(32);
export const UNKNOWN_CATALOG_ID = 'f'.repeat(32);

/** Combobox INDEX semantics fixture (§5.1): items listed, index stored. */
const OPTIONS_A: RegistrationRecord['options'] = [
  { name: 'UseMobile', kind: 'checkbox', defaultValue: false },
  { name: 'StartDate', kind: 'edit', defaultValue: '' },
  { name: 'Delay', kind: 'spinedit', defaultValue: 0 },
  { name: 'Language', kind: 'combobox', defaultValue: 0, items: ['en', 'ja', 'zh'] },
];

const OPTIONS_B: RegistrationRecord['options'] = [
  { name: 'SortOrder', kind: 'combobox', defaultValue: 1, items: ['latest', 'oldest'] },
];

export function makeRegistration(
  overrides: Partial<RegistrationRecord> & { id: string },
): RegistrationRecord {
  return {
    name: `Module ${overrides.id.slice(0, 4)}`,
    rootURL: 'https://example.org',
    category: 'Manga',
    accountSupport: false,
    options: OPTIONS_A,
    file: `${overrides.id.slice(0, 4)}.lua`,
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: ['GetInfo'],
      known_broken_flags: [],
      // Shared-harness repair for the in-flight live-scrape contract
      // change (capabilities.ts now requires the flag).
      live_scrape_fallback: false,
    },
    ...overrides,
  };
}

/** §5.10 flip fixture: carries the D3 known-broken flags the §5.11 profile satisfies. */
export const MODULE_C_ID = 'c'.repeat(32);

export function defaultRegistrations(): RegistrationRecord[] {
  return [
    makeRegistration({ id: MODULE_A_ID, name: 'AlphaSource' }),
    makeRegistration({ id: MODULE_B_ID, name: 'BetaSource', options: OPTIONS_B }),
    makeRegistration({
      id: MODULE_C_ID,
      name: 'GammaBrowserSite',
      capabilities: {
        requires_subprocess: true,
        requires_browser: true,
        bypass_python_gated: true,
        requires_imagepuzzle: false,
        requires_mangafoxwatermark: false,
        events: ['GetInfo'],
        known_broken_flags: ['fmd.subprocess', 'madara.run_html_load', 'webdriver.bypass'],
        live_scrape_fallback: false,
      },
    }),
  ];
}

/** Catalog fixtures (§6, DBDataProcess columns via the contract entry). */
export function catalogFixtures(): CatalogEntry[] {
  return [
    { link: 'https://ex.org/1', title: 'Alpha', alttitles: '', authors: 'A', artists: '', genres: 'Action, Drama', status: 'Ongoing', summary: 'first story', numChapter: 3, jdn: 45000 },
    { link: 'https://ex.org/2', title: 'Beta', alttitles: '', authors: 'B', artists: '', genres: 'Comedy', status: 'Completed', summary: 'second story', numChapter: 12, jdn: 45100 },
    { link: 'https://ex.org/3', title: 'Alpha Returns', alttitles: '', authors: 'A', artists: 'X', genres: 'Action', status: 'Ongoing', summary: 'third story', numChapter: 7, jdn: 45200 },
    { link: 'https://ex.org/4', title: 'Gamma', alttitles: '', authors: 'C', artists: '', genres: 'Drama', status: 'Hiatus', summary: 'fourth story', numChapter: 0, jdn: 44900 },
    { link: 'https://ex.org/5', title: 'Delta', alttitles: '', authors: 'D', artists: '', genres: 'Action', status: 'Ongoing', summary: 'fifth story', numChapter: 42, jdn: 45300 },
  ];
}

/**
 * In-memory CatalogStore double — the same pagination semantics as the
 * read-side store (§6.4–§6.6): offset pages for browse (catalogs are
 * read-only after install — no concurrent inserts exist), query-bound
 * opaque cursors for FTS search.
 */
export class InMemoryCatalogStore implements CatalogStore {
  private readonly entries = new Map<ModuleId, CatalogEntry[]>();
  private readonly metas = new Map<ModuleId, CatalogMeta>();

  constructor(entries: CatalogEntry[] = [], catalogIds: readonly ModuleId[] = []) {
    for (const id of catalogIds) {
      this.install(id, entries);
    }
  }

  install(id: ModuleId, entries: CatalogEntry[]): void {
    this.entries.set(id, [...entries]);
    const meta: CatalogMeta = { id, dbSha: '9'.repeat(64), fetchedAt: '2026-01-01T00:00:00Z', bytes: 1024 };
    this.metas.set(id, meta);
  }

  getMeta(catalogId: ModuleId): CatalogMeta | undefined {
    return this.metas.get(catalogId);
  }

  private static paginate(ordered: readonly CatalogEntry[], query: { page?: number; limit?: number }): CatalogPage {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
    const offset = (Math.max(query.page ?? 1, 1) - 1) * limit;
    const slice = ordered.slice(offset, offset + limit + 1);
    const hasMore = slice.length > limit;
    return {
      entries: hasMore ? slice.slice(0, limit) : slice,
      total: ordered.length,
    };
  }

  latest(catalogId: ModuleId, query: { page?: number; limit?: number } = {}): CatalogPage {
    const entries = this.entries.get(catalogId) ?? [];
    const ordered = [...entries].sort((a, b): number => b.jdn - a.jdn || (a.link < b.link ? -1 : 1));
    return InMemoryCatalogStore.paginate(ordered, query);
  }

  byTitle(catalogId: ModuleId, query: { page?: number; limit?: number } = {}): CatalogPage {
    const entries = this.entries.get(catalogId) ?? [];
    const ordered = [...entries].sort((a, b): number => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    return InMemoryCatalogStore.paginate(ordered, query);
  }

  search(catalogId: ModuleId, query: CatalogSearchQuery): CatalogPage {
    const entries = this.entries.get(catalogId) ?? [];
    const match = (query.query ?? '').trim().toLowerCase();
    const terms = match.split(/\s+/).filter((t) => t !== '');
    const genre = query.genre?.toLowerCase() ?? '';
    const status = query.status ?? '';
    const authors = query.authors?.toLowerCase() ?? '';
    const artists = query.artists?.toLowerCase() ?? '';
    const summary = query.summary?.toLowerCase() ?? '';
    const genres = query.genres ?? [];
    const genresExclude = query.genresExclude ?? [];
    const genresMode = query.genresMode ?? 'all';
    const newDays = query.newDays;
    let offset = 0;
    if (query.cursor !== undefined) {
      let decoded: { q?: string; g?: string; o?: number; st?: string; a?: string; ar?: string; sm?: string; gs?: string; ge?: string; gm?: string; nd?: number };
      try {
        decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as typeof decoded;
      } catch {
        // Mirror the real store: malformed cursors are a cursor-class error.
        throw new Error('malformed cursor');
      }
      if (decoded.q !== undefined && decoded.q !== match) {
        throw new Error('cursor does not match the issued query');
      }
      if (decoded.g !== undefined && decoded.g !== genre) {
        throw new Error('cursor does not match the issued genre filter');
      }
      if ((decoded.st ?? '') !== status) {
        throw new Error('cursor does not match the issued status filter');
      }
      if ((decoded.a ?? '') !== authors) {
        throw new Error('cursor does not match the issued authors filter');
      }
      if ((decoded.ar ?? '') !== artists) {
        throw new Error('cursor does not match the issued artists filter');
      }
      if ((decoded.sm ?? '') !== summary) {
        throw new Error('cursor does not match the issued summary filter');
      }
      const genresKey = genres.length > 0 ? genres.join('\x1f') : '';
      if ((decoded.gs ?? '') !== genresKey || (decoded.gm ?? 'all') !== genresMode) {
        throw new Error('cursor does not match the issued genre filters');
      }
      if ((decoded.ge ?? '') !== (genresExclude.length > 0 ? genresExclude.join('\x1f') : '')) {
        throw new Error('cursor does not match the issued genre filters');
      }
      if ((decoded.nd ?? undefined) !== newDays) {
        throw new Error('cursor does not match the issued only-new window');
      }
      if (typeof decoded.o !== 'number' || !Number.isInteger(decoded.o) || decoded.o < 0) {
        throw new Error('malformed cursor');
      }
      offset = decoded.o;
    } else {
      // Real-store parity (decodeSearchCursor): no cursor → offset from
      // the 1-based `page` number. The union search reads per-site
      // windows through exactly these semantics.
      offset = (Math.max(1, Math.trunc(query.page ?? 1)) - 1) * Math.min(Math.max(query.limit ?? 20, 1), 200);
    }
    // Today's JDN (UTC) — mirrors the store's only-new anchor.
    const now = new Date();
    const jdnNow = dateToJdn({
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
    });
    const newThreshold = newDays === undefined ? undefined : jdnNow - newDays;
    const filtered = entries.filter((entry) => {
      const haystack = `${entry.title} ${entry.alttitles} ${entry.summary}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) {
        return false;
      }
      if (status !== '' && entry.status !== status) {
        return false;
      }
      if (authors !== '' && !entry.authors.toLowerCase().includes(authors)) {
        return false;
      }
      if (artists !== '' && !entry.artists.toLowerCase().includes(artists)) {
        return false;
      }
      if (summary !== '' && !entry.summary.toLowerCase().includes(summary)) {
        return false;
      }
      // genres ANY → OR of contains, ALL → AND (FMD2 rbAny/rbAll).
      if (genres.length > 0) {
        const lowered = entry.genres.toLowerCase();
        const matches = genres.map((g): boolean => lowered.includes(g.toLowerCase()));
        const hit = genresMode === 'any' ? matches.some(Boolean) : matches.every(Boolean);
        if (!hit) {
          return false;
        }
      }
      // `!` excludes: AND of NOT-contains (audit (b)2 — SQL NOT LIKE parity).
      const loweredAll = entry.genres.toLowerCase();
      if (genresExclude.some((g): boolean => loweredAll.includes(g.toLowerCase()))) {
        return false;
      }
      if (newThreshold !== undefined && entry.jdn <= newThreshold) {
        return false;
      }
      return genre === '' || entry.genres.toLowerCase().includes(genre);
    });
    const ordered = [...filtered].sort((a, b): number => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
    const slice = ordered.slice(offset, offset + limit + 1);
    const hasMore = slice.length > limit;
    const base: CatalogPage = {
      entries: hasMore ? slice.slice(0, limit) : slice,
      total: ordered.length,
    };
    if (!hasMore) {
      return base;
    }
    return {
      ...base,
      nextCursor: encodeCursor({
        q: match,
        ...(genre !== '' ? { g: genre } : {}),
        ...(status !== '' ? { st: status } : {}),
        ...(authors !== '' ? { a: authors } : {}),
        ...(artists !== '' ? { ar: artists } : {}),
        ...(summary !== '' ? { sm: summary } : {}),
        ...(genres.length > 0 ? { gs: genres.join('\x1f'), gm: genresMode } : {}),
        ...(genresExclude.length > 0 ? { ge: genresExclude.join('\x1f') } : {}),
        ...(newDays !== undefined ? { nd: newDays } : {}),
        o: offset + limit,
      }),
    };
  }
}

/** Counting fake GetInfo service (§5.8 output fixture). */
export class FakeInfoService {
  readonly calls: Array<{ moduleId: string; url: string }> = [];
  private readonly known: ReadonlySet<string>;

  constructor(knownModules: readonly string[]) {
    this.known = new Set(knownModules);
  }

  async getInfo(moduleId: string, url: string): Promise<NormalizedInfo> {
    await Promise.resolve();
    this.calls.push({ moduleId, url });
    // Unknown modules are a TYPED seam error (404); engine-level failures
    // stay plain errors (→ 502 upstream_error at the route).
    if (!this.known.has(moduleId)) {
      throw new ApiError(404, 'not_found', `unknown module: ${moduleId}`);
    }
    return {
      title: 'Fixture Manga',
      altTitles: 'Fixtured',
      authors: 'Author',
      artists: 'Artist',
      genres: 'Action',
      status: 'Ongoing',
      summary: 'Summary',
      coverLink: 'https://img.example/cover.png',
      url,
      link: 'https://ex.org/manga/fixture',
      chapterLinks: ['https://ex.org/ch/1', 'https://ex.org/ch/2'],
      chapterNames: ['Ch. 1', 'Ch. 2'],
      numChapter: 2,
    };
  }
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly modules: InMemoryModuleService;
  readonly jobs: InMemoryJobService;
  readonly catalogs: InMemoryCatalogStore | import('../../src/sync/db/catalog-store.js').CatalogFileStore;
  readonly info: FakeInfoService;
  readonly sync: SyncService;
  readonly library: InMemoryLibraryService;
  readonly favorites: import('../../src/api/services.js').FavoriteService;
  readonly accounts: import('../../src/accounts/account-service.js').AccountService;
  /** The settings service (R4 token storage tests rotate through it). */
  readonly settings: import('../../src/api/services.js').InMemorySettingsService;
}

/** In-memory accounts double builder (route tests). */
export function makeInMemoryAccounts(
  loginBehavior?: import('../../src/accounts/account-service.js').InMemoryLoginBehavior,
): import('../../src/accounts/account-service.js').InMemoryAccountService {
  return new InMemoryAccountService(loginBehavior);
}

// Re-exported so account route tests can build the double without a
// second import path.
export { InMemoryAccountService } from '../../src/accounts/account-service.js';

export const TEST_VERSION = '0.1.0-test';

function makeSyncService(catalogId: string): SyncService {
  const service: SyncService = {
    syncModules: async () => ({
      summary: {
        treeSha: 'ab12'.repeat(16),
        totalFiles: 3,
        registeredFiles: 2,
        failedFiles: 1,
        totalModules: 4,
        failures: [{ file: 'Broken.lua', error: 'syntax' }],
        knownBroken: { 'madara.run_html_load': ['BetaSource'] },
        eventCoverage: { GetInfo: 4 },
      },
    }),
    syncCatalog: async (id: string) => {
      if (id !== catalogId) {
        throw new ApiError(404, 'not_found', `unknown catalog: ${id}`);
      }
      return { id, state: 'updated', dbSha: 'cd34'.repeat(16), bytes: 4096 };
    },
    syncAllCatalogs: async () => [{ id: catalogId, state: 'unchanged' }],
  };
  return service;
}

/** Build the §10 app with fakes (offline). `auth` omitted → open. */
export function buildHarness(
  opts: {
    auth?: AuthConfig;
    infoTtlMs?: number;
    sync?: SyncService;
    info?: FakeInfoService;
    readiness?: () => { ready: boolean; reason?: string };
    /** §10/D19: attach this hub to the app's server (`/ws` upgrades). */
    wsHub?: import('../../src/api/ws/hub.js').WsHub;
    /** §7.2 favorites service override (default: in-memory, no-op checks). */
    favorites?: import('../../src/api/services.js').FavoriteService;
    /** §8.6/D4 accounts service override (default: in-memory, no-op login). */
    accounts?: import('../../src/accounts/account-service.js').AccountService;
    /** §5.11 config flip: the compose `browser` profile is active. */
    browserProfile?: boolean;
    /** Extra registration rows appended to the default set (e.g. malformed
     *  upstream ids for the catalogInstalled join regression). */
    extraRegistrations?: import('../../src/engine/registry/capabilities.js').RegistrationRecord[];
    /** Real catalog store override (default: in-memory double). When set,
     * the site-first join exercises the REAL path-safety assert chain. */
    catalogStore?: import('../../src/sync/db/catalog-store.js').CatalogFileStore;
    /** R4: settings service override (token rotation tests drive it). */
    settings?: import('../../src/api/services.js').InMemorySettingsService;
    /** §4/§15: metrics registry (auth-label request counters). */
    metrics?: import('../../src/observability/metrics.js').FmdMetrics;
    /** R4: audit sink (token regeneration assertions). */
    onAudit?: (event: import('../../src/api/app.js').SettingsAuditEvent) => void;
    /** Downloads parity: job service override (action-matrix tests wire
     * an artifact deleter through it). */
    jobs?: import('../../src/api/services.js').InMemoryJobService;
    /** [file-state] library service override (the clamp tests wire the
     * REAL SqliteLibraryService over a temp root). */
    library?: import('../../src/api/services.js').LibraryService;
    /** [file-state] the file-state seam (title-files/rescan routes +
     * library filter enrichment; absent keeps the pre-shape). */
    fileState?: import('../../src/runtime/library-file-state.js').SqliteLibraryFileStateService;
    /** Webhook story: the test-send notifier seam (absent → the
     * POST /api/settings/webhook/test route is not mounted). */
    webhookTestSend?: import('../../src/api/app.js').ApiServices['webhookTestSend'];
  } = {},
): Harness {
  const jobs = opts.jobs ?? new InMemoryJobService();
  // The handle stays the in-memory double (its put/setDownloadedChapters
  // test seams); a REAL override wires into buildApp only.
  const library = new InMemoryLibraryService();
  const wiredLibrary = opts.library ?? library;
  const favorites = opts.favorites ?? new InMemoryFavoriteService();
  const accounts = opts.accounts ?? new InMemoryAccountService();
  const catalogs = opts.catalogStore ?? new InMemoryCatalogStore(catalogFixtures(), [CATALOG_ID]);
  const info = opts.info ?? new FakeInfoService([MODULE_A_ID, MODULE_B_ID]);
  const sync = opts.sync ?? makeSyncService(CATALOG_ID);
  const options: AppOptions = {
    version: TEST_VERSION,
    ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
    ...(opts.infoTtlMs !== undefined ? { infoCacheTtlMs: opts.infoTtlMs } : {}),
    ...(opts.wsHub !== undefined ? { wsHub: opts.wsHub } : {}),
    ...(opts.metrics !== undefined ? { metrics: opts.metrics } : {}),
    ...(opts.onAudit !== undefined ? { onAudit: opts.onAudit } : {}),
  };
  const modules = new InMemoryModuleService(
    [...defaultRegistrations(), ...(opts.extraRegistrations ?? [])],
    opts.browserProfile === true,
    // Site-first browse join: catalogInstalled read LIVE from the
    // CatalogStore double (installed fixtures flip the chip).
    (id: string): boolean => catalogs.getMeta(id) !== undefined,
  );
  const settings =
    opts.settings ??
    new InMemorySettingsService(
      modules,
      opts.browserProfile === true ? 'http://127.0.0.1:8191' : '',
    );
  const app = buildApp(
    {
      modules,
      settings,
      accounts,
      catalogs,
      info,
      jobs,
      sync,
      library: wiredLibrary,
      favorites,
      ...(opts.fileState !== undefined ? { fileState: opts.fileState } : {}),
      ...(opts.webhookTestSend !== undefined ? { webhookTestSend: opts.webhookTestSend } : {}),
      ...(opts.readiness !== undefined ? { readiness: opts.readiness } : {}),
    },
    options,
  );
  return { app, modules, jobs, catalogs, info, sync, library, favorites, accounts, settings };
}


/** Narrow to the default in-memory catalog double — fails loudly when a
 *  test that mutates catalog fixtures runs against a real-store harness. */
export function inMemoryCatalogs(h: Harness): InMemoryCatalogStore {
  if (!(h.catalogs instanceof InMemoryCatalogStore)) {
    throw new Error('test requires the default in-memory catalog store');
  }
  return h.catalogs;
}

/** Assert a body IS the typed error envelope (shape + code). */
export function expectEnvelope(
  body: unknown,
  code: string,
): { code: string; message: string; details?: unknown } {
  const parsed: unknown = typeof body === 'string' ? (JSON.parse(body) as unknown) : body;
  const envelope = parsed as { error?: { code?: string; message?: string } };
  expect(envelope.error).toBeDefined();
  expect(envelope.error?.code).toBe(code);
  expect(typeof envelope.error?.message).toBe('string');
  return envelope.error as { code: string; message: string; details?: unknown };
}
