/**
 * GET/PUT /api/settings + the proxy settings surface (§9/§10, §5.4
 * SetProxy parity): global proxy typed validation, per-module proxy
 * override (set/clear), and the CONFIG-DRIVEN §5.11 browser-profile
 * capability flip (with the profile active, the satisfied known-broken
 * flags drop from /api/modules; without it they stand).
 */
import { describe, expect, it } from 'vitest';
import {
  buildHarness,
  expectEnvelope,
  MODULE_A_ID,
  MODULE_B_ID,
  MODULE_C_ID,
} from './helpers.js';

const NO_PROXY = { type: '', host: '', port: '', user: '', pass: '' };

describe('GET /api/settings', (): void => {
  it('defaults: no proxy (all-empty config) + browser profile disabled', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      proxy: NO_PROXY,
      browser: { enabled: false, url: '' },
    });
  });

  it('reflects the §5.11 profile config (config-driven)', async (): Promise<void> => {
    const h = buildHarness({ browserProfile: true });
    const res = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { browser: { enabled: boolean; url: string } };
    expect(body.browser.enabled).toBe(true);
    expect(body.browser.url).toBe('http://127.0.0.1:8191');
  });
});

describe('PUT /api/settings/proxy', (): void => {
  it('replaces the global proxy (five-string SetProxy semantics) and round-trips', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/proxy',
      payload: { type: 'SOCKS5', host: 'proxy.example', port: '1080', user: 'u', pass: 'pw' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy).toEqual({ type: 'SOCKS5', host: 'proxy.example', port: '1080', user: 'u', pass: 'pw' });
    const get = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().proxy.type).toBe('SOCKS5');
    // the all-empty config is the SetNoProxy path
    const clear = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/proxy',
      payload: NO_PROXY,
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().proxy).toEqual(NO_PROXY);
  });

  it('validation: a typed proxy requires a host; unknown types are rejected', async (): Promise<void> => {
    const h = buildHarness();
    const noHost = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/proxy',
      payload: { type: 'HTTP', host: '', port: '8080', user: '', pass: '' },
    });
    expect(noHost.statusCode).toBe(400);
    expectEnvelope(noHost.body, 'validation_error');
    const badType = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/proxy',
      payload: { type: 'FTP', host: 'h', port: '21', user: '', pass: '' },
    });
    expect(badType.statusCode).toBe(400);
    expectEnvelope(badType.body, 'validation_error');
    const nonString = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/proxy',
      payload: { type: 'HTTP', host: 'h', port: 8080, user: '', pass: '' },
    });
    expect(nonString.statusCode).toBe(400);
    // the service-level seam starts with no module override
    expect(h.modules.getProxyOverride(MODULE_A_ID)).toBeNull();
  });
});

describe('per-module proxy override (PUT /api/modules/:id proxy)', (): void => {
  it('sets, surfaces and clears the override (null = inherit global)', async (): Promise<void> => {
    const h = buildHarness();
    const set = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { proxy: { type: 'SOCKS4', host: 's.example', port: '1080', user: '', pass: '' } },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().proxy).toEqual({ type: 'SOCKS4', host: 's.example', port: '1080', user: '', pass: '' });
    // other modules stay on the global (null)
    const other = await h.app.inject({ method: 'GET', url: '/api/modules' });
    const beta = (other.json() as { modules: Array<{ id: string; proxy: unknown }> }).modules.find(
      (m) => m.id === MODULE_B_ID,
    );
    expect(beta?.proxy).toBeNull();
    const clear = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { proxy: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().proxy).toBeNull();
  });

  it('validation: module proxy obeys the same schema (bad type → 400)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { proxy: { type: 'BOGUS', host: 'h', port: '1', user: '', pass: '' } },
    });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'validation_error');
    const noHost = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_A_ID}`,
      payload: { proxy: { type: 'SOCKS5', host: '', port: '1', user: '', pass: '' } },
    });
    expect(noHost.statusCode).toBe(400);
  });

  it('the empty module update (nothing to change) still 400s', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'PUT', url: `/api/modules/${MODULE_A_ID}`, payload: {} });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'validation_error');
  });
});

describe('§5.11 browser profile capability flip (config-driven)', (): void => {
  it('without the profile: the D3 known-broken flags stand', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/modules' });
    const gamma = (
      res.json() as {
        modules: Array<{ id: string; capabilities: { known_broken_flags: string[]; requires_browser: boolean; requires_subprocess: boolean } }>;
      }
    ).modules.find((m) => m.id === MODULE_C_ID);
    expect(gamma?.capabilities.known_broken_flags).toEqual([
      'fmd.subprocess',
      'madara.run_html_load',
      'webdriver.bypass',
    ]);
    // requires_* stay truthful regardless
    expect(gamma?.capabilities.requires_browser).toBe(true);
    expect(gamma?.capabilities.requires_subprocess).toBe(true);
  });

  it('with the profile active: the satisfied flags flip away; requires_* stay', async (): Promise<void> => {
    const h = buildHarness({ browserProfile: true });
    const res = await h.app.inject({ method: 'GET', url: '/api/modules' });
    const gamma = (
      res.json() as {
        modules: Array<{ id: string; capabilities: { known_broken_flags: string[]; requires_browser: boolean; requires_subprocess: boolean } }>;
      }
    ).modules.find((m) => m.id === MODULE_C_ID);
    expect(gamma?.capabilities.known_broken_flags).toEqual([]);
    expect(gamma?.capabilities.requires_browser).toBe(true);
    expect(gamma?.capabilities.requires_subprocess).toBe(true);
    // unaffected modules stay clean
    const alpha = (res.json() as { modules: Array<{ id: string; capabilities: { known_broken_flags: string[] } }> })
      .modules.find((m) => m.id === MODULE_A_ID);
    expect(alpha?.capabilities.known_broken_flags).toEqual([]);
  });

  it('the flip applies to module updates too (PUT round-trip preserves the flipped set)', async (): Promise<void> => {
    const h = buildHarness({ browserProfile: true });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/modules/${MODULE_C_ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().capabilities.known_broken_flags).toEqual([]);
  });
});
