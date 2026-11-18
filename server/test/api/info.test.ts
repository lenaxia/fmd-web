/**
 * POST /api/info integration tests (§10): normalized §5.8 live info +
 * response caching semantics.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, FakeInfoService, makeRegistration, MODULE_A_ID, MODULE_B_ID } from './helpers.js';

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
    // [parity-sweep] M14: a url-only body is now VALID input (host
    // resolution) — a relative/non-http URL is the validation case…
    const relative = await h.app.inject({ method: 'POST', url: '/api/info', payload: { url: 'not-a-url' } });
    expect(relative.statusCode).toBe(400);
    expectEnvelope(relative.body, 'validation_error');
    const ftp = await h.app.inject({ method: 'POST', url: '/api/info', payload: { url: 'ftp://ex.org/x' } });
    expect(ftp.statusCode).toBe(400);
    expectEnvelope(ftp.body, 'validation_error');

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

describe('[parity-sweep] M14 — open-by-URL host resolution (FMD2 edURL parity)', (): void => {
  const SITE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111';
  const TWIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa2222';

  it('url-only resolves the module by RootURL host and serves the info', async (): Promise<void> => {
    // A dedicated site registration on its OWN host + a fake info
    // service that knows it (extras 404 at the seam otherwise).
    const h = buildHarness({
      extraRegistrations: [makeRegistration({ id: SITE, name: 'HostSite', rootURL: 'https://manga.example.dev' })],
      info: new FakeInfoService([MODULE_A_ID, MODULE_B_ID, SITE]),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { url: 'https://manga.example.dev/series/one-piece' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { moduleId: string; url: string };
    // The response carries the RESOLVED module id (client navigation).
    expect(body.moduleId).toBe(SITE);
    // The engine saw the resolved id, not an empty one.
    expect(h.info.calls.some((call): boolean => call.moduleId === SITE)).toBe(true);
  });

  it('host match is case-insensitive and port-insensitive', async (): Promise<void> => {
    const h = buildHarness({
      extraRegistrations: [makeRegistration({ id: SITE, name: 'HostSite', rootURL: 'https://Manga.Example.DEV' })],
      info: new FakeInfoService([MODULE_A_ID, MODULE_B_ID, SITE]),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { url: 'http://manga.example.dev:8080/series/x' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { moduleId: string }).moduleId).toBe(SITE);
  });

  it('unknown host → typed 400 no_site_match ("no site matches this URL")', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { url: 'https://nowhere.example.invalid/manga/x' },
    });
    expect(res.statusCode).toBe(400);
    const err = expectEnvelope(res.body, 'no_site_match');
    expect(err.message).toContain('no site matches this URL');
    expect(h.info.calls).toHaveLength(0);
  });

  it('ambiguous host (two modules, one RootURL host) → typed 400 ambiguous_site naming both', async (): Promise<void> => {
    const h = buildHarness({
      extraRegistrations: [
        makeRegistration({ id: SITE, name: 'TwinA', rootURL: 'https://twins.example.dev' }),
        makeRegistration({ id: TWIN, name: 'TwinB', rootURL: 'https://twins.example.dev' }),
      ],
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { url: 'https://twins.example.dev/manga/x' },
    });
    expect(res.statusCode).toBe(400);
    const err = expectEnvelope(res.body, 'ambiguous_site');
    expect(err.message).toContain('TwinA');
    expect(err.message).toContain('TwinB');
    expect(h.info.calls).toHaveLength(0);
  });

  it('an explicit moduleId still wins (no host resolution attempted)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: MODULE_A_ID, url: 'https://ex.org/manga/x' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { moduleId: string }).moduleId).toBe(MODULE_A_ID);
  });

  it('url-only responses are cached under the RESOLVED (moduleId,url) key', async (): Promise<void> => {
    const h = buildHarness({
      infoTtlMs: 10_000,
      extraRegistrations: [makeRegistration({ id: SITE, name: 'HostSite', rootURL: 'https://manga.example.dev' })],
      info: new FakeInfoService([MODULE_A_ID, MODULE_B_ID, SITE]),
    });
    const r1 = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { url: 'https://manga.example.dev/series/y' },
    });
    const r2 = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: SITE, url: 'https://manga.example.dev/series/y' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.body).toBe(r1.body);
    expect(h.info.calls).toHaveLength(1);
  });
});

describe('host-relative catalog urls with an explicit moduleId (FMD2 MaybeFillHost parity)', (): void => {
  // FMD2-DB catalog links are stored HOST-RELATIVE (§5.8
  // RemoveHostFromURLsPair): the client posts them raw and the SERVER
  // joins them against the module's RootURL — never a 400 url-shape
  // rejection (observed live: catalog row → POST /api/info → 400
  // "url must be an absolute http(s) URL").
  const MODULE_A_ROOT = 'https://example.org'; // makeRegistration default

  it('a relative url + moduleId is joined against the module rootURL (200, canonical url to the engine)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: MODULE_A_ID, url: '/title/116496-en-null' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.info.calls).toEqual([
      { moduleId: MODULE_A_ID, url: `${MODULE_A_ROOT}/title/116496-en-null` },
    ]);
    // The response echoes the CANONICAL absolute url.
    expect((res.json() as { url: string }).url).toBe(`${MODULE_A_ROOT}/title/116496-en-null`);
  });

  it('cache-key convergence: the relative request and its absolute equivalent share ONE snapshot', async (): Promise<void> => {
    const h = buildHarness({ infoTtlMs: 10_000 });
    const r1 = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: MODULE_A_ID, url: '/manga/rel' },
    });
    const r2 = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: MODULE_A_ID, url: `${MODULE_A_ROOT}/manga/rel` },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.body).toBe(r1.body);
    expect(h.info.calls).toHaveLength(1);
  });

  it('the downloaded-chapters ledger is keyed by the CANONICAL url (relative request sees it)', async (): Promise<void> => {
    const h = buildHarness();
    h.library.setDownloadedChapters(MODULE_A_ID, `${MODULE_A_ROOT}/manga/ledger`, ['https://example.org/ch/1']);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { moduleId: MODULE_A_ID, url: '/manga/ledger' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { downloaded: string[] }).downloaded).toEqual(['https://example.org/ch/1']);
  });

  it('a relative url WITHOUT a moduleId is still the M14 validation case (host resolution needs absolute)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/info',
      payload: { url: '/title/116496-en-null' },
    });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'validation_error');
    expect(h.info.calls).toHaveLength(0);
  });
});
