/**
 * Favorites route integration tests (§10, offline fastify.inject): the
 * CRUD surface + the auto-download toggle + the manual check-now
 * trigger + the D4 import path, against the in-memory FavoriteService
 * double. The ENGINE semantics (diff/immediate update/dual-write) are
 * golden-tested in test/jobs/favorites/; the production adapter is
 * exercised end-to-end in test/jobs/favorites/service.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, MODULE_A_ID } from './helpers.js';
import {
  InMemoryFavoriteService,
  type InMemoryFavoriteCheckBehavior,
} from '../../src/api/services.js';

const FAV_URL = 'https://ex.org/manga/fav';
const FAV_ID = `${MODULE_A_ID}${FAV_URL}`.toLowerCase();

function behavior(overrides: InMemoryFavoriteCheckBehavior = {}): (id: string) => InMemoryFavoriteCheckBehavior {
  return (_id: string): InMemoryFavoriteCheckBehavior => overrides;
}

describe('POST /api/favorites — create', (): void => {
  it('creates a favorite (201, autoDownload default false, no new chapters yet)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: MODULE_A_ID, url: FAV_URL, title: 'My Favorite' },
    });
    expect(res.statusCode).toBe(201);
    const favorite = res.json().favorite as Record<string, unknown>;
    expect(favorite.id).toBe(FAV_ID);
    expect(favorite.moduleId).toBe(MODULE_A_ID);
    expect(favorite.url).toBe(FAV_URL);
    expect(favorite.title).toBe('My Favorite');
    expect(favorite.autoDownload).toBe(false);
    expect(favorite.newChapterCount).toBe(0);
    expect(favorite.currentChapter).toBeNull();
  });

  it('an explicit autoDownload flag is honored', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: MODULE_A_ID, url: FAV_URL, autoDownload: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().favorite as Record<string, unknown>).toMatchObject({ autoDownload: true });
  });

  it('a duplicate (same moduleId+url) is a 409 conflict', async (): Promise<void> => {
    const h = buildHarness();
    const body = { moduleId: MODULE_A_ID, url: FAV_URL };
    expect((await h.app.inject({ method: 'POST', url: '/api/favorites', payload: body })).statusCode).toBe(201);
    const second = await h.app.inject({ method: 'POST', url: '/api/favorites', payload: body });
    expect(second.statusCode).toBe(409);
    expectEnvelope(second.body, 'conflict');
  });

  it('a bad body is a typed 400 (unknown module id, missing url)', async (): Promise<void> => {
    const h = buildHarness();
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: 'not-hex', url: '' },
    });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');
  });
});

describe('GET /api/favorites (+ /:id) — listing', (): void => {
  it('lists favorites in insertion order with the badge count', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({ method: 'POST', url: '/api/favorites', payload: { moduleId: MODULE_A_ID, url: FAV_URL } });
    await h.app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: MODULE_A_ID, url: 'https://ex.org/manga/second' },
    });
    const res = await h.app.inject({ method: 'GET', url: '/api/favorites' });
    expect(res.statusCode).toBe(200);
    const favorites = res.json().favorites as Array<Record<string, unknown>>;
    expect(favorites.map((f) => f.url)).toEqual([FAV_URL, 'https://ex.org/manga/second']);
  });

  it('returns one favorite and a typed 404 for an unknown id', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({ method: 'POST', url: '/api/favorites', payload: { moduleId: MODULE_A_ID, url: FAV_URL } });
    const ok = await h.app.inject({ method: 'GET', url: `/api/favorites/${encodeURIComponent(FAV_ID)}` });
    expect(ok.statusCode).toBe(200);
    expect((ok.json().favorite as Record<string, unknown>).id).toBe(FAV_ID);

    const missing = await h.app.inject({ method: 'GET', url: '/api/favorites/nope' });
    expect(missing.statusCode).toBe(404);
    expectEnvelope(missing.body, 'not_found');
  });
});

describe('PUT /api/favorites/:id — title + auto-download toggle', (): void => {
  it('toggles autoDownload true→false without touching other fields', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: MODULE_A_ID, url: FAV_URL, title: 'Original', autoDownload: false },
    });
    const on = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}`,
      payload: { autoDownload: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().favorite as Record<string, unknown>).toMatchObject({ autoDownload: true, title: 'Original' });

    const off = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}`,
      payload: { autoDownload: false, title: 'Renamed' },
    });
    expect(off.json().favorite as Record<string, unknown>).toMatchObject({ autoDownload: false, title: 'Renamed' });
  });

  it('an empty patch is a 400; an unknown id is a 404', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({ method: 'POST', url: '/api/favorites', payload: { moduleId: MODULE_A_ID, url: FAV_URL } });
    const empty = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expectEnvelope(empty.body, 'validation_error');

    const missing = await h.app.inject({
      method: 'PUT',
      url: '/api/favorites/unknown',
      payload: { autoDownload: true },
    });
    expect(missing.statusCode).toBe(404);
    expectEnvelope(missing.body, 'not_found');
  });
});

describe('DELETE /api/favorites/:id', (): void => {
  it('deletes the favorite; a repeat delete is a 404', async (): Promise<void> => {
    const h = buildHarness();
    await h.app.inject({ method: 'POST', url: '/api/favorites', payload: { moduleId: MODULE_A_ID, url: FAV_URL } });
    const del = await h.app.inject({ method: 'DELETE', url: `/api/favorites/${encodeURIComponent(FAV_ID)}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(h.favorites.get(FAV_ID)).toBeUndefined();

    const again = await h.app.inject({ method: 'DELETE', url: `/api/favorites/${encodeURIComponent(FAV_ID)}` });
    expect(again.statusCode).toBe(404);
    expectEnvelope(again.body, 'not_found');
  });
});

describe('POST /api/favorites/:id/check — manual check-now trigger', (): void => {
  it('returns the updated favorite, the queued download count and the new-chapter set', async (): Promise<void> => {
    // canned engine behavior: the live check found 2 chapters (both new),
    // 1 download queued (auto-download was on)
    const h = buildHarness({
      favorites: new InMemoryFavoriteService(
        behavior({
          currentChapter: 2,
          newChapterCount: 2,
          status: 'Ongoing',
          queuedDownloads: 1,
          newChapters: [
            { position: 0, link: 'https://ex.org/manga/fav/1', name: 'Ch. 1' },
            { position: 1, link: 'https://ex.org/manga/fav/2', name: 'Ch. 2' },
          ],
        }),
      ),
    });
    await h.app.inject({ method: 'POST', url: '/api/favorites', payload: { moduleId: MODULE_A_ID, url: FAV_URL } });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/favorites/${encodeURIComponent(FAV_ID)}/check`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      favorite: Record<string, unknown>;
      queuedDownloads: number;
      newChapters: Array<{ position: number; link: string; name: string }>;
    };
    expect(body.favorite.id).toBe(FAV_ID);
    expect(body.favorite.currentChapter).toBe(2);
    expect(body.favorite.newChapterCount).toBe(2);
    expect(body.favorite.status).toBe('Ongoing');
    expect(body.queuedDownloads).toBe(1);
    expect(body.newChapters).toEqual([
      { position: 0, link: 'https://ex.org/manga/fav/1', name: 'Ch. 1' },
      { position: 1, link: 'https://ex.org/manga/fav/2', name: 'Ch. 2' },
    ]);
    // the badge persists on the listing
    const list = await h.app.inject({ method: 'GET', url: '/api/favorites' });
    expect((list.json().favorites as Array<Record<string, unknown>>)[0]?.newChapterCount).toBe(2);
  });

  it('a check on an unknown favorite is a typed 404', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/favorites/unknown/check' });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, 'not_found');
  });
});

describe('POST /api/favorites/import — D4 transfer-favorite path', (): void => {
  it('creates a favorite through the import path (201)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/favorites/import',
      payload: { moduleId: MODULE_A_ID, url: FAV_URL, title: 'Transferred' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().favorite as Record<string, unknown>).toMatchObject({
      id: FAV_ID,
      title: 'Transferred',
    });
  });
});
