/**
 * R4 auth-matrix integration tests (docs/UX-PARITY.md R4): the SINGLE
 * app-wide API token — Sonarr/Radarr model — over fastify.inject
 * (offline). Every matrix cell, the constant-time verify, the login
 * rate-limit bypass, live regeneration (old key rejected on the next
 * request), env-pin precedence (mock env) and the auth-mode metrics
 * labels. WS-upgrade gating lives in ws/ws-auth.test.ts.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { InjectOptions } from 'light-my-request';
import { buildHarness, expectEnvelope, MODULE_A_ID } from './helpers.js';
import {
  AuthService,
  resolveApiTokenBootstrap,
  readBearerToken,
  type AuthConfig,
} from '../../src/api/auth.js';
import { InMemorySettingsService } from '../../src/api/services.js';
import { loadRuntimeConfig } from '../../src/runtime/assembly.js';
import { FmdMetrics } from '../../src/observability/metrics.js';

const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);
const PASSWORD = 'hunter2';

const authed = (headers: Record<string, string>): Record<string, string> => headers;

function writeJob(token?: string, cookie?: string): InjectOptions {
  return {
    method: 'POST',
    url: '/api/jobs/download',
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie !== undefined ? { cookie } : {}),
    },
    payload: { moduleId: MODULE_A_ID, mangaUrl: 'https://ex.org/m', chapterLink: 'https://ex.org/m/1' },
  };
}

async function login(h: ReturnType<typeof buildHarness>): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'] as string;
  return setCookie.split(';')[0] ?? '';
}

// ── matrix cell: token + password → either path grants ───────────────

describe('R4 matrix: token + password set', (): void => {
  const CONFIG: AuthConfig = { password: PASSWORD, apiToken: TOKEN };

  it('writes accept EITHER credential (Bearer token or session cookie)', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    expect((await h.app.inject(writeJob())).statusCode).toBe(401);
    expect((await h.app.inject(writeJob(TOKEN))).statusCode).toBe(201);
    const cookie = await login(h);
    expect((await h.app.inject(writeJob(undefined, cookie))).statusCode).toBe(201);
  });

  it('plain GETs stay open (the pre-login SPA keeps rendering)', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('wrong/missing token on a gated write is a 401 typed envelope', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    for (const bad of [
      writeJob(OTHER_TOKEN),
      writeJob('short'),
      { ...writeJob(), headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { ...writeJob(), headers: { authorization: `bearer-nope ${TOKEN}` } },
    ]) {
      const res = await h.app.inject(bad as InjectOptions);
      expect(res.statusCode).toBe(401);
      expectEnvelope(res.body, 'unauthorized');
    }
  });

  it('the token secret route is credential-gated even though GETs are open', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    const open = await h.app.inject({ method: 'GET', url: '/api/settings/api-token' });
    expect(open.statusCode).toBe(401);
    expectEnvelope(open.body, 'unauthorized');

    const viaToken = await h.app.inject({
      method: 'GET',
      url: '/api/settings/api-token',
      headers: authed({ authorization: `Bearer ${TOKEN}` }),
    });
    expect(viaToken.statusCode).toBe(200);
    expect(viaToken.json()).toEqual({ token: TOKEN, envManaged: false, mode: 'password+api-token' });

    const cookie = await login(h);
    const viaCookie = await h.app.inject({
      method: 'GET',
      url: '/api/settings/api-token',
      headers: authed({ cookie }),
    });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json()['token']).toBe(TOKEN);
  });
});

// ── matrix cell: token only → API-ONLY mode (R4d) ────────────────────

describe('R4 matrix: token set + password unset → API-only mode', (): void => {
  const CONFIG: AuthConfig = { password: undefined, apiToken: TOKEN };

  it('EVERY /api route (reads included) requires the token', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    const noAuth = await h.app.inject({ method: 'GET', url: '/api/modules' });
    expect(noAuth.statusCode).toBe(401);
    expectEnvelope(noAuth.body, 'unauthorized');

    const withToken = await h.app.inject({
      method: 'GET',
      url: '/api/modules',
      headers: authed({ authorization: `Bearer ${TOKEN}` }),
    });
    expect(withToken.statusCode).toBe(200);

    expect((await h.app.inject(writeJob())).statusCode).toBe(401);
    expect((await h.app.inject(writeJob(TOKEN))).statusCode).toBe(201);
    expect((await h.app.inject(writeJob(OTHER_TOKEN))).statusCode).toBe(401);
  });

  it('health probes stay open (Docker healthcheck) + login reports auth_disabled', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'x' },
    });
    expect(login.statusCode).toBe(400);
    expectEnvelope(login.body, 'bad_request');
  });

  it('/api/metrics is gated like every other /api route', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG, metrics: new FmdMetrics() });
    expect((await h.app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(401);
    const withToken = await h.app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: authed({ authorization: `Bearer ${TOKEN}` }),
    });
    expect(withToken.statusCode).toBe(200);
  });
});

// ── matrix cell: password only → today's cookie flow unchanged ───────

describe('R4 matrix: password set + token unset (today, unchanged)', (): void => {
  it('writes need the cookie; Bearer is never valid (no token configured)', async (): Promise<void> => {
    const h = buildHarness({ auth: { password: PASSWORD } });
    expect((await h.app.inject(writeJob())).statusCode).toBe(401);
    expect((await h.app.inject(writeJob(OTHER_TOKEN))).statusCode).toBe(401);
    const cookie = await login(h);
    expect((await h.app.inject(writeJob(undefined, cookie))).statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
  });

  it('the secret route 401s without a session; token state reports mode=password', async (): Promise<void> => {
    const h = buildHarness({ auth: { password: PASSWORD } });
    expect((await h.app.inject({ method: 'GET', url: '/api/settings/api-token' })).statusCode).toBe(401);
    const cookie = await login(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/settings/api-token',
      headers: authed({ cookie }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: null, envManaged: false, mode: 'password' });
  });
});

// ── matrix cell: both unset → auth off ───────────────────────────────

describe('R4 matrix: both unset → auth off', (): void => {
  it('everything is open, incl. state-changing POSTs (no-auth deployments)', async (): Promise<void> => {
    const h = buildHarness();
    expect((await h.app.inject(writeJob())).statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
    const res = await h.app.inject({ method: 'GET', url: '/api/settings/api-token' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: null, envManaged: false, mode: 'none' });
  });

  it('regenerate refuses when no auth is configured (no silent API-only flip)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/settings/api-token/regenerate' });
    expect(res.statusCode).toBe(409);
    expectEnvelope(res.body, 'conflict');
  });
});

// ── constant-time verification (unit) ────────────────────────────────

describe('R4 constant-time token verification', (): void => {
  it('accepts the exact token; rejects wrong/short/long/empty/undefined without throwing', (): void => {
    const auth = new AuthService({ password: undefined, apiToken: TOKEN });
    expect(auth.verifyApiToken(TOKEN)).toBe(true);
    expect(auth.verifyApiToken(OTHER_TOKEN)).toBe(false);
    expect(auth.verifyApiToken('x')).toBe(false);
    expect(auth.verifyApiToken(`${TOKEN}extra`)).toBe(false);
    expect(auth.verifyApiToken('')).toBe(false);
    expect(auth.verifyApiToken(undefined)).toBe(false);
    // An arbitrary-length env pin must verify exactly the same way.
    const pinned = new AuthService({ password: undefined, apiToken: 'deploy-secret-42' });
    expect(pinned.verifyApiToken('deploy-secret-42')).toBe(true);
    expect(pinned.verifyApiToken('deploy-secret-4')).toBe(false);
  });

  it('Bearer parsing: exact scheme, case-insensitive, one segment', (): void => {
    expect(readBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(readBearerToken(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(readBearerToken(`BEARER   ${TOKEN}`)).toBe(TOKEN);
    expect(readBearerToken('Basic abc')).toBeUndefined();
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken(['Bearer x'])).toBe('x');
  });
});

// ── token requests bypass the login rate limit ──────────────────────

describe('R4: token requests bypass the login rate limit', (): void => {
  it('an exhausted login window never throttles Bearer-authenticated requests', async (): Promise<void> => {
    const h = buildHarness({
      auth: { password: PASSWORD, apiToken: TOKEN, loginRateLimit: { windowMs: 60_000, max: 2 } },
    });
    for (let i = 0; i < 3; i += 1) {
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
      });
    }
    const throttled = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: PASSWORD },
    });
    expect(throttled.statusCode).toBe(429);

    // The script path is unaffected: same address, valid Bearer token.
    expect((await h.app.inject(writeJob(TOKEN))).statusCode).toBe(201);
    // Even the login route itself bypasses the limiter with a token.
    const tokenLogin = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: authed({ authorization: `Bearer ${TOKEN}` }),
      payload: { password: PASSWORD },
    });
    expect(tokenLogin.statusCode).toBe(200);
  });
});

// ── regeneration: live rotation, audit, refusal states ───────────────

describe('R4: regeneration rotates the ONE value in place', (): void => {
  function tokenHarness(opts: { envPinned?: boolean; password?: string } = {}): {
    h: ReturnType<typeof buildHarness>;
    audit: { events: string[] };
  } {
    const settings = new InMemorySettingsService();
    settings.setApiToken(TOKEN);
    const audit = { events: [] as string[] };
    const provider = (): string | undefined => settings.getApiToken() ?? undefined;
    const h = buildHarness({
      settings,
      onAudit: (event): void => {
        audit.events.push(`${event.setting}:${event.action}`);
      },
      auth: {
        password: opts.password ?? PASSWORD,
        apiToken: opts.envPinned === true ? 'e'.repeat(64) : provider,
        ...(opts.envPinned === true ? { apiTokenEnvPinned: true } : {}),
      },
    });
    return { h, audit };
  }

  it('old key is rejected on the NEXT request; new key works; audit fires (no value logged)', async (): Promise<void> => {
    const { h, audit } = tokenHarness();
    const cookie = await login(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/settings/api-token/regenerate',
      headers: authed({ cookie }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; envManaged: boolean; mode: string };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token).not.toBe(TOKEN);
    expect(body.envManaged).toBe(false);

    // Immediate revocation semantics — the very next requests:
    expect((await h.app.inject(writeJob(TOKEN))).statusCode).toBe(401);
    expect((await h.app.inject(writeJob(body.token))).statusCode).toBe(201);
    expect(audit.events).toEqual(['api_token:regenerate']);

    // The rotate survives a provider re-read (settings store is the truth).
    const state = await h.app.inject({
      method: 'GET',
      url: '/api/settings/api-token',
      headers: authed({ authorization: `Bearer ${body.token}` }),
    });
    expect(state.json()['token']).toBe(body.token);
  });

  it('env-pinned deployments refuse (409) and report Managed via environment', async (): Promise<void> => {
    const { h } = tokenHarness({ envPinned: true });
    const cookie = await login(h);
    const state = await h.app.inject({
      method: 'GET',
      url: '/api/settings/api-token',
      headers: authed({ cookie }),
    });
    expect(state.json()).toEqual({ token: null, envManaged: true, mode: 'password+api-token' });

    const rotate = await h.app.inject({
      method: 'POST',
      url: '/api/settings/api-token/regenerate',
      headers: authed({ cookie }),
    });
    expect(rotate.statusCode).toBe(409);
    expectEnvelope(rotate.body, 'conflict');
  });

  it('regeneration is reachable by the token itself (scripts can rotate)', async (): Promise<void> => {
    const { h } = tokenHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/settings/api-token/regenerate',
      headers: authed({ authorization: `Bearer ${TOKEN}` }),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── env-pin precedence (mock env) ────────────────────────────────────

describe('R4: FMD_WEB_API_TOKEN env pin precedence (env > settings store)', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('bootstrap: env pin wins over a stored value; generation only for authed, unpinned, empty stores', (): void => {
    const pin = 'p'.repeat(64);
    // pin > stored
    expect(resolveApiTokenBootstrap({ envPin: pin, stored: TOKEN, passwordSet: false })).toEqual({
      generated: false,
      envPinned: true,
      store: TOKEN,
    });
    // stored, no pin → nothing to do
    expect(resolveApiTokenBootstrap({ envPin: undefined, stored: TOKEN, passwordSet: true })).toEqual({
      generated: false,
      envPinned: false,
      store: TOKEN,
    });
    // no pin, no stored, password set → FIRST-RUN GENERATION
    const generated = resolveApiTokenBootstrap({ envPin: undefined, stored: null, passwordSet: true });
    expect(generated.generated).toBe(true);
    expect(generated.store).toMatch(/^[0-9a-f]{64}$/);
    // no pin, no stored, no password → auth stays OFF (default no-auth
    // deployments never generate — out-of-box flows untouched)
    expect(resolveApiTokenBootstrap({ envPin: undefined, stored: null, passwordSet: false })).toEqual({
      generated: false,
      envPinned: false,
      store: null,
    });
    // a pinned deployment never generates, even with a password
    expect(resolveApiTokenBootstrap({ envPin: pin, stored: null, passwordSet: true })).toEqual({
      generated: false,
      envPinned: true,
      store: null,
    });
  });

  it('live provider: a pinned env stays in charge while the stored value rotates under it', async (): Promise<void> => {
    const pin = 'e'.repeat(64);
    const settings = new InMemorySettingsService();
    settings.setApiToken(TOKEN);
    const provider = (): string | undefined => pin ?? (settings.getApiToken() ?? undefined);
    const h = buildHarness({ settings, auth: { password: PASSWORD, apiToken: provider, apiTokenEnvPinned: true } });
    // the pin (not the stored value) authenticates
    expect((await h.app.inject(writeJob(TOKEN))).statusCode).toBe(401);
    expect((await h.app.inject(writeJob(pin))).statusCode).toBe(201);
    // rotating the store changes nothing while pinned
    settings.setApiToken(OTHER_TOKEN);
    expect((await h.app.inject(writeJob(OTHER_TOKEN))).statusCode).toBe(401);
    expect((await h.app.inject(writeJob(pin))).statusCode).toBe(201);
  });

  it('loadRuntimeConfig reads FMD_WEB_PASSWORD/FMD_WEB_API_TOKEN (empty string = unset)', (): void => {
    vi.stubEnv('FMD_WEB_PASSWORD', 'sekrit');
    vi.stubEnv('FMD_WEB_API_TOKEN', 'p'.repeat(64));
    const config = loadRuntimeConfig();
    expect(config.password).toBe('sekrit');
    expect(config.apiTokenEnv).toBe('p'.repeat(64));

    const blank = loadRuntimeConfig({ FMD_WEB_PASSWORD: '', FMD_WEB_API_TOKEN: '' });
    expect(blank.password).toBeUndefined();
    expect(blank.apiTokenEnv).toBeUndefined();
  });
});

// ── metrics: auth={none|cookie|token} labels ─────────────────────────

describe('R4: fmd_http_requests_total carries auth mode labels', (): void => {
  it('none/cookie/token series appear in the exposition exactly as served', async (): Promise<void> => {
    const metrics = new FmdMetrics();
    const settings = new InMemorySettingsService();
    settings.setApiToken(TOKEN);
    const h = buildHarness({
      metrics,
      settings,
      auth: { password: PASSWORD, apiToken: (): string | undefined => settings.getApiToken() ?? undefined },
    });
    // none: an unauthenticated GET (open read) + a 401 write (no credential)
    expect((await h.app.inject(writeJob())).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
    // cookie: login (none) + an authed write
    const cookie = await login(h);
    expect((await h.app.inject(writeJob(undefined, cookie))).statusCode).toBe(201);
    // token: an authed write
    expect((await h.app.inject(writeJob(TOKEN))).statusCode).toBe(201);

    const scrape = await h.app.inject({ method: 'GET', url: '/api/metrics' });
    const text = scrape.body as string;
    expect(text).toContain("fmd_http_requests_total{auth=\"none\",method=\"GET\",route=\"/api/modules\",status=\"200\"} 1");
    expect(text).toContain("fmd_http_requests_total{auth=\"cookie\",method=\"POST\",route=\"/api/jobs/download\",status=\"201\"} 1");
    expect(text).toContain("fmd_http_requests_total{auth=\"token\",method=\"POST\",route=\"/api/jobs/download\",status=\"201\"} 1");
    // 401s are counted under none (the failed credential never landed)
    expect(text).toContain("fmd_http_requests_total{auth=\"none\",method=\"POST\",route=\"/api/jobs/download\",status=\"401\"}");
  });
});
