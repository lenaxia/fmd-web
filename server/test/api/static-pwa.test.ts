/**
 * PWA static-asset contract (R5 arrival + §10 auth ordering): the
 * manifest, its icons and the SPA shell are PLAIN GETs — they must
 * serve 200 UNAUTHENTICATED whether password auth is off (open
 * deployment) or on (the pre-login SPA still has to render so the
 * login page can appear — §10 "plain GETs stay open"), while the
 * auth gate keeps holding the state-changing API set. The manifest
 * additionally MUST carry `application/manifest+json` — browsers
 * refuse to parse it otherwise and PWA installability silently dies
 * (the regression this file pins: the static map missed the
 * extension and served `application/octet-stream`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { registerStatic } from '../../src/runtime/static.js';
import { createDefaultServices, type ApiServices } from '../../src/main.js';
import { expectEnvelope } from './helpers.js';

const MANIFEST_BODY = JSON.stringify({
  name: 'FMD Web',
  start_url: '/',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
});

function staticApp(auth?: { password: string }): { app: FastifyInstance; dist: string } {
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

describe('PWA static assets + auth gate ordering', (): void => {
  it('manifest + icons + SPA shell serve 200 unauthenticated with auth OFF; manifest is application/manifest+json', async (): Promise<void> => {
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

  it('with password auth ON the same static GETs stay open for the pre-login SPA while state-changing routes are gated', async (): Promise<void> => {
    const { app, dist } = staticApp({ password: 'sekrit' });
    dists.push(dist);

    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');

    const icon = await app.inject({ method: 'GET', url: '/icon-192.png' });
    expect(icon.statusCode).toBe(200);

    const shell = await app.inject({ method: 'GET', url: '/' });
    expect(shell.statusCode).toBe(200);

    // The gate itself is intact: a state-changing route without a
    // session is the typed 401, and the password flow still grants it.
    const gated = await app.inject({
      method: 'POST',
      url: '/api/favorites',
      payload: { moduleId: 'a'.repeat(32), url: '/title/x' },
    });
    expect(gated.statusCode).toBe(401);
    expectEnvelope(gated.body, 'unauthorized');

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'sekrit' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'] as string | string[] | undefined;
    const cookieHeader = (Array.isArray(cookie) ? cookie[0] : cookie) ?? '';
    const authed = await app.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: { cookie: cookieHeader.split(';')[0] ?? '' },
      payload: { moduleId: 'a'.repeat(32), url: '/title/x' },
    });
    expect(authed.statusCode).toBe(201);
  });
});
