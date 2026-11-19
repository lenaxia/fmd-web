/**
 * §10 auth integration tests (owner decision 2026-11: token-only):
 * the optional-password mode is REMOVED — there is no login route, no
 * session cookie and no credential gate. Every route serves
 * unauthenticated (*arr auth-None semantics; user-facing auth is a
 * reverse-proxy concern — Authelia/Authentik/PocketID), and the R4
 * single API token is accepted wherever presented (pinned in
 * auth-token.test.ts). All through fastify.inject (offline).
 */
import { describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import {
  buildHarness,
  expectEnvelope,
  MODULE_A_ID,
  TEST_VERSION,
} from './helpers.js';

describe('token-only auth — the app performs no user authentication', (): void => {
  it('every route is open without a credential, incl. state-changing POSTs (the SPA contract)', async (): Promise<void> => {
    const h = buildHarness();
    const post = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: {
      moduleId: MODULE_A_ID, mangaUrl: 'https://ex.org/m', chapterLink: 'https://ex.org/m/1',
    } });
    expect(post.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'POST', url: '/api/sync/modules' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
  });

  it('the password login endpoint is GONE: /api/auth/login answers the typed 404 route envelope', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x' } });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, 'not_found');
  });

  it('no route ever mints a session cookie (the cookie flow is removed with the password gate)', async (): Promise<void> => {
    const h = buildHarness();
    const writes: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'POST', url: '/api/sync/modules' },
      { method: 'PUT', url: `/api/modules/${MODULE_A_ID}`, payload: { enabled: false } },
      { method: 'DELETE', url: '/api/favorites/x' },
    ];
    for (const req of writes) {
      const options: InjectOptions = { method: req.method, url: req.url };
      if (req.payload !== undefined) {
        options.payload = req.payload;
      }
      const res = await h.app.inject(options);
      expect(res.headers['set-cookie'], `${req.method} ${req.url}`).toBeUndefined();
    }
  });

  it('GETs are never credential-gated (no 401 anywhere on the read set)', async (): Promise<void> => {
    const h = buildHarness();
    for (const url of [
      '/api/modules',
      '/api/jobs',
      `/api/catalog/${'c'.repeat(32)}/latest`,
      '/api/settings',
      '/api/settings/api-token',
      '/healthz',
      '/readyz',
    ]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).not.toBe(401);
    }
  });

  it('a request presenting a session cookie (legacy password deployment) is simply anonymous — never rejected, never special', async (): Promise<void> => {
    const h = buildHarness();
    // Instances that had a password set upgrade to token-only auth:
    // stale browser cookies must not break anything (they are ignored).
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      headers: { cookie: 'fmd_session=deadbeef' },
      payload: { moduleId: MODULE_A_ID, mangaUrl: 'https://ex.org/m', chapterLink: 'https://ex.org/m/1' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('health probes are served with the version (§10)', (): void => {
  it('healthz reports version; readyz reports readiness', async (): Promise<void> => {
    const h = buildHarness();
    const health = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', version: TEST_VERSION });

    const ready = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true });
  });

  it('unknown routes get the 404 envelope', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, 'not_found');
  });
});
