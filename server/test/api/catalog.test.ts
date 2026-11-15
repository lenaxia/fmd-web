/**
 * Sync + catalog route integration tests (§10): POST /api/sync/* and
 * GET /api/catalog/:id/{latest,title,search} over an in-memory store.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHarness,
  CATALOG_ID,
  catalogFixtures,
  expectEnvelope,
  UNKNOWN_CATALOG_ID,
} from './helpers.js';

describe('POST /api/sync/modules', (): void => {
  it('happy path: returns the sync outcome + sweep summary', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/sync/modules' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      summary: { treeSha: string; totalModules: number; knownBroken: Record<string, string[]> };
    };
    expect(body.ok).toBe(true);
    expect(body.summary.totalModules).toBe(4);
    expect(body.summary.knownBroken['madara.run_html_load']).toEqual(['BetaSource']);
  });

  it('accepts an absent body', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/sync/modules' });
    expect(res.statusCode).toBe(200);
  });

  it('maps sync service failures onto the error envelope (500 internal)', async (): Promise<void> => {
    const failingSync = {
      syncModules: async (): Promise<never> => {
        throw new Error('fetch failed');
      },
      syncCatalog: async (): Promise<never> => {
        throw new Error('fetch failed');
      },
      syncAllCatalogs: async (): Promise<never> => {
        throw new Error('fetch failed');
      },
    };
    const h = buildHarness({ sync: failingSync });
    const res = await h.app.inject({ method: 'POST', url: '/api/sync/modules' });
    expect(res.statusCode).toBe(500);
    expectEnvelope(res.body, 'internal_error');
  });
});

describe('POST /api/sync/catalog/:id and /all', (): void => {
  it('happy path per-catalog and all-catalogs', async (): Promise<void> => {
    const h = buildHarness();
    const one = await h.app.inject({ method: 'POST', url: `/api/sync/catalog/${CATALOG_ID}` });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual({
      ok: true,
      result: { id: CATALOG_ID, state: 'updated', dbSha: 'cd34'.repeat(16), bytes: 4096 },
    });
    const all = await h.app.inject({ method: 'POST', url: '/api/sync/catalog/all' });
    expect(all.statusCode).toBe(200);
    expect(all.json().results).toEqual([{ id: CATALOG_ID, state: 'unchanged' }]);
  });

  it('unknown (well-formed) catalog id is 404; malformed id is a validation error', async (): Promise<void> => {
    const h = buildHarness();
    const unknown = await h.app.inject({ method: 'POST', url: `/api/sync/catalog/${UNKNOWN_CATALOG_ID}` });
    expect(unknown.statusCode).toBe(404);
    expectEnvelope(unknown.body, 'not_found');

    const malformed = await h.app.inject({ method: 'POST', url: '/api/sync/catalog/tooshort' });
    expect(malformed.statusCode).toBe(400);
    expectEnvelope(malformed.body, 'validation_error');
  });
});

describe('GET /api/catalog/:id/latest + /title (§6.6)', (): void => {
  it('latest is ordered by jdn DESC with page/limit params', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${CATALOG_ID}/latest?limit=3&page=1` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<{ jdn: number }>; total: number };
    expect(body.total).toBe(5);
    const jdns = body.entries.map((e) => e.jdn);
    expect(jdns).toEqual([45300, 45200, 45100]);
    // Page 2 continues the ordering.
    const p2 = await h.app.inject({ method: 'GET', url: `/api/catalog/${CATALOG_ID}/latest?limit=3&page=2` });
    expect((p2.json() as { entries: Array<{ jdn: number }> }).entries.map((e) => e.jdn)).toEqual([45000, 44900]);
  });

  it('title is ordered by title ASC', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${CATALOG_ID}/title` });
    expect(res.statusCode).toBe(200);
    const titles = (res.json() as { entries: Array<{ title: string }> }).entries.map((e) => e.title);
    expect(titles).toEqual(['Alpha', 'Alpha Returns', 'Beta', 'Delta', 'Gamma']);
  });

  it('defaults: page 1, limit 20', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${CATALOG_ID}/latest` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { entries: unknown[] }).entries).toHaveLength(5);
  });

  it('validation failures: bad page/limit, bad id, unknown catalog', async (): Promise<void> => {
    const h = buildHarness();
    for (const url of [
      `/api/catalog/${CATALOG_ID}/latest?page=0`,
      `/api/catalog/${CATALOG_ID}/latest?limit=0`,
      `/api/catalog/${CATALOG_ID}/latest?limit=500`,
      `/api/catalog/${CATALOG_ID}/latest?page=abc`,
    ]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expectEnvelope(res.body, 'validation_error');
    }
    const malformed = await h.app.inject({ method: 'GET', url: '/api/catalog/zz/latest' });
    expect(malformed.statusCode).toBe(400);
    expectEnvelope(malformed.body, 'validation_error');

    const unknown = await h.app.inject({ method: 'GET', url: `/api/catalog/${UNKNOWN_CATALOG_ID}/latest` });
    expect(unknown.statusCode).toBe(404);
    expectEnvelope(unknown.body, 'not_found');
  });
});

describe('GET /api/catalog/:id/search — FTS + cursor pagination (§6.5)', (): void => {
  it('happy path: term filter + status/genre filters + total', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${CATALOG_ID}/search?q=story` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { total: number }).total).toBe(5);

    const statusFiltered = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${CATALOG_ID}/search?q=story&status=Ongoing&genre=Action&limit=2`,
    });
    expect(statusFiltered.statusCode).toBe(200);
    const page = statusFiltered.json() as { entries: Array<{ title: string }>; total: number };
    expect(page.total).toBe(3); // Alpha, Alpha Returns, Delta (Action + Ongoing)
    expect(page.entries).toHaveLength(2); // page bounded by limit
    expect(page.entries.every((e) => ['Alpha', 'Alpha Returns', 'Delta'].includes(e.title))).toBe(true);
  });

  it('missing q is a validation error', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${CATALOG_ID}/search` });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'validation_error');
  });

  it('cursor pagination walks every match exactly once', async (): Promise<void> => {
    const h = buildHarness();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const url = cursor === undefined
        ? `/api/catalog/${CATALOG_ID}/search?q=story&limit=2`
        : `/api/catalog/${CATALOG_ID}/search?q=story&limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      const page = res.json() as { entries: Array<{ link: string }>; nextCursor?: string };
      seen.push(...page.entries.map((e) => e.link));
      cursor = page.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it('a cursor bound to another query is rejected (400, never silently re-paged)', async (): Promise<void> => {
    const h = buildHarness();
    const first = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${CATALOG_ID}/search?q=story&limit=2`,
    });
    const cursor = (first.json() as { nextCursor?: string }).nextCursor;
    expect(cursor).toBeDefined();
    const rebound = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${CATALOG_ID}/search?q=OTHER&cursor=${encodeURIComponent(cursor as string)}`,
    });
    expect(rebound.statusCode).toBe(400);
    expectEnvelope(rebound.body, 'bad_request');
  });

  it('garbage cursors are a 400 bad_request envelope', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${CATALOG_ID}/search?q=story&cursor=%21%21notacursor`,
    });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'bad_request');
  });

  it('a fresh install becomes visible to the read side (store seam)', async (): Promise<void> => {
    const h = buildHarness();
    h.catalogs.install(UNKNOWN_CATALOG_ID, catalogFixtures());
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${UNKNOWN_CATALOG_ID}/latest` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { total: number }).total).toBe(5);
  });
});
