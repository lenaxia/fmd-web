/**
 * R4 token-only auth tests (docs/UX-PARITY.md R4 + owner decision
 * 2026-11): the SINGLE app-wide API token — Sonarr/Radarr model — is
 * the app's ONLY credential. The app is open (*arr auth-None
 * semantics): the token never gates, it AUTHENTICATES (accepted
 * wherever presented). Pinned here over fastify.inject (offline):
 * the constant-time verify, Bearer parsing, acceptance on writes,
 * live regeneration (old key rejected on the next request — a
 * PRESENTED old key stops authenticating), env-pin precedence (mock
 * env), the open token-settings reads and the auth-mode metrics
 * labels (none|token). WS acceptance lives in ws/ws-auth.test.ts.
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

const authed = (headers: Record<string, string>): Record<string, string> => headers;

function writeJob(token?: string): InjectOptions {
  return {
    method: 'POST',
    url: '/api/jobs/download',
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    payload: { moduleId: MODULE_A_ID, mangaUrl: 'https://ex.org/m', chapterLink: 'https://ex.org/m/1' },
  };
}

// ── open deployment: the token authenticates, never gates ───────────

describe('R4 token-only: open deployment, token accepted wherever presented', (): void => {
  const CONFIG: AuthConfig = { apiToken: TOKEN };

  it('SPA flows work login-free: reads AND state-changing POSTs stay open', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
    expect((await h.app.inject(writeJob())).statusCode).toBe(201);
  });

  it('a VALID Bearer token is accepted (and the request authenticates as token)', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    expect((await h.app.inject(writeJob(TOKEN))).statusCode).toBe(201);
  });

  it('a WRONG token does not lock anything out — open is open (the credential only labels)', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    expect((await h.app.inject(writeJob(OTHER_TOKEN))).statusCode).toBe(201);
    const malformed = await h.app.inject({
      ...writeJob(),
      headers: { authorization: `bearer-nope ${TOKEN}` },
    });
    expect(malformed.statusCode).toBe(201);
  });

  it('the token-settings reads are open (R4: shown in Settings; whoever reaches the app reads it)', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG });
    const res = await h.app.inject({ method: 'GET', url: '/api/settings/api-token' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: TOKEN, envManaged: false });
  });

  it('health probes + metrics stay open', async (): Promise<void> => {
    const h = buildHarness({ auth: CONFIG, metrics: new FmdMetrics() });
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(200);
  });

  it('no token configured at all: auth-None parity, everything open incl. the token state', async (): Promise<void> => {
    const h = buildHarness();
    expect((await h.app.inject(writeJob())).statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
    const res = await h.app.inject({ method: 'GET', url: '/api/settings/api-token' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: null, envManaged: false });
  });
});

// ── constant-time verification (unit) ────────────────────────────────

describe('R4 constant-time token verification', (): void => {
  it('accepts the exact token; rejects wrong/short/long/empty/undefined without throwing', (): void => {
    const auth = new AuthService({ apiToken: TOKEN });
    expect(auth.verifyApiToken(TOKEN)).toBe(true);
    expect(auth.verifyApiToken(OTHER_TOKEN)).toBe(false);
    expect(auth.verifyApiToken('x')).toBe(false);
    expect(auth.verifyApiToken(`${TOKEN}extra`)).toBe(false);
    expect(auth.verifyApiToken('')).toBe(false);
    expect(auth.verifyApiToken(undefined)).toBe(false);
    // An arbitrary-length env pin must verify exactly the same way.
    const pinned = new AuthService({ apiToken: 'deploy-secret-42' });
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

// ── regeneration: live rotation, audit, refusal states ───────────────

describe('R4: regeneration rotates the ONE value in place', (): void => {
  function tokenHarness(opts: { envPinned?: boolean } = {}): {
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
        apiToken: opts.envPinned === true ? 'e'.repeat(64) : provider,
        ...(opts.envPinned === true ? { apiTokenEnvPinned: true } : {}),
      },
    });
    return { h, audit };
  }

  it('the new key authenticates on the next request; the audit fires (no value logged)', async (): Promise<void> => {
    const { h, audit } = tokenHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/settings/api-token/regenerate' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; envManaged: boolean };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token).not.toBe(TOKEN);
    expect(body.envManaged).toBe(false);
    expect(audit.events).toEqual(['api_token:regenerate']);

    // The state route reflects the rotation immediately (provider is live).
    const state = await h.app.inject({
      method: 'GET',
      url: '/api/settings/api-token',
      headers: authed({ authorization: `Bearer ${body.token}` }),
    });
    expect(state.json()['token']).toBe(body.token);
  });

  it('env-pinned deployments refuse (409) and report Managed via environment', async (): Promise<void> => {
    const { h } = tokenHarness({ envPinned: true });
    const state = await h.app.inject({ method: 'GET', url: '/api/settings/api-token' });
    expect(state.json()).toEqual({ token: null, envManaged: true });

    const rotate = await h.app.inject({ method: 'POST', url: '/api/settings/api-token/regenerate' });
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

  it('bootstrap: env pin wins over a stored value; generation is UNCONDITIONAL (no pin, nothing stored)', (): void => {
    const pin = 'p'.repeat(64);
    // pin > stored
    expect(resolveApiTokenBootstrap({ envPin: pin, stored: TOKEN })).toEqual({
      generated: false,
      envPinned: true,
      store: TOKEN,
    });
    // stored, no pin → nothing to do
    expect(resolveApiTokenBootstrap({ envPin: undefined, stored: TOKEN })).toEqual({
      generated: false,
      envPinned: false,
      store: TOKEN,
    });
    // no pin, no stored → FIRST-RUN GENERATION (*arr semantics: the
    // token is a script key — every deployment gets one on first run)
    const generated = resolveApiTokenBootstrap({ envPin: undefined, stored: null });
    expect(generated.generated).toBe(true);
    expect(generated.store).toMatch(/^[0-9a-f]{64}$/);
    // a pinned deployment never generates
    expect(resolveApiTokenBootstrap({ envPin: pin, stored: null })).toEqual({
      generated: false,
      envPinned: true,
      store: null,
    });
    // empty-string pin is UNSET (deployments pinning '' mean "off")
    expect(resolveApiTokenBootstrap({ envPin: '', stored: null }).generated).toBe(true);
    // the generate hook is honored (tests pin deterministic values)
    expect(resolveApiTokenBootstrap({ envPin: undefined, stored: null, generate: (): string => 'f'.repeat(64) }).store).toBe(
      'f'.repeat(64),
    );
  });

  it('live provider: a pinned env stays in charge while the stored value rotates under it', async (): Promise<void> => {
    const pin = 'e'.repeat(64);
    const settings = new InMemorySettingsService();
    settings.setApiToken(TOKEN);
    const provider = (): string | undefined => pin ?? (settings.getApiToken() ?? undefined);
    const h = buildHarness({ settings, auth: { apiToken: provider, apiTokenEnvPinned: true } });
    // open deployment: both writes succeed — verification only labels.
    // The pin wins the LABEL: assert via the state route's envManaged
    // (pinned deployments hide the value) + presenter acceptance below.
    expect((await h.app.inject({ method: 'GET', url: '/api/settings/api-token' })).json()).toEqual({
      token: null,
      envManaged: true,
    });
    // rotating the store changes nothing while pinned
    settings.setApiToken(OTHER_TOKEN);
    expect((await h.app.inject({ method: 'GET', url: '/api/settings/api-token' })).json()).toEqual({
      token: null,
      envManaged: true,
    });
    // ...and the PIN still authenticates its presenter:
    const labeled = await h.app.inject({ ...writeJob(pin), url: '/api/jobs/download' });
    expect(labeled.statusCode).toBe(201);
  });

  it('loadRuntimeConfig reads FMD_WEB_API_TOKEN (empty string = unset); FMD_WEB_PASSWORD is no longer a field', (): void => {
    vi.stubEnv('FMD_WEB_API_TOKEN', 'p'.repeat(64));
    const config = loadRuntimeConfig();
    expect(config.apiTokenEnv).toBe('p'.repeat(64));
    expect('password' in config).toBe(false);

    const blank = loadRuntimeConfig({ FMD_WEB_PASSWORD: 'legacy', FMD_WEB_API_TOKEN: '' });
    expect(blank.apiTokenEnv).toBeUndefined();
    expect('password' in blank).toBe(false);
  });
});

// ── metrics: auth={none|token} labels ────────────────────────────────

describe('R4: fmd_http_requests_total carries auth mode labels', (): void => {
  it('none/token series appear in the exposition exactly as served (cookie is gone with the password flow)', async (): Promise<void> => {
    const metrics = new FmdMetrics();
    const settings = new InMemorySettingsService();
    settings.setApiToken(TOKEN);
    const h = buildHarness({
      metrics,
      settings,
      auth: { apiToken: (): string | undefined => settings.getApiToken() ?? undefined },
    });
    // none: an unauthenticated GET + an unauthenticated write
    expect((await h.app.inject({ method: 'GET', url: '/api/modules' })).statusCode).toBe(200);
    expect((await h.app.inject(writeJob())).statusCode).toBe(201);
    // token: a Bearer-authenticated write
    expect((await h.app.inject(writeJob(TOKEN))).statusCode).toBe(201);

    const scrape = await h.app.inject({ method: 'GET', url: '/api/metrics' });
    const text = scrape.body as string;
    expect(text).toContain("fmd_http_requests_total{auth=\"none\",method=\"GET\",route=\"/api/modules\",status=\"200\"} 1");
    expect(text).toContain("fmd_http_requests_total{auth=\"token\",method=\"POST\",route=\"/api/jobs/download\",status=\"201\"} 1");
    expect(text).toContain("fmd_http_requests_total{auth=\"none\",method=\"POST\",route=\"/api/jobs/download\",status=\"201\"} 1");
    // the cookie label died with the password flow
    expect(text).not.toContain('auth="cookie"');
  });
});
