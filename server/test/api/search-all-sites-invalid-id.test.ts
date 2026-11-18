/**
 * Regression (user-reported live 500): GET /api/search → 500
 * `invalid catalog id: 5450026642ecrrd48apotd81e57f8e40` — ColorcitoScan
 * .lua ships a typo'd module id (not 32-hex); the union search's
 * participation scan called `catalogs.getMeta(m.id)` OUTSIDE the
 * per-lane try/catch, so the store's path-safety assert killed the
 * WHOLE endpoint. The participation filter now guards with
 * `isValidCatalogId(m.id)` (the same guard class as services.ts's
 * catalogInstalled wrapper).
 *
 * Invalid-id modules are excluded from union participation entirely —
 * never a 500, never a lane, never a facet.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHarness, makeRegistration, CATALOG_ID } from './helpers.js';
import { CatalogFileStore } from '../../src/sync/db/catalog-store.js';

const TYPO_ID = '5450026642ecrrd48apotd81e57f8e40';

/** Registration factory with accountSupport default preserved. */
function typoRegistration() {
  return makeRegistration({
    id: TYPO_ID,
    name: 'ColorcitoScan (typo id)',
    rootURL: 'https://colorcitoscan.example',
    category: 'English Scanlation',
  });
}

describe('GET /api/search — typo-id module enabled (in-memory double)', (): void => {
  it('returns 200 with the union served; the invalid-id site never participates', async (): Promise<void> => {
    const h = buildHarness({ extraRegistrations: [typoRegistration()] });
    const res = await h.app.inject({ method: 'GET', url: '/api/search?q=one' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ site: string }>;
      facets: Array<{ siteId: string }>;
      warnings: unknown[];
      excluded: Array<{ siteId: string }>;
    };
    // The installed fixture catalog still serves the union.
    expect(body.entries.every((e): boolean => e.site !== TYPO_ID)).toBe(true);
    expect(body.facets.map((f): string => f.siteId)).toEqual([CATALOG_ID]);
    expect(body.warnings).toEqual([]);
    // The typo-id site is silently non-participating (it can NEVER have
    // a catalog — no reason row, no failure row).
    expect(body.excluded.every((e): boolean => e.siteId !== TYPO_ID)).toBe(true);
  });
});

describe('GET /api/search — typo-id module enabled (REAL CatalogFileStore assert chain)', (): void => {
  it('the participation guard fires before the store path-safety assert — 200, not 500', async (): Promise<void> => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fmd-search-invalid-id-'));
    const realStore = new CatalogFileStore({ dataDir });
    const h = buildHarness({
      catalogStore: realStore,
      extraRegistrations: [typoRegistration()],
    });
    const res = await h.app.inject({ method: 'GET', url: '/api/search?q=one' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[]; facets: unknown[]; warnings: unknown[] };
    expect(body.entries).toEqual([]);
    expect(body.facets).toEqual([]);
    expect(body.warnings).toEqual([]);
  });
});
