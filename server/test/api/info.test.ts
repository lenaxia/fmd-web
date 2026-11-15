/**
 * POST /api/info integration tests (§10): normalized §5.8 live info +
 * response caching semantics.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, FakeInfoService, MODULE_A_ID, MODULE_B_ID } from './helpers.js';

const BODY = { moduleId: MODULE_A_ID, url: 'https://ex.org/manga/x' };

describe('POST /api/info — normalized live info', (): void => {
  it('happy path: the §5.8 normalized MANGAINFO state', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      title: 'Fixture Manga',
      altTitles: 'Fixtured',
      authors: 'Author',
      artists: 'Artist',
      genres: 'Action',
      status: 'Ongoing',
      summary: 'Summary',
      coverLink: 'https://img.example/cover.png',
      url: BODY.url,
      link: 'https://ex.org/manga/fixture',
      chapterLinks: ['https://ex.org/ch/1', 'https://ex.org/ch/2'],
      chapterNames: ['Ch. 1', 'Ch. 2'],
      numChapter: 2,
    });
  });

  it('response caching: the same (moduleId,url) hits the cache within the TTL', async (): Promise<void> => {
    const h = buildHarness({ infoTtlMs: 10_000 });
    const r1 = await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    const r2 = await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.body).toBe(r1.body);
    expect(h.info.calls).toHaveLength(1);

    // A different URL is a different cache key → service runs again.
    await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: MODULE_A_ID, url: 'https://ex.org/manga/y' },
    });
    expect(h.info.calls).toHaveLength(2);
  });

  it('cache entries expire after the TTL (service runs again)', async (): Promise<void> => {
    const h = buildHarness({ infoTtlMs: 20 });
    await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect(h.info.calls).toHaveLength(1);
    await new Promise<void>((r): void => {
      setTimeout(r, 40);
    });
    await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect(h.info.calls).toHaveLength(2);
  });

  it('unknown module is a 404 envelope (typed from the service seam)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: 'e'.repeat(32), url: 'https://x' },
    });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, 'not_found');
  });

  it('engine failures (non-Api errors) map to 502 upstream_error', async (): Promise<void> => {
    const failing = new FakeInfoService([MODULE_A_ID, MODULE_B_ID]);
    failing.getInfo = async (): Promise<never> => {
      throw new Error('engine oom');
    };
    const h = buildHarness({ info: failing });
    const res = await h.app.inject({ method: 'POST', url: '/api/info', payload: BODY });
    expect(res.statusCode).toBe(502);
    expectEnvelope(res.body, 'upstream_error');
  });

  it('validation failures: missing fields and bad moduleId format', async (): Promise<void> => {
    const h = buildHarness();
    const missing = await h.app.inject({ method: 'POST', url: '/api/info', payload: { url: 'https://x' } });
    expect(missing.statusCode).toBe(400);
    expectEnvelope(missing.body, 'validation_error');

    const badId = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: 'short', url: 'https://x' },
    });
    expect(badId.statusCode).toBe(400);
    const err = expectEnvelope(badId.body, 'validation_error');
    expect(JSON.stringify(err.details)).toContain('32-hex');

    const emptyUrl = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: MODULE_A_ID, url: '' },
    });
    expect(emptyUrl.statusCode).toBe(400);
    expectEnvelope(emptyUrl.body, 'validation_error');

    expect(h.info.calls).toHaveLength(0); // validation runs before the service
  });
});
