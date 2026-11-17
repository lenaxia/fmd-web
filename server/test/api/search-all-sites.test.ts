/**
 * GET /api/search — all-sites union search (FMD2 cbSearchFromAllSites
 * parity, frmMain.pas:3411) integration tests over the offline
 * fastify.inject harness:
 *
 * - multi-site merge order (documented comparator) + Website tagging
 *   of every row + per-site count facets
 * - installed-only semantics: catalog-less enabled sites are excluded
 *   (surfaced with reason), disabled sites never participate
 * - cursor pagination across per-site window boundaries (K = 2×limit)
 * - empty-q behavior (400 bare, filter-only OK)
 * - union cursor binding (filter mismatch → 400)
 * - PROPERTY: identical output + cursor bytes under site permutation
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CatalogEntry } from '@fmd/contract';
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
import {
  UnionSearchService,
  compareSearchEntries,
} from '../../src/api/search-service.js';

const SITE_A = '1'.repeat(32);
const SITE_B = '2'.repeat(32);
const SITE_C = '3'.repeat(32); // enabled, NO catalog
const SITE_D = '4'.repeat(32); // catalog installed but DISABLED

const SITE_A_NAME = 'SiteA Manga';
const SITE_B_NAME = 'SiteB Manga';

function registrations(): RegistrationRecord[] {
  return [
    makeRegistration({ id: SITE_A, name: SITE_A_NAME }),
    makeRegistration({ id: SITE_B, name: SITE_B_NAME }),
    makeRegistration({ id: SITE_C, name: 'SiteC NoCatalog' }),
    makeRegistration({ id: SITE_D, name: 'SiteD Disabled' }),
  ];
}

function entry(link: string, title: string, jdn: number, genres = 'Action'): CatalogEntry {
  return {
    link,
    title,
    alttitles: '',
    authors: 'A',
    artists: '',
    genres,
    status: 'Ongoing',
    summary: '',
    numChapter: 1,
    jdn,
  };
}

function siteAEntries(): CatalogEntry[] {
  return [
    entry('/a/berserk', 'Berserk', 46001),
    entry('/a/alpha', 'Alpha Legend', 45001),
    entry('/a/common', 'Common Title', 45101),
    entry('/a/zeta', 'Zeta Rising', 45201),
  ];
}

function siteBEntries(): CatalogEntry[] {
  return [
    entry('/b/common', 'Common Title', 46002),
    entry('/b/beta', 'Beta Saga', 45002),
    entry('/b/common2', 'common   title', 45102), // normalizes equal to Common Title
    entry('/b/gamma', 'Gamma Drift', 45202),
    entry('/b/alpha-alt', 'Alpha Legend', 45302),
  ];
}

/** The full comparator-ordered union of both fixtures (test oracle). */
function fullUnion(): Array<{ title: string; site: string; link: string }> {
  return [
    ...siteAEntries().map((e) => ({ title: e.title, site: SITE_A, link: e.link })),
    ...siteBEntries().map((e) => ({ title: e.title, site: SITE_B, link: e.link })),
  ].sort(compareSearchEntries);
}

interface UnionHarness {
  readonly app: FastifyInstance;
  readonly modules: InMemoryModuleService;
  readonly catalogs: InMemoryCatalogStore;
}

function buildUnionHarness(): UnionHarness {
  const catalogs = new InMemoryCatalogStore();
  catalogs.install(SITE_A, siteAEntries());
  catalogs.install(SITE_B, siteBEntries());
  catalogs.install(SITE_D, [entry('/d/hidden', 'Disabled Site Row', 1)]);
  const modules = new InMemoryModuleService(
    registrations(),
    false,
    (id) => catalogs.getMeta(id) !== undefined,
  );
  modules.update(SITE_D, { enabled: false });
  const app = buildApp(
    {
      modules,
      settings: new InMemorySettingsService(modules),
      catalogs,
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
    },
    { version: TEST_VERSION },
  );
  return { app, modules, catalogs };
}

interface Row {
  readonly title: string;
  readonly site: string;
  readonly siteName: string;
  readonly link: string;
}

type Page = Record<string, unknown> & {
  entries?: Row[];
  nextCursor?: string;
  facets?: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  excluded?: Array<Record<string, unknown>>;
};

async function search(app: FastifyInstance, query: string): Promise<{ status: number; body: Page }> {
  const res = await app.inject({ method: 'GET', url: `/api/search${query}` });
  return { status: res.statusCode, body: res.body === '' ? {} : (JSON.parse(res.body) as Page) };
}

describe('GET /api/search — all-sites union (integration)', () => {
  it('merges installed catalogs in documented order; every row carries its Website; facets count per site', async () => {
    const h = buildUnionHarness();
    const res = await search(h.app, '?q=alpha&limit=10');
    expect(res.status).toBe(200);
    // Normalized-title order; same-title rows tiebreak by site id.
    expect((res.body.entries ?? []).map((e) => [e.title, e.site])).toEqual([
      ['Alpha Legend', SITE_A],
      ['Alpha Legend', SITE_B],
    ]);
    for (const row of res.body.entries ?? []) {
      expect(row.siteName).toBe(row.site === SITE_A ? SITE_A_NAME : SITE_B_NAME);
    }
    // Facets: per-site totals, sorted by siteId; the disabled site is
    // absent, the catalog-less site is excluded (not a facet).
    expect(res.body.facets).toEqual([
      { siteId: SITE_A, siteName: SITE_A_NAME, count: 1 },
      { siteId: SITE_B, siteName: SITE_B_NAME, count: 1 },
    ]);
    expect(res.body.warnings).toEqual([]);
    // Installed-only semantics surfaced: enabled + catalog-less → chip data.
    expect(res.body.excluded).toEqual([
      { siteId: SITE_C, siteName: 'SiteC NoCatalog', reason: 'no-catalog' },
    ]);
  });

  it('same normalized title across sites interleaves by site id (site tiebreak, not fan-out order)', async () => {
    const h = buildUnionHarness();
    const res = await search(h.app, '?q=common&limit=10');
    expect(res.status).toBe(200);
    expect((res.body.entries ?? []).map((e) => [e.title, e.site, e.link])).toEqual([
      ['Common Title', SITE_A, '/a/common'],
      ['Common Title', SITE_B, '/b/common'],
      ['common   title', SITE_B, '/b/common2'],
    ]);
  });

  it('cursor pagination walks every per-site window boundary; the union is complete, duplicate-free, stably ordered', async () => {
    const h = buildUnionHarness();
    const expected = fullUnion();
    expect(expected.length).toBe(9);

    // limit=2 → window K=4 per site; per-site offsets cross the K=4
    // boundary mid-walk (site A consumes 4, site B 5).
    const seen: Array<{ title: string; site: string; link: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await search(
        h.app,
        `?status=Ongoing&limit=2${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.status).toBe(200);
      const entries = (res.body.entries ?? []).map((e) => ({
        title: e.title,
        site: e.site,
        link: e.link,
      }));
      // Every page is itself in comparator order (page-local merge).
      expect([...entries].sort(compareSearchEntries)).toEqual(entries);
      seen.push(...entries);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 20);

    expect(pages).toBe(5); // 9 rows / 2 per page
    // COMPLETENESS (windowed-union contract): every row of the union
    // appears EXACTLY once — no row lost or duplicated across window
    // boundaries. (Cross-page global order is best-effort by design:
    // per-site store orderings are rank/jdn-specific and need not
    // agree with the union comparator — FMD2's own union is
    // site-appended, i.e. even less ordered.)
    expect(seen.length).toBe(expected.length);
    expect(new Set(seen.map((r) => `${r.site}:${r.link}`))).toEqual(
      new Set(expected.map((r) => `${r.site}:${r.link}`)),
    );
    // The disabled site's rows never appear.
    expect(seen.some((r) => r.site === SITE_D)).toBe(false);
  });

  it('empty q with no filter is a 400; empty q WITH a filter serves the union', async () => {
    const h = buildUnionHarness();
    const bare = await search(h.app, '');
    expect(bare.status).toBe(400);
    expect((bare.body['error'] as { code: string }).code).toBe('validation_error');
    const filtered = await search(h.app, '?status=Ongoing&limit=3');
    expect(filtered.status).toBe(200);
    expect((filtered.body.entries ?? []).length).toBe(3);
  });

  it('union cursors are query-bound: reuse against a different filter is a typed 400', async () => {
    const h = buildUnionHarness();
    const first = await search(h.app, '?q=common&limit=1');
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeDefined();
    const reused = await search(
      h.app,
      `?q=alpha&limit=1&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    );
    expect(reused.status).toBe(400);
    expect((reused.body['error'] as { code: string }).code).toBe('bad_request');
    expect((reused.body['error'] as { message: string }).message).toContain(
      'cursor does not match',
    );
  });

  it('the filter vocabulary passes through to every site (genres any/all + status parity)', async () => {
    const h = buildUnionHarness();
    h.catalogs.install(SITE_A, [
      entry('/a/drama', 'Drama All', 1, 'Drama'),
      entry('/a/action', 'Action Pick', 2, 'Action'),
    ]);
    const any = await search(h.app, '?genres=Drama,Action&genresMode=any&limit=10');
    expect((any.body.entries ?? []).map((e) => e.title).filter((t) => t.endsWith('All') || t.endsWith('Pick')).sort()).toEqual([
      'Action Pick',
      'Drama All',
    ]);
    // ALL mode ANDs the genres: nothing carries both Drama AND Action.
    const all = await search(h.app, '?genres=Drama,Action&genresMode=all&limit=10');
    expect((all.body.entries ?? []).map((e) => e.title).filter((t) => t.endsWith('All') || t.endsWith('Pick'))).toEqual([]);
  });
});

// ── PROPERTY: determinism under site permutation ─────────────────────

/** Deterministic LCG (property tests must never flake). */
function lcg(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function permuted<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

describe('PROPERTY — all-sites union determinism under site permutation', () => {
  it('identical entries, cursor bytes and facets for every permutation of the site set (25 seeded permutations)', async () => {
    const rand = lcg(20261117);
    const run = async (
      regs: RegistrationRecord[],
      installOrder: readonly (readonly [string, CatalogEntry[]])[],
    ): Promise<{ entries: string; cursor: string; facets: string }> => {
      const catalogs = new InMemoryCatalogStore();
      // The store's Map iteration order follows INSTALL order — a
      // second permutation axis beside the registry order.
      for (const [id, rows] of installOrder) {
        catalogs.install(id, rows);
      }
      const modules = new InMemoryModuleService(
        regs,
        false,
        (id) => catalogs.getMeta(id) !== undefined,
      );
      const service = new UnionSearchService(modules, catalogs);
      const page = await service.search({ status: 'Ongoing', limit: 2 });
      return {
        entries: JSON.stringify(page.entries.map((e) => [e.title, e.site, e.link])),
        cursor: JSON.stringify(page.nextCursor),
        facets: JSON.stringify(page.facets),
      };
    };

    const regs = registrations().filter((r) => r.id !== SITE_D);
    const installs: Array<[string, CatalogEntry[]]> = [
      [SITE_A, siteAEntries()],
      [SITE_B, siteBEntries()],
    ];

    const first = await run(regs, installs);
    expect(first.cursor).toBeDefined();
    for (let i = 0; i < 25; i += 1) {
      const result = await run(permuted(regs, rand), permuted(installs, rand));
      expect(result.entries).toBe(first.entries);
      expect(result.cursor).toBe(first.cursor);
      expect(result.facets).toBe(first.facets);
    }
  });
});
