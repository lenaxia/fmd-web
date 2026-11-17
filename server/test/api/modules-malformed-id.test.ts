/**
 * Regression: upstream module ids that are NOT valid 32-hex (e.g. FMD2's
 * ColorcitoScan.lua ships '5450026642ecrrd48apotd81e57f8e40' — a typo'd id
 * with 'rrd'/'apot' in it) are registered by the sweep but can never have
 * an FMD2-DB catalog. The /api/modules catalogInstalled join must report
 * them catalog-less, NOT let the CatalogStore's path-safety assert kill
 * the whole endpoint (observed live: GET /api/modules → 500).
 *
 * Exercises the REAL CatalogFileStore (not the in-memory double) so the
 * store's assertValidId chain is on the path; the guard lives in
 * InMemoryModuleService's constructor (single source, services.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHarness, makeRegistration } from './helpers.js';
import { CatalogFileStore } from '../../src/sync/db/catalog-store.js';

const TYPO_ID = '5450026642ecrrd48apotd81e57f8e40';

const dataDir = mkdtempSync(join(tmpdir(), 'fmd-catalog-join-'));
const realStore = new CatalogFileStore({ dataDir });
const h = buildHarness({
  catalogStore: realStore,
  extraRegistrations: [
    makeRegistration({
      id: TYPO_ID,
      name: 'Typo Id Site',
      rootURL: 'https://typo-id.example',
      category: 'English',
    }),
  ],
});

describe('GET /api/modules — malformed upstream module id (real catalog store)', (): void => {
  it('reports catalogInstalled false for a non-32-hex id instead of 500ing', async (): Promise<void> => {
    const res = await h.app.inject({ method: 'GET', url: '/api/modules' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { modules: Array<{ id: string; catalogInstalled: boolean }> };
    const typo = body.modules.find((m) => m.id === TYPO_ID);
    expect(typo).toBeDefined();
    expect(typo?.catalogInstalled).toBe(false);
  });
});
