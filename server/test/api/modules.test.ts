/**
 * GET/PUT /api/modules integration tests (§10): capability +
 * known-broken flags, options incl. combobox INDEX semantics, and the
 * §5.1 option-value validation matrix.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHarness,
  expectEnvelope,
  makeRegistration,
  MODULE_A_ID,
  MODULE_B_ID,
  MODULE_C_ID,
} from './helpers.js';
import { InMemoryModuleService } from '../../src/api/services.js';

describe('GET /api/modules', (): void => {
  it('happy path: registry rows with capabilities, known-broken flags and options', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/modules' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      modules: Array<{ id: string; options: Array<{ name: string; kind: string; items?: string[] }> }>;
      count: number;
    };
    expect(body.count).toBe(3); // Alpha, Beta + the §5.10 Gamma flip fixture
    expect(body.modules.map((m) => m.id)).toEqual([MODULE_A_ID, MODULE_B_ID, MODULE_C_ID]);
    const beta = body.modules[1] as { options: Array<{ name: string; items?: string[] }> };
    // Combobox semantics surfaced: items listed; the stored value is the INDEX.
    const sort = beta.options.find((o) => o.name === 'SortOrder');
    expect(sort?.items).toEqual(['latest', 'oldest']);
    void makeRegistration; // fixture factory exercised by helpers
  });

  it('site-first browse join: catalogInstalled reflects the CatalogStore receipts (additive field)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/modules' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { modules: Array<{ id: string; catalogInstalled: boolean }> };
    const byId = new Map(body.modules.map((m): [string, boolean] => [m.id, m.catalogInstalled]));
    // The harness installs CATALOG_ID === MODULE_C_ID ('c'×32): exactly
    // Gamma carries catalogInstalled true; the join is LIVE (a fresh
    // install flips on the next read).
    expect(byId.get(MODULE_C_ID)).toBe(true);
    expect(byId.get(MODULE_A_ID)).toBe(false);
    expect(byId.get(MODULE_B_ID)).toBe(false);

    // Live-join proof: install MODULE_A_ID's catalog, re-read — flipped.
    h.catalogs.install(MODULE_A_ID, []);
    const after = await h.app.inject({ method: 'GET', url: '/api/modules' });
    const afterBody = after.json() as { modules: Array<{ id: string; catalogInstalled: boolean }> };
    expect(afterBody.modules.find((m) => m.id === MODULE_A_ID)?.catalogInstalled).toBe(true);
  });

  it('validation failures: none for GET (no params) — but the route 404s cleanly for unknown ids via PUT', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/modules' });
    expect(res.statusCode).toBe(200);
    const putUnknown = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${'e'.repeat(32)}`,
      payload: { enabled: false },
    });
    expect(putUnknown.statusCode).toBe(404);
    expectEnvelope(putUnknown.body, 'not_found');
  });
});

describe('PUT /api/modules/:id — §5.1 option validation matrix', (): void => {
  it('happy path: enable/disable round-trips', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    const listing = await h.app.inject({ method: 'GET', url: '/api/modules' });
    expect(listing.json().modules.find((m: { id: string }) => m.id === MODULE_A_ID)?.enabled).toBe(false);
  });

  it('happy path: cookies-only update is accepted (§9 module_state.cookies)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { cookies: 'cf_clearance=abc; session=xyz' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.modules.getCookies(MODULE_A_ID)).toBe('cf_clearance=abc; session=xyz');
  });

  it('happy path: combobox accepts a valid item INDEX (not the item text)', async (): Promise<void> => {
    const h = buildHarness();
    const ok = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { options: { Language: 2 } },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('combobox rejects the item TEXT (stores the INDEX) and out-of-range/negative indices', async (): Promise<void> => {
    const h = buildHarness();
    for (const value of ['ja', 3, -1, 1.5]) {
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/modules/${MODULE_A_ID}`,
        payload: { options: { Language: value } },
      });
      expect(res.statusCode, `Language=${String(value)}`).toBe(400);
      const err = expectEnvelope(res.body, 'validation_error');
      expect(err.message).toContain('INDEX');
      expect(err.details).toBeDefined();
    }
  });

  it('kind validation: checkbox→boolean, edit→string, spinedit→integer', async (): Promise<void> => {
    const h = buildHarness();
    const cases: Array<[string, unknown]> = [
      ['UseMobile', 'yes'],
      ['StartDate', 42],
      ['Delay', true],
    ];
    for (const [name, value] of cases) {
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/modules/${MODULE_A_ID}`,
        payload: { options: { [name]: value } },
      });
      expect(res.statusCode, `${name}=${String(value)}`).toBe(400);
      expectEnvelope(res.body, 'validation_error');
    }
    // And the correct kinds pass.
    const ok = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { options: { UseMobile: true, StartDate: '2026-01-01', Delay: 5 } },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('unknown option name is a 400 validation error', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { options: { NotAnOption: true } },
    });
    expect(res.statusCode).toBe(400);
    const err = expectEnvelope(res.body, 'validation_error');
    expect(err.message).toContain('unknown option');
  });

  it('schema-validation failures: bad id format, wrong body types, empty patch', async (): Promise<void> => {
    const h = buildHarness();
    const badId = await h.app.inject({
      method: 'PUT',
      url: '/api/modules/not-a-module-id',
      payload: { enabled: true },
    });
    expect(badId.statusCode).toBe(400);
    expectEnvelope(badId.body, 'validation_error');

    const badType = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { enabled: 'yes' },
    });
    expect(badType.statusCode).toBe(400);
    expectEnvelope(badType.body, 'validation_error');

    const empty = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expectEnvelope(empty.body, 'validation_error');
  });

  it('unknown module is a 404 envelope', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${'e'.repeat(32)}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, 'not_found');
  });

  it('service update validates options against the module descriptors (unit-level seam)', (): void => {
    const service = new InMemoryModuleService([makeRegistration({ id: MODULE_A_ID })]);
    expect(service.get(MODULE_A_ID)?.enabled).toBe(true);
    const updated = service.update(MODULE_A_ID, { enabled: false, options: { Language: 1 } });
    expect(updated.enabled).toBe(false);
    expect((): unknown => service.update(MODULE_A_ID, { options: { Language: 99 } })).toThrow(/INDEX/);
  });
});
