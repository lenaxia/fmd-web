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
    // toMatchObject (not toEqual): settings carries more additive groups
    // (output defaults, favorites scheduler, …) owned by their stories —
    // THIS test pins the proxy + browser dimensions it names.
    expect(res.json()).toMatchObject({
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

describe('output defaults (FMD2 Save-to parity subset, settings-parity)', (): void => {
  it('GET /api/settings defaults: zip + no rename template (+ the merged rename-toggle defaults)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json().output).toEqual({
      format: 'zip',
      chapterNameTemplate: '',
      unicodeReplacement: false,
      unicodeReplacementChar: '_',
      digitPadding: 0,
      removeMangaName: false,
    });
  });

  it('PUT /api/settings/output replaces format + template and round-trips', async (): Promise<void> => {
    const h = buildHarness();
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/output',
      payload: { format: 'cbz', chapterNameTemplate: '%MANGA% - %CHAPTER%' },
    });
    expect(put.statusCode).toBe(200);
    // toMatchObject: the [parity-sweep] rename-toggle fields ride along
    // with their defaults — this test pins THIS story's two fields.
    expect(put.json().output).toMatchObject({
      format: 'cbz',
      chapterNameTemplate: '%MANGA% - %CHAPTER%',
    });
    const get = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().output).toMatchObject({
      format: 'cbz',
      chapterNameTemplate: '%MANGA% - %CHAPTER%',
    });
    // Back to defaults (zip, template off).
    const reset = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/output',
      payload: { format: 'zip', chapterNameTemplate: '' },
    });
    expect(reset.json().output).toMatchObject({ format: 'zip', chapterNameTemplate: '' });
  });

  it('each packer format is accepted (zip/cbz/pdf/epub); omitted fields fall back to defaults', async (): Promise<void> => {
    const h = buildHarness();
    for (const format of ['zip', 'cbz', 'pdf', 'epub'] as const) {
      const res = await h.app.inject({
        method: 'PUT',
        url: '/api/settings/output',
        payload: { format },
      });
      expect(res.statusCode, format).toBe(200);
      expect(res.json().output.format).toBe(format);
      expect(res.json().output.chapterNameTemplate).toBe('');
    }
  });

  it('validation: FMD2 "none" (loose images) is DEFERRED — unknown formats are 400 envelopes', async (): Promise<void> => {
    const h = buildHarness();
    const none = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/output',
      payload: { format: 'none' },
    });
    expect(none.statusCode).toBe(400);
    expectEnvelope(none.body, 'validation_error');
    const bogus = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/output',
      payload: { format: 'rar' },
    });
    expect(bogus.statusCode).toBe(400);
    expectEnvelope(bogus.body, 'validation_error');
  });
});

describe('[parity-sweep] settings groups — M10/M2/M4/M13 + output itemized subset', (): void => {
  it('GET defaults mirror the pre-settings server truth', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      performance: { requestTimeoutSeconds: number; retryCount: number; parallelChapters: number; threadsPerChapter: number };
      retention: { days: number };
      filenamePolicy: { normalizePaths: boolean };
      diagnostics: { logEnabled: boolean; logLevel: string };
      output: { unicodeReplacement: boolean; unicodeReplacementChar: string; digitPadding: number; removeMangaName: boolean };
    };
    // 15 s pipeline default, 2 retries, 1 lane slot, 1 thread (the
    // pre-settings constants); 30 d retention; parity filenames; logs on.
    expect(body.performance).toEqual({
      requestTimeoutSeconds: 15,
      retryCount: 2,
      parallelChapters: 1,
      threadsPerChapter: 1,
    });
    expect(body.retention).toEqual({ days: 30 });
    expect(body.filenamePolicy).toEqual({ normalizePaths: false });
    expect(body.diagnostics).toEqual({ logEnabled: true, logLevel: 'info' });
    expect(body.output).toMatchObject({
      unicodeReplacement: false,
      unicodeReplacementChar: '_',
      digitPadding: 0,
      removeMangaName: false,
    });
  });

  it('PUT /api/settings/performance round-trips (full document returned + GET)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/performance',
      payload: { requestTimeoutSeconds: 30, retryCount: 4, parallelChapters: 2, threadsPerChapter: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { performance: unknown }).performance).toEqual({
      requestTimeoutSeconds: 30,
      retryCount: 4,
      parallelChapters: 2,
      threadsPerChapter: 3,
    });
    const get = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect((get.json() as { performance: unknown }).performance).toEqual({
      requestTimeoutSeconds: 30,
      retryCount: 4,
      parallelChapters: 2,
      threadsPerChapter: 3,
    });
  });

  it('PUT performance validation: out-of-range values are 400 envelopes', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/performance',
      payload: { requestTimeoutSeconds: 0, retryCount: 2, parallelChapters: 1, threadsPerChapter: 1 },
    });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'validation_error');
  });

  it('PUT /api/settings/retention round-trips (0 = keep forever is VALID)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/retention',
      payload: { days: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { retention: unknown }).retention).toEqual({ days: 0 });
    const tooOld = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/retention',
      payload: { days: 9999 },
    });
    expect(tooOld.statusCode).toBe(400);
    expectEnvelope(tooOld.body, 'validation_error');
  });

  it('PUT /api/settings/filename-policy round-trips', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/filename-policy',
      payload: { normalizePaths: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { filenamePolicy: unknown }).filenamePolicy).toEqual({ normalizePaths: true });
    const bad = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/filename-policy',
      payload: { normalizePaths: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');
  });

  it('PUT /api/settings/diagnostics round-trips (all four levels valid)', async (): Promise<void> => {
    const h = buildHarness();
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const res = await h.app.inject({
        method: 'PUT',
        url: '/api/settings/diagnostics',
        payload: { logEnabled: true, logLevel: level },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { diagnostics: unknown }).diagnostics).toEqual({ logEnabled: true, logLevel: level });
    }
    const off = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/diagnostics',
      payload: { logEnabled: false, logLevel: 'warn' },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { diagnostics: unknown }).diagnostics).toEqual({ logEnabled: false, logLevel: 'warn' });
    const bad = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/diagnostics',
      payload: { logEnabled: true, logLevel: 'verbose' },
    });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');
  });

  it('output itemized subset round-trips through PUT /api/settings/output', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/output',
      payload: {
        format: 'cbz',
        unicodeReplacement: true,
        unicodeReplacementChar: '-',
        digitPadding: 4,
        removeMangaName: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { output: unknown }).output).toMatchObject({
      format: 'cbz',
      unicodeReplacement: true,
      unicodeReplacementChar: '-',
      digitPadding: 4,
      removeMangaName: true,
    });
    // Old-shape bodies (pre-subset PUTs) keep working — zod defaults fill
    // the itemized fields (replace semantics, documented).
    const legacy = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/output',
      payload: { format: 'zip' },
    });
    expect(legacy.statusCode).toBe(200);
    expect((legacy.json() as { output: unknown }).output).toMatchObject({
      format: 'zip',
      unicodeReplacement: false,
    });
    // A multi-char replacement char is rejected.
    const bad = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/output',
      payload: { unicodeReplacementChar: 'ab' },
    });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');
  });
});
