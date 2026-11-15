/**
 * §10 auth integration tests: optional FMD_WEB_PASSWORD → session
 * cookie, login rate limit (10/min), and the state-changing gate —
 * all through fastify.inject (offline).
 */
import { describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import {
  buildHarness,
  expectEnvelope,
  MODULE_A_ID,
  TEST_VERSION,
} from './helpers.js';
import { SESSION_COOKIE } from '../../src/api/schemas.js';
import type { AuthConfig } from '../../src/api/auth.js';

const AUTH: AuthConfig = { password: 'hunter2' };

describe('auth disabled (no FMD_WEB_PASSWORD) — §10 "optional"', (): void => {
  it('every route is open without a session, incl. state-changing POSTs', async (): Promise<void> => {
    const h = buildHarness();
    const post = await h.app.inject({ method: 'POST', url: '/api/jobs/download', payload: {
      moduleId: MODULE_A_ID, mangaUrl: 'https://ex.org/m', chapterLink: 'https://ex.org/m/1',
    } });
    expect(post.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'POST', url: '/api/sync/modules' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
  });

  it('login is a 400 (nothing to log into)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x' } });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'bad_request');
  });
});

describe('auth enabled — session cookie', (): void => {
  it('login with the right password sets an HttpOnly SameSite=Strict session cookie', async (): Promise<void> => {
    const h = buildHarness({ auth: AUTH });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'hunter2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cookie: string = res.headers['set-cookie'] as string;
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('hunter2'); // the cookie is a random token, not the password
  });

  it('login with the wrong password is 401 invalid_credentials', async (): Promise<void> => {
    const h = buildHarness({ auth: AUTH });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expectEnvelope(res.body, 'unauthorized');
  });

  it('missing/malformed login body is a validation_error envelope', async (): Promise<void> => {
    const h = buildHarness({ auth: AUTH });
    const missing = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(missing.statusCode).toBe(400);
    const err = expectEnvelope(missing.body, 'validation_error');
    expect(err.details).toBeDefined();

    const wrongType = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 42 },
    });
    expect(wrongType.statusCode).toBe(400);
    expectEnvelope(wrongType.body, 'validation_error');
  });

  it('state-changing routes are gated (401 without a session), reads stay open', async (): Promise<void> => {
    const h = buildHarness({ auth: AUTH });
    const gated: Array<{ method: 'POST' | 'PUT'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'PUT', url: `/api/modules/${MODULE_A_ID}`, payload: { enabled: false } },
      { method: 'POST', url: '/api/sync/modules' },
      { method: 'POST', url: `/api/sync/catalog/${'c'.repeat(32)}` },
      { method: 'POST', url: '/api/sync/catalog/all' },
      { method: 'POST', url: '/api/info', payload: { moduleId: MODULE_A_ID, url: 'https://x' } },
      {
        method: 'POST',
        url: '/api/jobs/download',
        payload: { moduleId: MODULE_A_ID, mangaUrl: 'https://x', chapterLink: 'https://x/1' },
      },
    ];
    for (const req of gated) {
      const options: InjectOptions = { method: req.method, url: req.url };
      if (req.payload !== undefined) {
        options.payload = req.payload;
      }
      const res = await h.app.inject(options);
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(401);
      expectEnvelope(res.body, 'unauthorized');
    }
    // Reads (GET) are never gated — the SPA renders before login.
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: `/api/catalog/${'c'.repeat(32)}/latest` })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });

  it('a valid session cookie unlocks state-changing routes', async (): Promise<void> => {
    const h = buildHarness({ auth: AUTH });
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'hunter2' },
    });
    const cookie = /fmd_session=[^;]+/.exec(login.headers['set-cookie'] as string)?.[0];
    expect(cookie).toBeDefined();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      headers: { cookie: cookie as string },
      payload: { moduleId: MODULE_A_ID, mangaUrl: 'https://x', chapterLink: 'https://x/1' },
    });
    expect(res.statusCode).toBe(201);
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      headers: { cookie: cookie as string },
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().enabled).toBe(false);
  });

  it('a forged or unknown cookie is 401; an expired session is 401', async (): Promise<void> => {
    const h = buildHarness({ auth: AUTH });
    const forged = await h.app.inject({
      method: 'POST',
      url: '/api/sync/modules',
      headers: { cookie: `${SESSION_COOKIE}=deadbeef` },
    });
    expect(forged.statusCode).toBe(401);

    const short = buildHarness({ auth: { ...AUTH, sessionTtlMs: 20 } });
    const login = await short.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'hunter2' },
    });
    const cookie = /fmd_session=[^;]+/.exec(login.headers['set-cookie'] as string)?.[0] as string;
    await new Promise<void>((r): void => {
      setTimeout(r, 40);
    });
    const expired = await short.app.inject({
      method: 'POST',
      url: '/api/sync/modules',
      headers: { cookie },
    });
    expect(expired.statusCode).toBe(401);
    expectEnvelope(expired.body, 'unauthorized');
  });
});

describe('login rate limit — 10/min per remote address', (): void => {
  it('the 11th attempt within the window is 429 with retry info; per-IP isolation holds', async (): Promise<void> => {
    const h = buildHarness({
      auth: { password: 'hunter2', loginRateLimit: { windowMs: 500, max: 10 } },
    });
    const attempt = (ip: string): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: ip,
        payload: { password: 'nope' }, // wrong password — counts against the limit
      });

    for (let i = 0; i < 10; i += 1) {
      const res = await attempt('10.0.0.1');
      expect(res.statusCode, `attempt ${String(i + 1)}`).toBe(401);
    }
    const eleventh = await attempt('10.0.0.1');
    expect(eleventh.statusCode).toBe(429);
    const envelope = expectEnvelope(eleventh.body, 'rate_limited');
    expect((envelope.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds).toBeGreaterThan(0);

    // A different address has its own bucket.
    const other = await attempt('10.0.0.2');
    expect(other.statusCode).toBe(401);

    // Window expiry resets the bucket.
    await new Promise<void>((r): void => {
      setTimeout(r, 550);
    });
    const afterWindow = await attempt('10.0.0.1');
    expect(afterWindow.statusCode).toBe(401);
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
