/**
 * GET /api/search — SCOPE tests ([fuzzy-javelin-pearls], D1 §2 ENTER)
 * over the offline fastify.inject harness:
 *
 * - scope=all (default): unchanged union + the scope echo
 * - scope=preferred: the persisted allowlist filters participation,
 *   facets render in CANONICAL allowlist order, excluded covers only
 *   the scoped catalog-less sites; absent service → typed 400
 * - sites= (the specific multi-select): the tightest scope — wins over
 *   scope=preferred, orders facets by pick order, unknown registry ids
 *   are a typed 400 naming them, known-but-disabled picks are invisible
 * - cursor binding includes the scope (a cursor issued under one scope
 *   reused under another → 400)
 * - ZERO-NETWORK proof for the all-sites default: with global fetch
 *   STUBBED TO THROW and a §6.8 fallback double that throws if
 *   touched, the union still answers from the local index and the
 *   catalog-less site NEVER triggers a live path
 * - short-TTL cache: an identical repeat query is served WITHOUT
 *   re-fanning the per-site stores (a counting store double proves
 *   it); TTL expiry semantics are unit-pinned in search-cache.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CatalogEntry, CatalogStore } from '@fmd/contract';
import type { RegistrationRecord } from '../../src/engine/registry/capabilities.js';
import { buildApp } from '../../src/api/app.js';
import {
  InMemoryFavoriteService,
  InMemoryJobService,
  InMemoryLibraryService,
  InMemoryModuleService,
  InMemorySettingsService,
} from '../../src/api/services.js';
import {
  InMemoryCatalogStore,
  FakeInfoService,
  TEST_VERSION,
  makeRegistration,
} from './helpers.js';
import { InMemoryPreferredSitesService } from '../../src/runtime/preferred-sites.js';

const SITE_A = '1'.repeat(32);
const SITE_B = '2'.repeat(32);
const SITE_C = '3'.repeat(32); // enabled, NO catalog (live candidate shape)

function registrations(): RegistrationRecord[] {
  return [
    makeRegistration({ id: SITE_A, name: 'SiteA Manga' }),
    makeRegistration({ id: SITE_B, name: 'SiteB Manga' }),
    makeRegistration({ id: SITE_C, name: 'SiteC NoCatalog' }),
  ];
}

function entry(link: string, title: string, jdn: number): CatalogEntry {
  return {
    link,
    title,
    alttitles: '',
    authors: 'A',
    artists: '',
    genres: 'Action',
    status: 'Ongoing',
    summary: '',
    numChapter: 1,
    jdn,
  };
}

function siteAEntries(): CatalogEntry[] {
  return [entry('/a/alpha', 'Alpha Legend', 45001), entry('/a/common', 'Common Title', 45101)];
}

function siteBEntries(): CatalogEntry[] {
  return [entry('/b/common', 'Common Title', 45102), entry('/b/beta', 'Beta Saga', 45002)];
}

/** A counting pass-through over the in-memory store (cache proofs). */
class CountingCatalogStore implements CatalogStore {
  public searchCalls = 0;
  public constructor(private readonly inner: InMemoryCatalogStore) {}
  getMeta(catalogId: string) {
    return this.inner.getMeta(catalogId);
  }
  latest(catalogId: string, query?: { page?: number; limit?: number }) {
    return this.inner.latest(catalogId, query);
  }
  byTitle(catalogId: string, query?: { page?: number; limit?: number }) {
    return this.inner.byTitle(catalogId, query);
  }
  search(catalogId: string, query: Parameters<InMemoryCatalogStore['search']>[1]) {
    this.searchCalls += 1;
    return this.inner.search(catalogId, query);
  }
}

interface ScopeHarness {
  readonly app: FastifyInstance;
  readonly preferred: InMemoryPreferredSitesService;
  readonly store: CountingCatalogStore;
  readonly withPreferredService: boolean;
}

function buildScopeHarness(options?: {
  readonly preferred?: readonly string[];
  readonly mountPreferred?: boolean;
}): ScopeHarness {
  const inner = new InMemoryCatalogStore();
  inner.install(SITE_A, siteAEntries());
  inner.install(SITE_B, siteBEntries());
  const store = new CountingCatalogStore(inner);
  const modules = new InMemoryModuleService(
    registrations(),
    false,
    (id) => store.getMeta(id) !== undefined,
  );
  const preferred = new InMemoryPreferredSitesService();
  if ((options?.preferred ?? []).length > 0) {
    preferred.set(options?.preferred ?? []);
  }
  const mountPreferred = options?.mountPreferred !== false;
  const app = buildApp(
    {
      modules,
      settings: new InMemorySettingsService(modules),
      catalogs: store,
      info: new FakeInfoService([SITE_A, SITE_B]),
      jobs: new InMemoryJobService(),
      sync: {
        syncModules: async () => {
          throw new Error('not used');
        },
        syncCatalog: async () => {
          throw new Error('not used');
        },
        syncAllCatalogs: async () => [],
      },
      library: new InMemoryLibraryService(),
      favorites: new InMemoryFavoriteService(),
      ...(mountPreferred ? { preferredSites: preferred } : {}),
    },
    { version: TEST_VERSION },
  );
  return { app, preferred, store, withPreferredService: mountPreferred };
}

type Page = Record<string, unknown> & {
  entries?: Array<{ title: string; site: string; link: string }>;
  nextCursor?: string;
  facets?: Array<{ siteId: string; siteName: string }>;
  excluded?: Array<{ siteId: string; reason: string }>;
  scope?: string;
};

async function search(app: FastifyInstance, query: string): Promise<{ status: number; body: Page }> {
  const res = await app.inject({ method: 'GET', url: `/api/search${query}` });
  return { status: res.statusCode, body: res.body === '' ? {} : (JSON.parse(res.body) as Page) };
}

describe('GET /api/search — scope selector', () => {
  it('scope=all (default) answers from the local index with ZERO network (fetch stubbed; fallback never touched)', async () => {
    const h = buildScopeHarness();
    // The egress stub: ANY fetch attempt fails loudly. Node's undici
    // global fetch is the only network door in the API process.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> => {
      return Promise.reject(new Error('EGRESS-STUB: network is forbidden in this test'));
    };
    try {
      const res = await search(h.app, '?q=common&limit=10');
      expect(res.status).toBe(200);
      expect((res.body.entries ?? []).map((e) => e.site).sort()).toEqual([SITE_A, SITE_B]);
      expect(res.body.scope).toBe('all');
      // The catalog-less enabled site surfaces as excluded — the
      // all-sites union NEVER falls back to a live scrape for it.
      expect((res.body.excluded ?? []).map((e) => e.siteId)).toEqual([SITE_C]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scope=all never consults the §6.8 fallback (a touching double throws)', async () => {
    const inner = new InMemoryCatalogStore();
    inner.install(SITE_A, siteAEntries());
    const modules = new InMemoryModuleService(registrations(), false, (id) => inner.getMeta(id) !== undefined);
    const app = buildApp(
      {
        modules,
        settings: new InMemorySettingsService(modules),
        catalogs: inner,
        info: new FakeInfoService([SITE_A]),
        jobs: new InMemoryJobService(),
        sync: {
          syncModules: async () => {
          throw new Error('not used');
        },
          syncCatalog: async () => {
            throw new Error('not used');
          },
          syncAllCatalogs: async () => [],
        },
        library: new InMemoryLibraryService(),
        favorites: new InMemoryFavoriteService(),
        catalogFallback: {
          supports: (): boolean => {
            throw new Error('FALLBACK-STUB: the all-sites union must never touch the live fallback');
          },
          latest: (): never => {
            throw new Error('FALLBACK-STUB');
          },
          byTitle: (): never => {
            throw new Error('FALLBACK-STUB');
          },
          search: (): never => {
            throw new Error('FALLBACK-STUB');
          },
          invalidate: (): void => {
            throw new Error('FALLBACK-STUB');
          },
        },
      },
      { version: TEST_VERSION },
    );
    const res = await search(app, '?q=alpha&limit=10');
    expect(res.status).toBe(200);
    expect((res.body.entries ?? []).map((e) => e.site)).toEqual([SITE_A]);
  });

  it('scope=preferred filters participation to the allowlist and orders facets canonically', async () => {
    // Allowlist order B → A is DELIBERATELY not site-id order: the
    // facets must render in the user's order (D1 §3 canonical).
    const h = buildScopeHarness({ preferred: [SITE_B, SITE_A] });
    const res = await search(h.app, '?q=common&scope=preferred&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('preferred');
    expect((res.body.entries ?? []).map((e) => [e.title, e.site])).toEqual([
      ['Common Title', SITE_A],
      ['Common Title', SITE_B],
    ]);
    // Facets in allowlist order (B first), counts intact; the
    // catalog-less site C is NOT in scope → not excluded either.
    expect((res.body.facets ?? []).map((f) => f.siteId)).toEqual([SITE_B, SITE_A]);
    expect(res.body.excluded).toEqual([]);
  });

  it('scope=preferred with an empty allowlist returns an honestly empty page', async () => {
    const h = buildScopeHarness({ preferred: [] });
    const res = await search(h.app, '?q=common&scope=preferred&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.facets).toEqual([]);
    expect(res.body.excluded).toEqual([]);
  });

  it('scope=preferred surfaces the scoped catalog-less site as excluded (the live-candidate contract)', async () => {
    const h = buildScopeHarness({ preferred: [SITE_A, SITE_C] });
    const res = await search(h.app, '?q=common&scope=preferred&limit=10');
    expect(res.status).toBe(200);
    expect((res.body.entries ?? []).map((e) => e.site)).toEqual([SITE_A]);
    expect((res.body.excluded ?? []).map((e) => e.siteId)).toEqual([SITE_C]);
  });

  it('scope=preferred without the service mounted is a typed 400 (never a silent fall-back to all)', async () => {
    const h = buildScopeHarness({ mountPreferred: false });
    const res = await search(h.app, '?q=common&scope=preferred&limit=10');
    expect(res.status).toBe(400);
    const envelope = res.body as { error?: { message?: string } };
    expect(envelope.error?.message ?? '').toContain('preferred-sites scope is not available');
  });

  it('sites= (specific) is the tightest scope: wins over scope=preferred, orders facets by pick order', async () => {
    const h = buildScopeHarness({ preferred: [SITE_B] });
    const res = await search(h.app, '?q=common&scope=preferred&sites=' + SITE_A + ',' + SITE_B + '&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('specific');
    // Pick order A → B orders the facets even though the allowlist
    // and site-id order say otherwise.
    expect((res.body.facets ?? []).map((f) => f.siteId)).toEqual([SITE_A, SITE_B]);
    expect((res.body.entries ?? []).map((e) => e.site)).toEqual([SITE_A, SITE_B]);
  });

  it('sites= with an unknown registry id is a typed 400 naming the offender', async () => {
    const h = buildScopeHarness();
    const unknown = 'f'.repeat(32);
    const res = await search(h.app, `?q=x&sites=${SITE_A},${unknown}&limit=10`);
    expect(res.status).toBe(400);
    const envelope = res.body as { error?: { message?: string } };
    expect(envelope.error?.message ?? '').toContain(unknown);
  });

  it('sites= pins scope to exactly the picks (unpicked installed sites are absent)', async () => {
    const h = buildScopeHarness();
    const res = await search(h.app, `?q=common&sites=${SITE_B}&limit=10`);
    expect(res.status).toBe(200);
    expect((res.body.entries ?? []).map((e) => e.site)).toEqual([SITE_B]);
    expect((res.body.facets ?? []).map((f) => f.siteId)).toEqual([SITE_B]);
  });

  it('a cursor issued under one scope is a typed 400 under another (scope-bound cursor)', async () => {
    const h = buildScopeHarness();
    const all = await search(h.app, '?q=common&limit=1');
    expect(all.status).toBe(200);
    expect(all.body.nextCursor).toBeDefined();
    const reuse = await search(h.app, `?q=common&limit=1&cursor=${all.body.nextCursor ?? ''}&sites=${SITE_A}`);
    expect(reuse.status).toBe(400);
    const envelope = reuse.body as { error?: { message?: string } };
    expect(envelope.error?.message ?? '').toContain('cursor does not match');
  });

  it('repeated identical queries are served from the short-TTL cache without re-fanning the stores', async () => {
    const h = buildScopeHarness();
    const first = await search(h.app, '?q=common&limit=10');
    expect(first.status).toBe(200);
    const callsAfterFirst = h.store.searchCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = await search(h.app, '?q=common&limit=10');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(h.store.searchCalls).toBe(callsAfterFirst); // cache hit: no re-fan
    // A DIFFERENT query is a different cache key → fans the stores.
    const third = await search(h.app, '?q=beta&limit=10');
    expect(third.status).toBe(200);
    expect(h.store.searchCalls).toBeGreaterThan(callsAfterFirst);
  });
});

describe('GET /api/search — egress stub hygiene', () => {
  const originalFetch = globalThis.fetch;
  afterEach((): void => {
    globalThis.fetch = originalFetch;
  });

  it('scoped queries are local-index only too (preferred scope, fetch stubbed)', async () => {
    globalThis.fetch = (): Promise<Response> =>
      Promise.reject(new Error('EGRESS-STUB: network is forbidden in this test'));
    const h = buildScopeHarness({ preferred: [SITE_A, SITE_B] });
    const res = await search(h.app, '?q=common&scope=preferred&limit=10');
    expect(res.status).toBe(200);
    expect((res.body.entries ?? []).length).toBe(2);
  });
});
