/**
 * Favorites-parity route integration tests (§10, offline fastify.inject):
 * the batch check scope matrix + cancel (btFavoritesCheckNewChapter +
 * miFavoritesStopCheckNewChapter parity), the website transfer
 * (frmTransferFavorites: preview valid/invalid mapping — full miss
 * taxonomy — + apply remap + the typed invalid-target 409), the
 * pmFavorites row patch surface (rename / save-to / enable-disable
 * persistence + the empty-patch 400), row delete, and the settings
 * seam round-trip (interval + startup toggle) — all against the
 * in-memory FavoriteService double with an injected transfer index.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, MODULE_A_ID, MODULE_B_ID } from './helpers.js';
import {
  InMemoryFavoriteService,
  type InMemoryFavoriteCheckBehavior,
} from '../../src/api/services.js';
import type { FavoriteCheckResponseT } from '../../src/api/schemas.js';

const FAV_URL = 'https://ex.org/manga/fav';
const FAV_ID = `${MODULE_A_ID}${FAV_URL}`.toLowerCase();
const TARGET_URL = 'https://ex.org/target/match';

function transferIndex(
  moduleId: string,
  title: string,
): { url: string; title: string } | undefined {
  // The double's catalog: BetaSource knows 'My Favorite'; nothing else.
  if (moduleId === MODULE_B_ID && title === 'My Favorite') {
    return { url: TARGET_URL, title: 'My Favorite' };
  }
  return undefined;
}

async function seedFavorite(
  h: ReturnType<typeof buildHarness>,
  url: string,
  title: string,
): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/favorites',
    payload: { moduleId: MODULE_A_ID, url, title },
  });
  expect(res.statusCode).toBe(201);
  return res.json().favorite.id as string;
}

describe('POST /api/favorites/check — batch scope matrix', (): void => {
  function behavior(overrides: InMemoryFavoriteCheckBehavior = {}): (id: string) => InMemoryFavoriteCheckBehavior {
    return (_id: string): InMemoryFavoriteCheckBehavior => overrides;
  }

  it('scope=all checks every favorite (enabled and disabled alike)', async (): Promise<void> => {
    const favorites = new InMemoryFavoriteService(behavior({ newChapterCount: 2, currentChapter: 5 }));
    const h = buildHarness({ favorites });
    const a = await seedFavorite(h, FAV_URL, 'A');
    const b = await seedFavorite(h, 'https://ex.org/manga/b', 'B');
    const disabled = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(b)}`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    const res = await h.app.inject({ method: 'POST', url: '/api/favorites/check', payload: { scope: 'all' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ scope: 'all', cancelled: false, checked: 2, failed: 0 });
    expect((body['results'] as unknown[]).length).toBe(2);
    expect(a).toBeTruthy();
  });

  it('scope=enabled skips disabled rows; scope=disabled checks ONLY disabled rows', async (): Promise<void> => {
    const favorites = new InMemoryFavoriteService(behavior());
    const h = buildHarness({ favorites });
    await seedFavorite(h, FAV_URL, 'A');
    const bId = await seedFavorite(h, 'https://ex.org/manga/b', 'B');
    await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(bId)}`,
      payload: { enabled: false },
    });

    const enabled = await h.app.inject({ method: 'POST', url: '/api/favorites/check', payload: { scope: 'enabled' } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ scope: 'enabled', checked: 1 });
    expect((enabled.json().results as Array<{ favorite: { title: string } }>).map((r) => r.favorite.title)).toEqual(['A']);

    const disabled = await h.app.inject({ method: 'POST', url: '/api/favorites/check', payload: { scope: 'disabled' } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ scope: 'disabled', checked: 1 });
    expect((disabled.json().results as Array<{ favorite: { title: string } }>).map((r) => r.favorite.title)).toEqual(['B']);
  });

  it('default scope is all; a bad scope is a typed 400; the results carry the new-chapter sets', async (): Promise<void> => {
    const favorites = new InMemoryFavoriteService(
      (_id: string): InMemoryFavoriteCheckBehavior => ({
        newChapterCount: 2,
        currentChapter: 4,
        newChapters: [
          { position: 2, link: 'https://ex.org/manga/fav/ch-3', name: 'Ch. 3' },
          { position: 3, link: 'https://ex.org/manga/fav/ch-4', name: 'Ch. 4' },
        ],
      }),
    );
    const h = buildHarness({ favorites });
    await seedFavorite(h, FAV_URL, 'A');

    const defaulted = await h.app.inject({ method: 'POST', url: '/api/favorites/check', payload: {} });
    expect(defaulted.statusCode).toBe(200);
    const results = defaulted.json().results as Array<{ newChapters: unknown[]; favorite: { newChapterCount: number } }>;
    expect(results[0]?.newChapters.length).toBe(2);
    expect(results[0]?.favorite.newChapterCount).toBe(2);

    const bad = await h.app.inject({ method: 'POST', url: '/api/favorites/check', payload: { scope: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');
  });

  it('cancel stops the sweep between rows (completed rows keep their results)', async (): Promise<void> => {
    // Gate the FIRST favorite's check so the cancel lands mid-run.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });
    // Deterministic mid-run signal: flips the moment the sweep ENTERS the
    // gated row (before it awaits the gate) — the blind 10ms sleep raced
    // the sweep start under CI load and cancel found nothing running.
    let enteredGatedRow = false;
    const favorites = new (class extends InMemoryFavoriteService {
      public override async checkNow(id: string): Promise<FavoriteCheckResponseT> {
        if (id.endsWith('a')) {
          enteredGatedRow = true;
          await gate;
        }
        return super.checkNow(id);
      }
    })();
    const h = buildHarness({ favorites });
    await seedFavorite(h, 'https://ex.org/manga/a', 'slow-row');
    await seedFavorite(h, 'https://ex.org/manga/b', 'never-reached');

    const pending = h.app.inject({ method: 'POST', url: '/api/favorites/check', payload: { scope: 'all' } });
    // Wait for observable in-flight evidence (sweep inside the gated row),
    // bounded — never a fixed sleep racing the scheduler.
    for (let i = 0; i < 500 && !enteredGatedRow; i += 1) {
      await new Promise((resolve): void => {
        setTimeout(resolve, 5);
      });
    }
    expect(enteredGatedRow).toBe(true);
    const cancel = await h.app.inject({ method: 'POST', url: '/api/favorites/check/cancel' });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ cancelled: true });
    release?.();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cancelled: true, checked: 1 });
    const results = res.json().results as Array<{ favorite: { title: string } }>;
    expect(results.map((r) => r.favorite.title)).toEqual(['slow-row']);
  });

  it('cancel is idempotent (false when nothing is running)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/favorites/check/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: false });
  });
});

describe('POST /api/favorites/:id/transfer — website transfer', (): void => {
  function harness(): ReturnType<typeof buildHarness> {
    return buildHarness({ favorites: new InMemoryFavoriteService(undefined, transferIndex) });
  }

  it('preview resolves a valid mapping (title match on the target site)', async (): Promise<void> => {
    const h = harness();
    await seedFavorite(h, FAV_URL, 'My Favorite');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/transfer/preview`,
      payload: { targetModuleId: MODULE_B_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      targetModuleId: MODULE_B_ID,
      valid: true,
      targetUrl: TARGET_URL,
      matchedTitle: 'My Favorite',
    });
  });

  it('preview reports invalid with a reason (no title match)', async (): Promise<void> => {
    const h = harness();
    await seedFavorite(h, FAV_URL, 'Unknown Title');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/transfer/preview`,
      payload: { targetModuleId: MODULE_B_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: false, targetUrl: null, reason: 'not-found' });
  });

  it('apply remaps the favorite onto the target module+link under a new id', async (): Promise<void> => {
    const h = harness();
    await seedFavorite(h, FAV_URL, 'My Favorite');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/transfer`,
      payload: { targetModuleId: MODULE_B_ID, clearDownloadedList: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      favorite: { moduleId: MODULE_B_ID, url: TARGET_URL, title: 'My Favorite' },
      reloadedFromServer: false,
    });
    const newId = res.json().favorite.id as string;
    expect(newId).toBe(`${MODULE_B_ID}${TARGET_URL}`.toLowerCase());

    // The OLD id is gone; exactly one row remains.
    const old = await h.app.inject({ method: 'GET', url: `/api/favorites/${encodeURIComponent(FAV_ID)}` });
    expect(old.statusCode).toBe(404);
    const list = await h.app.inject({ method: 'GET', url: '/api/favorites' });
    expect((list.json().favorites as unknown[]).length).toBe(1);
  });

  it('an invalid target is a typed 409 (never a silent remap)', async (): Promise<void> => {
    const h = harness();
    await seedFavorite(h, FAV_URL, 'My Favorite');
    // MODULE_A has no transfer index entry → invalid mapping.
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/transfer`,
      payload: { targetModuleId: MODULE_A_ID, clearDownloadedList: false },
    });
    expect(res.statusCode).toBe(409);
    expectEnvelope(res.body, 'conflict');
    // The favorite is untouched.
    const still = await h.app.inject({ method: 'GET', url: `/api/favorites/${encodeURIComponent(FAV_ID)}` });
    expect(still.statusCode).toBe(200);
  });

  it('clearDownloadedList reports the tag-100 reload', async (): Promise<void> => {
    const h = harness();
    await seedFavorite(h, FAV_URL, 'My Favorite');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/transfer`,
      payload: { targetModuleId: MODULE_B_ID, clearDownloadedList: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reloadedFromServer: true });
  });

  it('preview surfaces the full miss taxonomy (no-catalog / get-info-failed) and apply stays a typed 409', async (): Promise<void> => {
    // Targets beyond the fake catalog: reason-bearing misses mirror the
    // engine taxonomy (real-store coverage: service.test.ts).
    const NO_CATALOG = 'c'.repeat(32);
    const GET_INFO_FAILED = 'd'.repeat(32);
    const h = buildHarness({
      favorites: new InMemoryFavoriteService(undefined, (moduleId, title) => {
        if (moduleId === NO_CATALOG) {
          return { reason: 'no-catalog' };
        }
        if (moduleId === GET_INFO_FAILED) {
          return { reason: 'get-info-failed' };
        }
        return transferIndex(moduleId, title);
      }),
    });
    await seedFavorite(h, FAV_URL, 'My Favorite');

    const noCatalog = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/transfer/preview`,
      payload: { targetModuleId: NO_CATALOG },
    });
    expect(noCatalog.statusCode).toBe(200);
    expect(noCatalog.json()).toMatchObject({ valid: false, targetUrl: null, reason: 'no-catalog' });

    const getInfoFailed = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/transfer/preview`,
      payload: { targetModuleId: GET_INFO_FAILED },
    });
    expect(getInfoFailed.statusCode).toBe(200);
    expect(getInfoFailed.json()).toMatchObject({ valid: false, targetUrl: null, reason: 'get-info-failed' });

    // An invalid mapping NEVER silently remaps: apply refuses with the
    // typed 409 and the favorite is untouched.
    const apply = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/transfer`,
      payload: { targetModuleId: NO_CATALOG, clearDownloadedList: false },
    });
    expect(apply.statusCode).toBe(409);
    expectEnvelope(apply.body, 'conflict');
    const still = await h.app.inject({ method: 'GET', url: `/api/favorites/${encodeURIComponent(FAV_ID)}` });
    expect(still.statusCode).toBe(200);
  });

  it('unknown favorite is a typed 404 on both routes', async (): Promise<void> => {
    const h = harness();
    const preview = await h.app.inject({
      method: 'POST',
      url: '/api/favorites/nope/transfer/preview',
      payload: { targetModuleId: MODULE_B_ID },
    });
    expect(preview.statusCode).toBe(404);
    const apply = await h.app.inject({
      method: 'POST',
      url: '/api/favorites/nope/transfer',
      payload: { targetModuleId: MODULE_B_ID },
    });
    expect(apply.statusCode).toBe(404);
  });
});

describe('PUT /api/favorites/:id — rename / save-to / enable (pmFavorites parity)', (): void => {
  it('rename persists and the listing reflects it', async (): Promise<void> => {
    const h = buildHarness();
    await seedFavorite(h, FAV_URL, 'Old Name');
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}`,
      payload: { title: 'New Name' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().favorite).toMatchObject({ title: 'New Name' });
    const list = await h.app.inject({ method: 'GET', url: '/api/favorites' });
    expect((list.json().favorites as Array<{ title: string }>)[0]?.title).toBe('New Name');
  });

  it('saveTo persists (and an empty string resets it)', async (): Promise<void> => {
    const h = buildHarness();
    await seedFavorite(h, FAV_URL, 'A');
    const set = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}`,
      payload: { saveTo: '/custom/dir' },
    });
    expect(set.json().favorite).toMatchObject({ saveTo: '/custom/dir' });
    const reset = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}`,
      payload: { saveTo: '' },
    });
    expect(reset.json().favorite).toMatchObject({ saveTo: '' });
    const list = await h.app.inject({ method: 'GET', url: '/api/favorites' });
    expect((list.json().favorites as Array<{ saveTo: string }>)[0]?.saveTo).toBe('');
  });

  it('enable/disable persists and feeds the batch scopes', async (): Promise<void> => {
    const h = buildHarness();
    await seedFavorite(h, FAV_URL, 'A');
    const off = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}`,
      payload: { enabled: false },
    });
    expect(off.json().favorite).toMatchObject({ enabled: false });
    const disabledOnly = await h.app.inject({ method: 'POST', url: '/api/favorites/check', payload: { scope: 'disabled' } });
    expect(disabledOnly.json()).toMatchObject({ checked: 1 });
    const enabledOnly = await h.app.inject({ method: 'POST', url: '/api/favorites/check', payload: { scope: 'enabled' } });
    expect(enabledOnly.json()).toMatchObject({ checked: 0 });
  });

  it('the listing carries the new columns (saveTo/enabled/dateAdded)', async (): Promise<void> => {
    const h = buildHarness();
    await seedFavorite(h, FAV_URL, 'A');
    const list = await h.app.inject({ method: 'GET', url: '/api/favorites' });
    const row = (list.json().favorites as Array<Record<string, unknown>>)[0];
    expect(row?.['saveTo']).toBeNull();
    expect(row?.['enabled']).toBe(true);
    expect(typeof row?.['dateAdded']).toBe('string');
  });

  it('an empty patch is a typed 400 (the guard knows title/autoDownload/saveTo/enabled)', async (): Promise<void> => {
    const h = buildHarness();
    await seedFavorite(h, FAV_URL, 'A');
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'validation_error');
  });
});

describe('DELETE /api/favorites/:id — row delete (miFavoritesDelete parity)', (): void => {
  it('removes the row; the listing drops it; a repeat delete is a typed 404', async (): Promise<void> => {
    const h = buildHarness();
    await seedFavorite(h, FAV_URL, 'A');
    const del = await h.app.inject({ method: 'DELETE', url: `/api/favorites/${encodeURIComponent(FAV_ID)}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    const list = await h.app.inject({ method: 'GET', url: '/api/favorites' });
    expect(list.json().favorites).toHaveLength(0);
    const again = await h.app.inject({ method: 'DELETE', url: `/api/favorites/${encodeURIComponent(FAV_ID)}` });
    expect(again.statusCode).toBe(404);
    expectEnvelope(again.body, 'not_found');
  });

  it('an unknown id is a typed 404 (nothing else is affected)', async (): Promise<void> => {
    const h = buildHarness();
    const kept = await seedFavorite(h, FAV_URL, 'A');
    const res = await h.app.inject({ method: 'DELETE', url: '/api/favorites/nope' });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, 'not_found');
    const list = await h.app.inject({ method: 'GET', url: '/api/favorites' });
    expect((list.json().favorites as Array<{ id: string }>).map((f) => f.id)).toEqual([kept]);
  });
});

describe('PUT /api/settings/favorites — scheduler settings', (): void => {
  it('round-trips interval + startup toggle through GET /api/settings', async (): Promise<void> => {
    const h = buildHarness();
    const before = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(before.json().favorites).toEqual({ intervalMinutes: 60, checkAtStartup: true });

    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/favorites',
      payload: { intervalMinutes: 30, checkAtStartup: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().favorites).toEqual({ intervalMinutes: 30, checkAtStartup: false });

    const after = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().favorites).toEqual({ intervalMinutes: 30, checkAtStartup: false });
  });

  it('interval 0 is legal (scheduled checks off); a negative or huge value is a 400', async (): Promise<void> => {
    const h = buildHarness();
    const zero = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/favorites',
      payload: { intervalMinutes: 0, checkAtStartup: true },
    });
    expect(zero.statusCode).toBe(200);
    expect(zero.json().favorites).toEqual({ intervalMinutes: 0, checkAtStartup: true });

    const bad = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/favorites',
      payload: { intervalMinutes: -5, checkAtStartup: true },
    });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');
  });
});
