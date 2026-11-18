/**
 * Favorites route integration tests (§10, offline fastify.inject): the
 * CRUD surface + the auto-download toggle + the manual check-now
 * trigger + the D4 import path, against the in-memory FavoriteService
 * double. The ENGINE semantics (diff/immediate update/dual-write) are
 * golden-tested in test/jobs/favorites/; the production adapter is
 * exercised end-to-end in test/jobs/favorites/service.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, MODULE_A_ID, MODULE_B_ID } from './helpers.js';
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

  // R5 arrival (additive): `?since=` switches the per-row newsSince
  // flag on — the away-summary favorites half. The in-memory double's
  // lastCheck is the fixed '2026-01-01T00:00:00Z' stamp, which is all
  // the truth table needs (the flag compares against it).
  it('R5 `since` marks rows newsSince only when a check ran at/after it AND found chapters', async (): Promise<void> => {
    const newsy = buildHarness({
      favorites: new InMemoryFavoriteService(behavior({ newChapterCount: 3 })),
    });
    await newsy.app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: MODULE_A_ID, url: FAV_URL, title: 'Newsy' },
    });

    const quiet = buildHarness({
      favorites: new InMemoryFavoriteService(behavior({ newChapterCount: 0 })),
    });
    await quiet.app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: MODULE_A_ID, url: FAV_URL, title: 'Quiet' },
    });

    // since BEFORE the check stamp + news → newsSince: true.
    const before = await newsy.app.inject({
      method: 'GET',
      url: '/api/favorites?since=2025-12-31T00%3A00%3A00.000Z',
    });
    expect(before.statusCode).toBe(200);
    const beforeRows = before.json().favorites as Array<Record<string, unknown>>;
    expect(beforeRows[0]?.['newsSince']).toBe(true);

    // since AFTER the check stamp → the same newsy row is NOT news.
    const after = await newsy.app.inject({
      method: 'GET',
      url: '/api/favorites?since=2026-06-01T00%3A00%3A00.000Z',
    });
    expect((after.json().favorites as Array<Record<string, unknown>>)[0]?.['newsSince']).toBeUndefined();

    // a check ran at/after since but found nothing → NOT news.
    const noNews = await quiet.app.inject({
      method: 'GET',
      url: '/api/favorites?since=2025-12-31T00%3A00%3A00.000Z',
    });
    expect((noNews.json().favorites as Array<Record<string, unknown>>)[0]?.['newsSince']).toBeUndefined();

    // no since param → the flag is absent everywhere (pre-R5 shape).
    const plain = await newsy.app.inject({ method: 'GET', url: '/api/favorites' });
    expect((plain.json().favorites as Array<Record<string, unknown>>)[0]?.['newsSince']).toBeUndefined();

    // malformed since is a typed 400.
    const bad = await newsy.app.inject({ method: 'GET', url: '/api/favorites?since=yesterday' });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');
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

// Composite favorite ids are `<moduleId>/<url>` — host-relative for
// catalog-seeded favorites (§5.8), absolute for canonicalized ones —
// so the id carries slashes and crosses the wire percent-encoded
// (`%2F`). Intermediary hops (reverse proxies, the dev-preview
// tunnel) decode `%2F` into literal path slashes before the request
// arrives, splitting the id across segments; the regression below is
// the owner-reported auto-download toggle 404 on an EXISTING
// favorite (MangaPark `/title/<slug>` shape). Every id-carrying verb
// must resolve BOTH wire spellings of the SAME stored key.
describe('favorites composite ids — encoded and decoded wire forms', (): void => {
  // The owner's exact shape: host-relative catalog link on module 09d49c…
  // (normalized to the harness module for hermeticity).
  const REL_URL = '/title/351056-en-sousou-no-frieren-anthology';
  const REL_ID = `${MODULE_A_ID}${REL_URL}`;
  const encoded = (id: string): string => `/api/favorites/${encodeURIComponent(id)}`;
  const raw = (id: string, suffix = ''): string => `/api/favorites/${id}${suffix}`;

  async function seed(h: ReturnType<typeof buildHarness>, url: string): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: MODULE_A_ID, url, title: 'Seeded' },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().favorite as Record<string, unknown>).id as string;
  }

  it('PUT auto-download toggles resolve through the %2F-encoded id AND the raw decoded path', async (): Promise<void> => {
    const h = buildHarness();
    await seed(h, REL_URL);

    // Encoded form (`:id` route): the shape the browser sends.
    const on = await h.app.inject({
      method: 'PUT',
      url: encoded(REL_ID),
      payload: { autoDownload: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().favorite as Record<string, unknown>).toMatchObject({
      id: REL_ID,
      autoDownload: true,
    });

    // Raw decoded form (wildcard route): the shape a %2F-decoding hop
    // forwards — this was the 404.
    const off = await h.app.inject({
      method: 'PUT',
      url: raw(REL_ID),
      payload: { autoDownload: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().favorite as Record<string, unknown>).toMatchObject({
      id: REL_ID,
      autoDownload: false,
    });

    // Persistence: either spelling's write is visible through the other.
    await h.app.inject({ method: 'PUT', url: raw(REL_ID), payload: { autoDownload: true } });
    const readBack = await h.app.inject({ method: 'GET', url: encoded(REL_ID) });
    expect(readBack.statusCode).toBe(200);
    expect((readBack.json().favorite as Record<string, unknown>).autoDownload).toBe(true);
  });

  it('the raw decoded path resolves for GET and DELETE too (same stored row)', async (): Promise<void> => {
    const h = buildHarness();
    await seed(h, REL_URL);

    const got = await h.app.inject({ method: 'GET', url: raw(REL_ID) });
    expect(got.statusCode).toBe(200);
    expect((got.json().favorite as Record<string, unknown>).id).toBe(REL_ID);

    const del = await h.app.inject({ method: 'DELETE', url: raw(REL_ID) });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(h.favorites.get(REL_ID)).toBeUndefined();

    const again = await h.app.inject({ method: 'DELETE', url: raw(REL_ID) });
    expect(again.statusCode).toBe(404);
    expectEnvelope(again.body, 'not_found');
  });

  it('id-suffixed POST routes (/check, /transfer/preview) resolve through the raw decoded path', async (): Promise<void> => {
    const h = buildHarness({
      favorites: new InMemoryFavoriteService(
        behavior({ currentChapter: 7, newChapterCount: 1, queuedDownloads: 0 }),
      ),
    });
    await seed(h, REL_URL);

    const check = await h.app.inject({ method: 'POST', url: raw(REL_ID, '/check') });
    expect(check.statusCode).toBe(200);
    expect((check.json().favorite as Record<string, unknown>).id).toBe(REL_ID);
    expect((check.json().favorite as Record<string, unknown>).currentChapter).toBe(7);

    // Transfer preview: routing must REACH the handler (the in-memory
    // double resolves no target → typed invalid preview, never a 404).
    const preview = await h.app.inject({
      method: 'POST',
      url: raw(REL_ID, '/transfer/preview'),
      payload: { targetModuleId: MODULE_B_ID },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json() as Record<string, unknown>).toMatchObject({
      targetModuleId: MODULE_B_ID,
      valid: false,
    });
  });

  it('a canonicalized (absolute-url) favorite id resolves through both forms — :// segments included', async (): Promise<void> => {
    const h = buildHarness();
    await seed(h, FAV_URL);

    const viaEncoded = await h.app.inject({
      method: 'PUT',
      url: encoded(FAV_ID),
      payload: { autoDownload: true },
    });
    expect(viaEncoded.statusCode).toBe(200);

    const viaRaw = await h.app.inject({
      method: 'PUT',
      url: raw(FAV_ID),
      payload: { autoDownload: false },
    });
    expect(viaRaw.statusCode).toBe(200);
    expect(viaRaw.json().favorite as Record<string, unknown>).toMatchObject({
      id: FAV_ID,
      autoDownload: false,
    });
  });

  it('a double-encoded hop (%252F) still resolves the stored row', async (): Promise<void> => {
    const h = buildHarness();
    await seed(h, REL_URL);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/favorites/${encodeURIComponent(encodeURIComponent(REL_ID))}`,
      payload: { autoDownload: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().favorite as Record<string, unknown>).toMatchObject({
      id: REL_ID,
      autoDownload: true,
    });
  });

  it('the wildcard does not widen the API surface: unknown ids stay typed 404s and bare POST id paths stay route 404s', async (): Promise<void> => {
    const h = buildHarness();
    await seed(h, REL_URL);

    // Unknown favorite through either spelling: typed unknown-favorite 404.
    const missing = await h.app.inject({
      method: 'PUT',
      url: raw(`${MODULE_A_ID}/title/does-not-exist`),
      payload: { autoDownload: true },
    });
    expect(missing.statusCode).toBe(404);
    expectEnvelope(missing.body, 'not_found');

    // There is no bare `POST /api/favorites/:id` — the unsuffixed tail
    // keeps answering the route-not-found envelope.
    const bare = await h.app.inject({ method: 'POST', url: raw(REL_ID) });
    expect(bare.statusCode).toBe(404);
    expect(bare.json()).toMatchObject({ error: { code: 'not_found', message: 'route not found' } });

    // The static POST routes keep priority over the wildcard.
    const batch = await h.app.inject({
      method: 'POST',
      url: '/api/favorites/check',
      payload: { scope: 'all' },
    });
    expect(batch.statusCode).toBe(200);
    const cancel = await h.app.inject({ method: 'POST', url: '/api/favorites/check/cancel' });
    expect(cancel.statusCode).toBe(200);
  });
});
