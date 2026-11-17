/**
 * POST /api/modules/bulk integration tests (settings-parity, FMD2
 * Websites-tree parity pas:6400): bulk enable/disable by category
 * rewrites module_state through the SAME update seam; the global form
 * (no category/ids) is Select-all/None; the ids form is the explicit
 * batch. Option/cookie/proxy state is untouched.
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

describe('POST /api/modules/bulk', (): void => {
  it('bulk enable/disable by CATEGORY rewrites module_state (every row in the category flips)', async (): Promise<void> => {
    const h = buildHarness();
    h.modules.update(MODULE_A_ID, { enabled: false });
    h.modules.update(MODULE_B_ID, { enabled: false });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: true, category: 'Manga' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { updated: number; modules: Array<{ id: string; enabled: boolean }> };
    expect(body.updated).toBe(3);
    expect(body.modules.every((m): boolean => m.enabled)).toBe(true);

    // module_state IS the registry read: GET /api/modules reflects it.
    const list = await h.app.inject({ method: 'GET', url: '/api/modules' });
    const rows = (list.json() as { modules: Array<{ id: string; enabled: boolean }> }).modules;
    expect(rows.filter((m): boolean => m.enabled).map((m): string => m.id)).toEqual([
      MODULE_A_ID,
      MODULE_B_ID,
      MODULE_C_ID,
    ]);

    // And back: disable the whole category.
    const off = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: false, category: 'Manga' },
    });
    expect(off.statusCode).toBe(200);
    const rowsAfter = (
      (await h.app.inject({ method: 'GET', url: '/api/modules' })).json() as {
        modules: Array<{ enabled: boolean }>;
      }
    ).modules;
    expect(rowsAfter.every((m): boolean => !m.enabled)).toBe(true);
  });

  it('category targeting is EXACT: other categories untouched', async (): Promise<void> => {
    const h = buildHarness({
      extraRegistrations: [makeRegistration({ id: 'd'.repeat(32), name: 'DeltaRaw', category: 'Raw' })],
    });
    await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: false, category: 'Manga' },
    });
    const list = (
      (await h.app.inject({ method: 'GET', url: '/api/modules' })).json() as {
        modules: Array<{ id: string; enabled: boolean }>;
      }
    ).modules;
    const byId = new Map(list.map((m): [string, boolean] => [m.id, m.enabled]));
    expect(byId.get(MODULE_A_ID)).toBe(false);
    expect(byId.get('d'.repeat(32))).toBe(true);
  });

  it('GLOBAL form (no category/ids) is FMD2 Select-all/None over EVERY module', async (): Promise<void> => {
    const h = buildHarness();
    const off = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { updated: number }).updated).toBe(3);
    const none = (
      (await h.app.inject({ method: 'GET', url: '/api/modules' })).json() as {
        modules: Array<{ enabled: boolean }>;
      }
    ).modules;
    expect(none.every((m): boolean => !m.enabled)).toBe(true);

    const on = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: true },
    });
    expect((on.json() as { updated: number }).updated).toBe(3);
  });

  it('ids form targets explicit modules only', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: false, ids: [MODULE_A_ID, MODULE_C_ID] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { updated: number }).updated).toBe(2);
    const list = (
      (await h.app.inject({ method: 'GET', url: '/api/modules' })).json() as {
        modules: Array<{ id: string; enabled: boolean }>;
      }
    ).modules;
    const byId = new Map(list.map((m): [string, boolean] => [m.id, m.enabled]));
    expect(byId.get(MODULE_A_ID)).toBe(false);
    expect(byId.get(MODULE_B_ID)).toBe(true);
    expect(byId.get(MODULE_C_ID)).toBe(false);
  });

  it('bulk writes never touch cookies/proxy module_state', async (): Promise<void> => {
    const h = buildHarness();
    h.modules.update(MODULE_A_ID, {
      options: { UseMobile: true },
      cookies: 'session=kept',
      proxy: { type: 'HTTP', host: 'upstream.example', port: '8080', user: '', pass: '' },
    });
    await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: false, category: 'Manga' },
    });
    const row = (
      (await h.app.inject({ method: 'GET', url: '/api/modules' })).json() as {
        modules: Array<{ id: string; enabled: boolean }>;
      }
    ).modules.find((m): boolean => m.id === MODULE_A_ID);
    expect(row?.enabled).toBe(false);
    // The stored §9 state the bulk seam must NOT rewrite survives.
    expect(h.modules.getCookies(MODULE_A_ID)).toBe('session=kept');
    expect(h.modules.getProxyOverride(MODULE_A_ID)).toEqual({
      type: 'HTTP',
      host: 'upstream.example',
      port: '8080',
      user: '',
      pass: '',
    });
  });

  it('unknown category / unknown ids resolve to an EMPTY set (updated 0, never 404)', async (): Promise<void> => {
    const h = buildHarness();
    const unknownCategory = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: true, category: 'Does Not Exist' },
    });
    expect(unknownCategory.statusCode).toBe(200);
    expect((unknownCategory.json() as { updated: number }).updated).toBe(0);
    const unknownIds = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: true, ids: ['e'.repeat(32)] },
    });
    expect(unknownIds.statusCode).toBe(200);
    expect((unknownIds.json() as { updated: number }).updated).toBe(0);
  });

  it('validation: missing enabled / malformed ids are 400 envelopes', async (): Promise<void> => {
    const h = buildHarness();
    const noEnabled = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { category: 'Manga' },
    });
    expect(noEnabled.statusCode).toBe(400);
    expectEnvelope(noEnabled.body, 'validation_error');
    const badId = await h.app.inject({
      method: 'POST',
      url: '/api/modules/bulk',
      payload: { enabled: true, ids: ['not-hex'] },
    });
    expect(badId.statusCode).toBe(400);
    expectEnvelope(badId.body, 'validation_error');
  });
});
