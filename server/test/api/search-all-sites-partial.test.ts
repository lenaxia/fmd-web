/**
 * GET /api/search partial failure — a CORRUPTED installed catalog (real
 * SQLite store, real on-disk fixture) must yield the REST of the union
 * plus a typed warning naming the broken site: never silent, never a
 * full failure (FMD2's union keeps serving the DBs that open).
 *
 * Runs the REAL CatalogFileStore over real catalog dbs built exactly
 * like FMD2-DB's pipeline (createCatalogDb) plus one garbage-bytes
 * `catalogs/<id>.db` — getMeta self-heals from the file, so the site
 * counts as installed and its search throws at open/query time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CatalogFileStore } from '../../src/sync/db/catalog-store.js';
import { buildApp } from '../../src/api/app.js';
import {
  InMemoryFavoriteService,
  InMemoryJobService,
  InMemoryLibraryService,
  InMemoryModuleService,
  InMemorySettingsService,
} from '../../src/api/services.js';
import {
  FakeInfoService,
  TEST_VERSION,
  makeRegistration,
} from './helpers.js';
import { createCatalogDb, fixtureId, type FixtureRow } from '../sync/db/fixtures.js';

const GOOD_A = fixtureId('union-good-a');
const GOOD_B = fixtureId('union-good-b');
const BROKEN = fixtureId('union-corrupt');

const ROWS_A: readonly FixtureRow[] = [
  { link: '/a/one', title: 'Ape Kingdom', status: 'Ongoing', numchapter: 1, jdn: 45001 },
  { link: '/a/two', title: 'Aardvark Tales', status: 'Ongoing', numchapter: 2, jdn: 45002 },
];
const ROWS_B: readonly FixtureRow[] = [
  { link: '/b/one', title: 'Bat Adventures', status: 'Ongoing', numchapter: 1, jdn: 45003 },
];

interface RealStoreHarness {
  readonly app: FastifyInstance;
  readonly store: CatalogFileStore;
}

function buildRealStoreHarness(dataDir: string): RealStoreHarness {
  const store = new CatalogFileStore({ dataDir });
  const modules = new InMemoryModuleService(
    [
      makeRegistration({ id: GOOD_A, name: 'Good Site A' }),
      makeRegistration({ id: GOOD_B, name: 'Good Site B' }),
      makeRegistration({ id: BROKEN, name: 'Corrupt Site' }),
    ],
    false,
    (id) => store.getMeta(id) !== undefined,
  );
  const app = buildApp(
    {
      modules,
      settings: new InMemorySettingsService(modules),
      catalogs: store,
      info: new FakeInfoService([GOOD_A, GOOD_B]),
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
  return { app, store };
}

describe('GET /api/search — partial failure over the REAL catalog store', () => {
  let tmp: string;

  beforeEach((): void => {
    tmp = fs.mkdtempSync('/tmp/opencode/union-');
    fs.mkdirSync(path.join(tmp, 'catalogs'), { recursive: true });
    createCatalogDb(path.join(tmp, 'catalogs', `${GOOD_A}.db`), ROWS_A);
    createCatalogDb(path.join(tmp, 'catalogs', `${GOOD_B}.db`), ROWS_B);
    // The corrupted catalog fixture: an install receipt WOULD exist for
    // a real install; a garbage db with a valid receipt is the exact
    // "catalog file corrupted on disk" production shape. getMeta
    // self-heals from the file either way → the site is "installed".
    fs.writeFileSync(path.join(tmp, 'catalogs', `${BROKEN}.db`), 'this is not a sqlite database at all', 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'catalogs', `${BROKEN}.meta.json`),
      `${JSON.stringify({ dbSha: '0'.repeat(64), fetchedAt: '2026-01-01T00:00:00Z' }, null, 2)}\n`,
      'utf8',
    );
  });

  afterEach((): void => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a corrupted catalog yields the other sites\' results + a typed warning naming it (200, never full failure)', async (): Promise<void> => {
    const h = buildRealStoreHarness(tmp);
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/search?q=&status=Ongoing&limit=10' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        entries: Array<{ title: string; site: string; siteName: string }>;
        facets: Array<{ siteId: string; siteName: string }>;
        warnings: Array<{ siteId: string; siteName: string; error: string }>;
        excluded: unknown[];
        nextCursor?: string;
      };
      // Both good sites answered (real FTS sidecars), merged in
      // documented order — 'Aardvark Tales' < 'Ape Kingdom' < 'Bat Adventures'.
      expect(body.entries.map((e) => e.title)).toEqual([
        'Aardvark Tales',
        'Ape Kingdom',
        'Bat Adventures',
      ]);
      expect(new Set(body.entries.map((e) => e.siteName))).toEqual(new Set(['Good Site A', 'Good Site B']));
      // The corrupted site is named in the typed warning.
      expect(body.warnings.length).toBe(1);
      expect(body.warnings[0]?.siteId).toBe(BROKEN);
      expect(body.warnings[0]?.siteName).toBe('Corrupt Site');
      expect(typeof body.warnings[0]?.error).toBe('string');
      // Facets cover the sites that answered.
      expect(body.facets.map((f) => f.siteId).sort()).toEqual([GOOD_A, GOOD_B].sort());
      expect(body.excluded).toEqual([]);
      expect(body.nextCursor).toBeUndefined(); // the union drained
    } finally {
      h.store.closeAll();
    }
  });

  it('pagination continues across the corrupted site: the cursor walk still completes over the healthy union', async (): Promise<void> => {
    const h = buildRealStoreHarness(tmp);
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await h.app.inject({
          method: 'GET',
          url: `/api/search?q=&status=Ongoing&limit=1${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { entries: Array<{ title: string }>; nextCursor?: string; warnings: unknown[] };
        // The warning persists on EVERY page (typed partial state is
        // not a one-shot — each fan-out retries the broken site).
        expect(body.warnings.length).toBe(1);
        seen.push(...body.entries.map((e) => e.title));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(seen).toEqual(['Aardvark Tales', 'Ape Kingdom', 'Bat Adventures']);
    } finally {
      h.store.closeAll();
    }
  });
});
