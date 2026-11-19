/**
 * PWA static-asset contract (R5 arrival + §10 auth ordering, updated
 * for the token-only world — owner decision 2026-11): the manifest,
 * its icons and the SPA shell are PLAIN GETs and serve 200
 * UNAUTHENTICATED, and with the optional-password mode REMOVED no
 * route credential-walls anything — the *arr gate ordering invariant
 * holds vacuously (GETs never gated; there is no state-changing wall
 * either; the R4 API key is accepted wherever presented, never
 * demanded). The manifest additionally MUST carry
 * `application/manifest+json` — browsers refuse to parse it otherwise
 * and PWA installability silently dies (the regression this file
 * pins: the static map missed the extension and served
 * `application/octet-stream`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { registerStatic } from '../../src/runtime/static.js';
import { createDefaultServices, type ApiServices } from '../../src/main.js';

const MANIFEST_BODY = JSON.stringify({
  name: 'FMD Web',
  start_url: '/',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
});

function staticApp(auth?: { apiToken: string }): { app: FastifyInstance; dist: string } {
  const services: ApiServices = createDefaultServices();
  const app = buildApp(services, {
    version: '0.1.0-test',
    ...(auth !== undefined ? { auth } : {}),
  });
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'fmd-static-pwa-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>fmd</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), MANIFEST_BODY);
  fs.writeFileSync(path.join(dist, 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  registerStatic(app, dist);
  return { app, dist };
}

const dists: string[] = [];
afterAll((): void => {
  for (const dist of dists) {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

describe('PWA static assets + token-only auth ordering', (): void => {
  it('manifest + icons + SPA shell serve 200 unauthenticated; manifest is application/manifest+json', async (): Promise<void> => {
    const { app, dist } = staticApp();
    dists.push(dist);

    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect((JSON.parse(manifest.body) as { name: string }).name).toBe('FMD Web');

    const icon = await app.inject({ method: 'GET', url: '/icon-192.png' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toContain('image/png');

    const shell = await app.inject({ method: 'GET', url: '/' });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
  });

  it('with the API key CONFIGURED (every real deployment) the same static GETs stay open and NO route is credential-walled: state-changing routes serve unauthenticated, the key is merely accepted', async (): Promise<void> => {
    const TOKEN = 'a'.repeat(64);
    const { app, dist } = staticApp({ apiToken: TOKEN });
    dists.push(dist);

    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');

    const icon = await app.inject({ method: 'GET', url: '/icon-192.png' });
    expect(icon.statusCode).toBe(200);

    const shell = await app.inject({ method: 'GET', url: '/' });
    expect(shell.statusCode).toBe(200);

    // The password-mode gate is gone: a state-changing route WITHOUT
    // any credential serves (the browser SPA contract — *arr
    // auth-None; user-facing auth belongs to a reverse proxy in
    // front).
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: 'a'.repeat(32), url: '/title/x' },
    });
    expect(anonymous.statusCode).toBe(201);

    // The R4 API key is ACCEPTED wherever presented (it authenticates
    // the script, it never gates the browser).
    const authed = await app.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { moduleId: 'a'.repeat(32), url: '/title/y' },
    });
    expect(authed.statusCode).toBe(201);

    // The removed login endpoint must stay removed.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'anything' },
    });
    expect(login.statusCode).toBe(404);
  });
});
