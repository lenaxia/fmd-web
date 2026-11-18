/**
 * Cover proxy contract (covers live-defect): the same-origin seam the
 * SPA's `img-src 'self'` posture demands. Pinned here against a REAL
 * loopback origin (the hermetic posture the engine transport also
 * grants loopback):
 *
 *   - 200 + upstream content-type + cache-control derived from the url
 *     token ttl (1h floor, 24h cap) and the Referer hotlink posture
 *     (the origin 403s any hop without Referer = the module RootURL —
 *     the fmcdn behavior the 513ddfb download seam documented);
 *   - the deliberate http fallback for https-less origins (an http://
 *     url upgrades to https first; the TLS-refusing loopback origin
 *     proves the fallback);
 *   - NEVER an open proxy: foreign/malformed urls and credential urls
 *     are typed 400s, non-loopback hosts outside FMD_HTTP_ALLOW_HOSTS
 *     are typed 502s, unknown modules the typed 404 envelope;
 *   - non-image content types and failed origin hops are typed 502s;
 *   - the FMD_WEB_DATA_DIR/covers disk cache is keyed by the
 *     TOKEN-FREE normalized url (re-issued tokens hit; scheme-
 *     insensitive) and prunes oldest-first over the byte cap;
 *   - plain GET: never credential-gated (the *arr ordering).
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { createDefaultServices, type ApiServices } from '../../src/main.js';
import {
  CoverProxyService,
  coverCacheKey,
  coverMaxAgeSeconds,
  permittedCoverHostSuffixes,
  registrableDomain,
} from '../../src/api/cover-proxy.js';
import { InMemoryModuleService } from '../../src/api/services.js';
import { expectEnvelope, makeRegistration } from './helpers.js';

const MODULE_ID = 'a'.repeat(32);
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

/**
 * The loopback cover origin: counts hits per cover family, enforces
 * the Referer hotlink check, and is deliberately http-only (no TLS
 * listener — the https upgrade attempt must fail at the network level
 * and fall back to the original http hop).
 */
function startOrigin(): Promise<{
  server: http.Server;
  url: string;
  plainHits: () => number;
  tokenedHits: () => number;
}> {
  let plainHits = 0;
  let tokenedHits = 0;
  const server = http.createServer((req, res): void => {
    const url = req.url ?? '';
    if (url.startsWith('/tokened')) {
      tokenedHits += 1;
    } else {
      plainHits += 1;
    }
    // Hotlink check: every hop must carry Referer = the module RootURL
    // (this origin). The module rootURL is `http://127.0.0.1:<port>/`.
    if (req.headers['referer'] !== `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('hotlink check failed');
      return;
    }
    if (url.startsWith('/tokened')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(JPEG_BYTES);
      return;
    }
    if (url === '/cover.png' || url.startsWith('/cover.png?')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }
    if (url === '/ua-gated.png') {
      // The mangadex-edge posture: the engine's desktop Chrome UA is
      // challenged (403) while a non-browser UA sails through — the
      // proxy's posture escalation must retry without the browser UA.
      const ua = req.headers['user-agent'] ?? '';
      if (ua.includes('Mozilla/5.0')) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('ua challenge');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }
    if (url === '/text.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html>');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve): void => {
    server.listen(0, '127.0.0.1', (): void => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${String(port)}`,
        plainHits: (): number => plainHits,
        tokenedHits: (): number => tokenedHits,
      });
    });
  });
}

const tmpDirs: string[] = [];
const origins: http.Server[] = [];

interface Harness {
  app: FastifyInstance;
  cacheDir: string;
}

function harness(
  rootUrl: string,
  options: { password?: string; allowedHosts?: string[]; maxCacheBytes?: number } = {},
): Harness {
  const modules = new InMemoryModuleService([makeRegistration({ id: MODULE_ID, rootURL: rootUrl })]);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-cover-cache-'));
  tmpDirs.push(cacheDir);
  const covers = new CoverProxyService(modules, {
    cacheDir,
    ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
    ...(options.maxCacheBytes !== undefined ? { maxCacheBytes: options.maxCacheBytes } : {}),
  });
  const services: ApiServices = {
    ...createDefaultServices({ modules }),
    covers,
  };
  const app = buildApp(services, {
    version: '0.1.0-test',
    ...(options.password !== undefined ? { auth: { password: options.password } } : {}),
  });
  return { app, cacheDir };
}

const coverUrl = (_originUrl: string, moduleId: string, url: string): string =>
  `/api/cover?moduleId=${moduleId}&url=${encodeURIComponent(url)}`;

describe('cover proxy contract', (): void => {
  let originUrl: string;
  let rootUrl: string;
  let plainHits: () => number;
  let tokenedHits: () => number;

  beforeAll(async (): Promise<void> => {
    const started = await startOrigin();
    origins.push(started.server);
    originUrl = started.url;
    plainHits = started.plainHits;
    tokenedHits = started.tokenedHits;
    // The module RootURL IS the loopback origin — the Referer posture
    // and the permitted-host validation both key off it.
    rootUrl = `${started.url}/`;
  });

  afterAll((): void => {
    for (const server of origins) {
      server.close();
    }
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams the cover with the upstream content-type, ttl-derived cache-control and the Referer hotlink posture', async (): Promise<void> => {
    const { app } = harness(rootUrl);
    const ttl = Math.floor(Date.now() / 1000) + 7200; // 2h out — inside the clamp window
    const res = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/tokened.jpg?token=abc&ttl=${String(ttl)}`),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    // The derived max-age is the ttl delta clamped to [3600, 86400] —
    // assert the WINDOW, not the ticking second (two Date.now() reads
    // may cross a second boundary).
    const maxAge = Number(String(res.headers['cache-control']).match(/max-age=(\d+)/)?.[1] ?? '0');
    expect(String(res.headers['cache-control'])).toMatch(/^public, max-age=\d+$/);
    expect(maxAge).toBeGreaterThanOrEqual(7190);
    expect(maxAge).toBeLessThanOrEqual(7200);
    expect(new Uint8Array(res.rawPayload)).toEqual(JPEG_BYTES);
    // The origin 403s referer-less hops — a 200 proves the module
    // RootURL Referer rode the fetch (the fmcdn hotlink seam).
    expect(tokenedHits()).toBe(1);
  });

  it('caps max-age at 24h for far-future ttls, floors at 1h for near/past ttls, and defaults to the cap without a ttl', (): void => {
    const far = coverMaxAgeSeconds(
      `https://x.example/c.jpg?ttl=${String(Math.floor(Date.now() / 1000) + 90 * 86_400)}`,
      Date.now(),
    );
    expect(far).toBe(86_400);
    const near = coverMaxAgeSeconds(
      `https://x.example/c.jpg?ttl=${String(Math.floor(Date.now() / 1000) - 5)}`,
      Date.now(),
    );
    expect(near).toBe(3600);
    const none = coverMaxAgeSeconds('https://x.example/c.jpg', Date.now());
    expect(none).toBe(86_400);
  });

  it('rejects foreign hosts (never an open proxy), malformed urls and credential urls with typed 400s', async (): Promise<void> => {
    const { app } = harness(rootUrl);
    const foreign = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, 'https://evil.example/cover.png'),
    });
    expect(foreign.statusCode).toBe(400);
    expectEnvelope(foreign.json(), 'bad_request');

    const malformed = await app.inject({
      method: 'GET',
      url: `/api/cover?moduleId=${MODULE_ID}&url=not-a-url`,
    });
    expect(malformed.statusCode).toBe(400);
    expectEnvelope(malformed.json(), 'validation_error');

    const credentialed = await app.inject({
      method: 'GET',
      url: `/api/cover?moduleId=${MODULE_ID}&url=${encodeURIComponent('http://user:pass@127.0.0.1/cover.png')}`,
    });
    expect(credentialed.statusCode).toBe(400);
    expectEnvelope(credentialed.json(), 'validation_error');

    const badScheme = await app.inject({
      method: 'GET',
      url: `/api/cover?moduleId=${MODULE_ID}&url=${encodeURIComponent('file:///etc/passwd')}`,
    });
    expect(badScheme.statusCode).toBe(400);
    expectEnvelope(badScheme.json(), 'validation_error');
  });

  it('answers the typed 404 envelope for an unknown module', async (): Promise<void> => {
    const { app } = harness(rootUrl);
    const res = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, 'd'.repeat(32), `${originUrl}/cover.png`),
    });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.json(), 'not_found');
  });

  it('answers the typed 502 envelope for non-image content and failed origin hops', async (): Promise<void> => {
    const { app } = harness(rootUrl);
    const text = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/text.html`),
    });
    expect(text.statusCode).toBe(502);
    expectEnvelope(text.json(), 'upstream_error');

    const gone = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/gone.png`),
    });
    expect(gone.statusCode).toBe(502);
    expectEnvelope(gone.json(), 'upstream_error');
  });

  it('denies non-loopback hosts outside the FMD_HTTP_ALLOW_HOSTS allow-list (engine transport parity)', async (): Promise<void> => {
    const { app } = harness('https://public.example');
    const res = await app.inject({
      method: 'GET',
      url: coverUrl('', MODULE_ID, 'https://www.public.example/covers/1.jpg'),
    });
    expect(res.statusCode).toBe(502);
    expectEnvelope(res.json(), 'upstream_error');
  });

  it('serves from the token-free disk cache: repeats and re-issued tokens never re-hit the origin', async (): Promise<void> => {
    const { app } = harness(rootUrl);
    const first = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/cover.png`),
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-fmd-cover-cache']).toBe('miss');
    const plainAfterFirst = plainHits();

    const second = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/cover.png`),
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-fmd-cover-cache']).toBe('hit');
    expect(new Uint8Array(second.rawPayload)).toEqual(PNG_BYTES);
    expect(plainHits()).toBe(plainAfterFirst);

    // A re-issued token over the same cover path hits the same cache
    // entry — the origin never sees the second token.
    const ttl = Math.floor(Date.now() / 1000) + 3600;
    const tokenOne = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/tokened.jpg?token=ONE&ttl=${String(ttl)}`),
    });
    expect(tokenOne.statusCode).toBe(200);
    expect(tokenOne.headers['x-fmd-cover-cache']).toBe('miss');
    const tokenedAfterOne = tokenedHits();
    const tokenTwo = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/tokened.jpg?token=TWO&ttl=${String(ttl + 5)}`),
    });
    expect(tokenTwo.statusCode).toBe(200);
    expect(tokenTwo.headers['x-fmd-cover-cache']).toBe('hit');
    expect(new Uint8Array(tokenTwo.rawPayload)).toEqual(JPEG_BYTES);
    expect(tokenedHits()).toBe(tokenedAfterOne);
  });

  it('falls back to the original http hop when the https upgrade fails at the network level (https-less origin)', async (): Promise<void> => {
    const { app } = harness(rootUrl);
    // The origin url IS http:// and the listener speaks plain http
    // only — the https upgrade attempt dies at TLS and the deliberate
    // fallback serves the bytes (documented choice: mixed content is a
    // browser constraint, not a server one).
    const res = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/cover.png`),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(new Uint8Array(res.rawPayload)).toEqual(PNG_BYTES);
  });

  it('escalates the request posture on a 403: the browser UA is dropped, the Referer kept (mangadex-edge behavior)', async (): Promise<void> => {
    const { app } = harness(rootUrl);
    // /ua-gated.png 403s the engine's desktop Chrome UA while a
    // non-browser UA passes — AND the shared Referer check still
    // applies, so the escalated retry proves BOTH: UA dropped,
    // Referer = module RootURL kept (the fmcdn requirement).
    const res = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/ua-gated.png`),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(new Uint8Array(res.rawPayload)).toEqual(PNG_BYTES);
  });

  it('is never credential-gated: 200 with password auth on (the *arr GET ordering)', async (): Promise<void> => {
    const { app } = harness(rootUrl, { password: 'sekrit' });
    const res = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/cover.png`),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('prunes the oldest cache entries over the byte cap', async (): Promise<void> => {
    // Cap = one image + 1 byte: the second cover pushes the directory
    // over and the oldest (v=1) pair is pruned.
    const { app, cacheDir } = harness(rootUrl, { maxCacheBytes: PNG_BYTES.byteLength + 1 });
    const first = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/cover.png?v=1`),
    });
    expect(first.statusCode).toBe(200);
    expect(fs.readdirSync(cacheDir).sort()).toEqual(
      expect.arrayContaining([`${coverCacheKey(`${originUrl}/cover.png?v=1`)}.img`]),
    );
    const second = await app.inject({
      method: 'GET',
      url: coverUrl(originUrl, MODULE_ID, `${originUrl}/cover.png?v=2`),
    });
    expect(second.statusCode).toBe(200);
    const entries = fs.readdirSync(cacheDir).sort();
    expect(entries).toHaveLength(2); // exactly the v=2 pair
    expect(entries).toEqual(expect.arrayContaining([`${coverCacheKey(`${originUrl}/cover.png?v=2`)}.img`]));
  });
});

describe('cover proxy unit seams', (): void => {
  it('registrableDomain collapses to the public suffix boundary', (): void => {
    expect(registrableDomain('uploads.mangadex.org')).toBe('mangadex.org');
    expect(registrableDomain('fmcdn.mfcdn.net')).toBe('mfcdn.net');
    expect(registrableDomain('www.mangahere.cc')).toBe('mangahere.cc');
    expect(registrableDomain('mangadex.org')).toBe('mangadex.org');
    expect(registrableDomain('a.b.co.jp')).toBe('b.co.jp');
  });

  it('coverCacheKey is token-free and scheme-insensitive', (): void => {
    const httpUrl = 'http://fmcdn.mfcdn.net/store/manga/1/cover.jpg?token=aaa&ttl=111&v=3';
    const httpsReissue = 'https://fmcdn.mfcdn.net/store/manga/1/cover.jpg?token=bbb&ttl=222&v=3';
    expect(coverCacheKey(httpUrl)).toBe(coverCacheKey(httpsReissue));
    const differentCover = 'https://fmcdn.mfcdn.net/store/manga/2/cover.jpg?token=aaa&ttl=111&v=3';
    expect(coverCacheKey(httpUrl)).not.toBe(coverCacheKey(differentCover));
  });

  it('known image-CDN suffixes are permitted for the fanfox family while arbitrary hosts stay foreign', (): void => {
    // The fanfox module RootURL is fanfox.net, its covers ride
    // fmcdn.mfcdn.net — permitted via the curated CDN allowance.
    const permitted = permittedCoverHostSuffixes('https://fanfox.net');
    expect(permitted).toContain('mfcdn.net');
    expect(permitted).toContain('fanfox.net');
  });
});
