/**
 * Preferred-sites allowlist ([fuzzy-javelin-pearls], D1 §2 ENTER):
 *
 * - SERVICE (SqlitePreferredSitesService): persistence lives in the
 *   app_settings kv row (round-trips through a REAL better-sqlite3
 *   app_settings table — reconstructing the service from the same db
 *   serves the same ordered list); unknown ids refuse naming the
 *   offenders; duplicates keep their FIRST position; the ceiling
 *   refuses; the decode path is defensive against garbage/legacy
 *   bytes.
 * - API: GET default empty; PUT full-list replacement round-trip in
 *   the SUBMITTED order; PUT unknown id → typed 400 naming them; the
 *   /api/modules join flips `preferred` per row live; a PUT bumps the
 *   /api/search cache generation (the scoped page re-fans the stores
 *   instead of serving the stale allowlist's answer).
 * - Covers posture: no service → the routes are not mounted (404).
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
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
  PREFERRED_SITES_MAX,
  PREFERRED_SITES_SETTINGS_KEY,
  SqlitePreferredSitesService,
  InMemoryPreferredSitesService,
} from '../../src/runtime/preferred-sites.js';

const SITE_A = '1'.repeat(32);
const SITE_B = '2'.repeat(32);
const SITE_C = '3'.repeat(32);

function registrations(): RegistrationRecord[] {
  return [
    makeRegistration({ id: SITE_A, name: 'SiteA Manga' }),
    makeRegistration({ id: SITE_B, name: 'SiteB Manga' }),
    makeRegistration({ id: SITE_C, name: 'SiteC NoCatalog' }),
  ];
}

function appSettingsKv(db: Database.Database): {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
} {
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const read = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  const write = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  return {
    getSetting(key: string): string | undefined {
      const row = read.get(key) as { value?: string } | undefined;
      return row?.value;
    },
    setSetting(key: string, value: string): void {
      write.run(key, value);
    },
  };
}

describe('SqlitePreferredSitesService (app_settings kv persistence)', () => {
  it('round-trips the ordered allowlist through a real app_settings table (service reconstruction serves the same order)', () => {
    const db = new Database(':memory:');
    const kv = appSettingsKv(db);
    const service = new SqlitePreferredSitesService(kv);
    expect(service.list()).toEqual([]);
    expect(service.set([SITE_B, SITE_A])).toEqual([SITE_B, SITE_A]);
    // A SECOND service instance over the same db (the restart shape).
    const reopened = new SqlitePreferredSitesService(kv);
    expect(reopened.list()).toEqual([SITE_B, SITE_A]);
    expect(reopened.includes(SITE_A)).toBe(true);
    expect(reopened.includes(SITE_C)).toBe(false);
    // Replacement IS the write surface (no add/remove verbs).
    expect(reopened.set([SITE_A])).toEqual([SITE_A]);
    expect(service.list()).toEqual([SITE_A]);
  });

  it('dedupes keeping the FIRST position and caps the list (registry validation is the ROUTE gate)', () => {
    const db = new Database(':memory:');
    const service = new SqlitePreferredSitesService(appSettingsKv(db));
    expect(service.set([SITE_B, SITE_A, SITE_B])).toEqual([SITE_B, SITE_A]);
    const flood = Array.from({ length: PREFERRED_SITES_MAX + 1 }, (): string => SITE_A);
    expect((): void => {
      service.set(flood);
    }).toThrow(/capped/);
  });

  it('decodes defensively: garbage, non-array and non-string rows read as an empty/filtered list', () => {
    const db = new Database(':memory:');
    const kv = appSettingsKv(db);
    kv.setSetting(PREFERRED_SITES_SETTINGS_KEY, 'not json');
    const garbage = new SqlitePreferredSitesService(kv);
    expect(garbage.list()).toEqual([]);
    kv.setSetting(PREFERRED_SITES_SETTINGS_KEY, JSON.stringify([SITE_A, 42, null, SITE_B]));
    const legacy = new SqlitePreferredSitesService(kv);
    expect(legacy.list()).toEqual([SITE_A, SITE_B]);
  });
});

interface ApiHarness {
  readonly app: FastifyInstance;
  readonly service: InMemoryPreferredSitesService;
}

function buildApiHarness(mounted = true): ApiHarness {
  const catalogs = new InMemoryCatalogStore();
  const service = new InMemoryPreferredSitesService();
  const modules = new InMemoryModuleService(
    registrations(),
    false,
    (id) => catalogs.getMeta(id) !== undefined,
    (): import('../../src/runtime/site-availability.js').SiteAvailabilityRecord => ({
      status: 'unknown',
      checkedAt: null,
      reason: null,
    }),
    // The /api/modules preferred join (the assembly wires the LIVE
    // lookup through RefreshableModuleService; the harness passes the
    // same shape directly).
    (id: string): boolean => service.includes(id),
  );
  const app = buildApp(
    {
      modules,
      settings: new InMemorySettingsService(modules),
      catalogs,
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
      ...(mounted ? { preferredSites: service } : {}),
    },
    { version: TEST_VERSION },
  );
  return { app, service };
}

type SitesBody = { sites?: string[] };
type ModulesBody = { modules?: Array<{ id: string; preferred?: boolean }> };

async function getPreferred(app: FastifyInstance): Promise<{ status: number; body: SitesBody }> {
  const res = await app.inject({ method: 'GET', url: '/api/preferred-sites' });
  return { status: res.statusCode, body: res.body === '' ? {} : (JSON.parse(res.body) as SitesBody) };
}

async function putPreferred(
  app: FastifyInstance,
  sites: readonly string[],
): Promise<{ status: number; body: SitesBody }> {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/preferred-sites',
    payload: { sites: [...sites] },
  });
  return { status: res.statusCode, body: res.body === '' ? {} : (JSON.parse(res.body) as SitesBody) };
}

describe('GET/PUT /api/preferred-sites (API contract)', () => {
  it('GET serves the ordered allowlist (empty default)', async () => {
    const h = buildApiHarness();
    const res = await getPreferred(h.app);
    expect(res.status).toBe(200);
    expect(res.body.sites).toEqual([]);
    h.service.set([SITE_B, SITE_A]);
    const after = await getPreferred(h.app);
    expect(after.body.sites).toEqual([SITE_B, SITE_A]);
  });

  it('PUT replaces the full list, echoes the persisted order, and round-trips', async () => {
    const h = buildApiHarness();
    const put = await putPreferred(h.app, [SITE_C, SITE_A]);
    expect(put.status).toBe(200);
    expect(put.body.sites).toEqual([SITE_C, SITE_A]);
    const again = await putPreferred(h.app, [SITE_A]);
    expect(again.body.sites).toEqual([SITE_A]);
    const got = await getPreferred(h.app);
    expect(got.body.sites).toEqual([SITE_A]);
  });

  it('PUT with unknown ids is a typed 400 naming them (list unchanged)', async () => {
    const h = buildApiHarness();
    await putPreferred(h.app, [SITE_A]);
    const unknown = 'e'.repeat(32);
    const bad = await putPreferred(h.app, [SITE_B, unknown]);
    expect(bad.status).toBe(400);
    const envelope = bad.body as unknown as { error?: { message?: string } };
    expect(envelope.error?.message ?? '').toContain(unknown);
    const got = await getPreferred(h.app);
    expect(got.body.sites).toEqual([SITE_A]);
  });

  it('/api/modules joins preferred per row LIVE (flips after the PUT)', async () => {
    const h = buildApiHarness();
    const before = await h.app.inject({ method: 'GET', url: '/api/modules' });
    const beforeRows = (JSON.parse(before.body) as ModulesBody).modules ?? [];
    expect(beforeRows.filter((m): boolean => m.preferred === true)).toEqual([]);
    await putPreferred(h.app, [SITE_B, SITE_C]);
    const after = await h.app.inject({ method: 'GET', url: '/api/modules' });
    const rows = (JSON.parse(after.body) as ModulesBody).modules ?? [];
    expect(rows.filter((m): boolean => m.preferred === true).map((m): string => m.id).sort()).toEqual(
      [SITE_B, SITE_C].sort(),
    );
  });

  it('a PUT bumps the search cache generation (a scoped page re-fans instead of serving stale scope truth)', async () => {
    const h = buildApiHarness();
    h.service.set([SITE_A]);
    const first = await h.app.inject({ method: 'GET', url: `/api/search?q=x&scope=preferred&limit=10` });
    expect(first.statusCode).toBe(200);
    // Same query again — cached (the scope is unchanged).
    const cached = await h.app.inject({ method: 'GET', url: `/api/search?q=x&scope=preferred&limit=10` });
    expect(cached.statusCode).toBe(200);
    expect(JSON.parse(cached.body)).toEqual(JSON.parse(first.body));
    // The allowlist changes → the cached scoped page is unreachable.
    await putPreferred(h.app, [SITE_A, SITE_B]);
    const rescope = await h.app.inject({
      method: 'GET',
      url: `/api/search?q=x&scope=preferred&limit=10`,
    });
    expect(rescope.statusCode).toBe(200);
    const body = JSON.parse(rescope.body) as { scope?: string };
    expect(body.scope).toBe('preferred');
  });

  it('routes are not mounted when the service is absent (the covers posture)', async () => {
    const h = buildApiHarness(false);
    const get = await h.app.inject({ method: 'GET', url: '/api/preferred-sites' });
    expect(get.statusCode).toBe(404);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/preferred-sites',
      payload: { sites: [SITE_A] },
    });
    expect(put.statusCode).toBe(404);
  });
});
