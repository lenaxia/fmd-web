// @vitest-environment node
/**
 * Import-from-FMD2 API contract (two-phase): analyze (multipart or zip,
 * read-only, preview) + apply (re-upload or staged token; idempotent
 * favorites upsert, opt-in credentials, supported-only settings). Every
 * failure mode is a typed 400 — never a 500.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, MODULE_A_ID, MODULE_B_ID } from '../api/helpers.js';
import { encryptFmd2Secret } from '../../src/import/fmd2/secrets.js';
import {
  UNMAPPED_BAD_ID,
  UNMAPPED_DEAD_ID,
  buildConfigJson,
  buildFavoritesDb,
  buildLedgerDb,
  buildModulesJson,
  buildSettingsJson,
  buildZip,
} from './fmd2-fixtures.js';

interface RawPart {
  readonly name: string;
  readonly data: Buffer;
}

/** A GENUINE multipart body (undici FormData → bytes + content-type). */
async function multipart(
  files: readonly RawPart[],
  fields: Readonly<Record<string, string>> = {},
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const file of files) {
    form.append('file', new Blob([new Uint8Array(file.data)]), file.name);
  }
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  const response = new Response(form);
  return {
    payload: Buffer.from(await response.arrayBuffer()),
    headers: { 'content-type': response.headers.get('content-type') ?? '' },
  };
}

/** The canonical fixture set: 2 mapped rows + 1 malformed-id + 1 dead-id. */
function fixtureFavoritesDb(): RawPart {
  return { name: 'favorites.db', data: buildFavoritesDb([
    { moduleId: MODULE_A_ID, link: '/manga/one', title: 'One', status: 'Ongoing', currentchapter: '12', downloadedchapterlist: 'Ch.001\nCh.002\n', saveto: 'C:\\manga\\one' },
    { moduleId: MODULE_B_ID, link: '/series/two', title: 'Two', status: 'Completed', currentchapter: '40', downloadedchapterlist: 'Ch.001\n', enabled: 0 },
    { moduleId: UNMAPPED_BAD_ID, link: '/typo', title: 'Malformed Site Row' },
    { moduleId: UNMAPPED_DEAD_ID, link: '/gone', title: 'Dead Site Row' },
  ]) };
}

function fixtureLedgerDb(): RawPart {
  return { name: 'downloadedchapters.db', data: buildLedgerDb([
    { moduleId: MODULE_A_ID, link: '/manga/one', chapters: 'Ch.001\nCh.002\nCh.003\n' },
    { moduleId: MODULE_B_ID, link: '/series/two', chapters: 'Ch.001\n' },
    { moduleId: UNMAPPED_DEAD_ID, link: '/gone', chapters: 'Ch.001\n' },
  ]) };
}

function fixtureSettingsDb(): { name: string; data: Buffer } {
  return {
    name: 'settings.json',
    data: buildSettingsJson({
      useProxy: true,
      proxyType: 'SOCKS5',
      proxyHost: 'proxy.lan',
      proxyPort: '1080',
      proxyUserSealed: encryptFmd2Secret('proxy-user'),
      proxyPassSealed: encryptFmd2Secret('proxy-pass'),
      timeout: 20,
      retry: 2,
      tasks: 4,
      threadsPerTask: 3,
      compress: 2,
      changeUnicode: true,
      unicodeChar: '_',
      removeMangaName: true,
      favStartup: true,
      favIntervalMinutes: 45,
    }),
  };
}

function fixtureModulesJson(): { name: string; data: Buffer } {
  return {
    name: 'modules.json',
    data: buildModulesJson(
      [
        {
          moduleId: MODULE_A_ID,
          enabled: true,
          account: { username: 'user1', password: 'pw-one', cookies: 'session=abc' },
        },
        { moduleId: MODULE_B_ID, enabled: false },
      ],
      encryptFmd2Secret,
    ),
  };
}

describe('POST /api/import/fmd2/analyze (phase 1 — preview, writes nothing)', (): void => {
  it('previews a multipart upload: favorites by site, unmapped ids, settings, credential FIELDS', async (): Promise<void> => {
    const h = buildHarness();
    const body = await multipart([fixtureFavoritesDb(), fixtureModulesJson(), fixtureSettingsDb()]);
    const response = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/analyze', ...body });
    expect(response.statusCode).toBe(200);
    const preview = response.json();
    expect(preview.files).toEqual(["favorites.db", "modules.json", "settings.json"]);
    expect(preview.favorites.total).toBe(4);
    expect(preview.favorites.importable).toBe(2);
    expect(preview.favorites.bySite).toEqual([
      { moduleId: MODULE_A_ID, siteName: 'AlphaSource', count: 1, mapped: true },
      { moduleId: MODULE_B_ID, siteName: 'BetaSource', count: 1, mapped: true },
    ]);
    expect(preview.favorites.unmappedSiteIds).toEqual([
      { id: UNMAPPED_BAD_ID, count: 1 },
      { id: UNMAPPED_DEAD_ID, count: 1 },
    ]);
    // Credential fields are NAMES ONLY — plaintext never travels.
    const serialized = response.body;
    expect(serialized).not.toContain('user1');
    expect(serialized).not.toContain('pw-one');
    expect(preview.credentials.sites).toEqual([
      { moduleId: MODULE_A_ID, siteName: 'AlphaSource', fields: ['username', 'password', 'cookies'] },
    ]);
    expect(preview.credentials.globalProxyAuth).toBe(true);
    // Settings: mappable keys + the unmapped enumeration.
    const keys = preview.settings.mappable.map((s: { key: string }): string => s.key);
    expect(keys).toEqual(expect.arrayContaining(['proxy', 'performance', 'output', 'favorites-scheduler']));
    const notImportableSources = preview.settings.notImportable.map((s: { source: string }): string => s.source);
    expect(notImportableSources).toEqual(expect.arrayContaining([
      'settings.json [saveto] SaveTo',
      'settings.json [saveto] PDFQuality',
      'settings.json [connections] DefaultUserAgent',
      'settings.json [droptarget] Mode',
    ]));
    expect(typeof preview.analyzeToken).toBe('string');
    // READ-ONLY: nothing written anywhere.
    expect(h.favorites.list()).toEqual([]);
    expect(h.settings.get().proxy.type).toBe('');
    expect(h.accounts.list()).toEqual([]);
    expect(h.modules.get(MODULE_B_ID)?.enabled).toBe(true);
  });

  it('previews a zip of the FMD2 data dir (nested userdata/ layout)', async (): Promise<void> => {
    const h = buildHarness();
    const zipBytes = await buildZip([
      { name: 'userdata/favorites.db', data: fixtureFavoritesDb().data },
      { name: 'userdata/downloadedchapters.db', data: fixtureLedgerDb().data },
      { name: 'userdata/settings.json', data: fixtureSettingsDb().data },
      { name: 'config.json', data: buildConfigJson() },
    ]);
    const body = await multipart([{ name: 'fmd2-backup.zip', data: zipBytes }]);
    const response = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/analyze', ...body });
    expect(response.statusCode).toBe(200);
    const preview = response.json();
    expect(preview.favorites.importable).toBe(2);
    expect(preview.downloadedLedger).toEqual({ rows: 3, matched: 2 });
    expect(preview.ignored).toEqual([
      { source: 'fmd2-backup.zip!config.json', reason: expect.stringContaining('bootstrap') },
    ]);
  });

  it('non-multipart is a 400, corrupt sqlite is a 400, oversize is a 400 — never 500', async (): Promise<void> => {
    const h = buildHarness();
    const notMultipart = await h.app.inject({
      method: 'POST',
      url: '/api/import/fmd2/analyze',
      payload: { hello: 'world' },
      headers: { 'content-type': 'application/json' },
    });
    expect(notMultipart.statusCode).toBe(400);
    expect(notMultipart.json().error.code).toBe('bad_request');

    const corrupt = await multipart([{ name: 'favorites.db', data: Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(128, 9)]) }]);
    const corruptResponse = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/analyze', ...corrupt });
    expect(corruptResponse.statusCode).toBe(400);
    expect(corruptResponse.json().error.code).toBe('bad_request');
    expect(corruptResponse.json().error.message).toContain('not a readable SQLite database');

    // The 100MB cap: content-length pre-check rejects before buffering.
    const small = await multipart([{ name: 'favorites.db', data: fixtureFavoritesDb().data }]);
    const oversize = await h.app.inject({
      method: 'POST',
      url: '/api/import/fmd2/analyze',
      payload: small.payload,
      headers: { ...small.headers, 'content-length': String(150 * 1024 * 1024) },
    });
    expect(oversize.statusCode).toBe(400);
    expect(oversize.json().error.message).toContain('100 MB cap');
  });

  it('an upload with no recognizable FMD2 file is a 400', async (): Promise<void> => {
    const h = buildHarness();
    const body = await multipart([{ name: 'notes.txt', data: Buffer.from('shopping list') }]);
    const response = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/analyze', ...body });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('no recognizable FMD2 file');
  });
});

describe('POST /api/import/fmd2/apply (phase 2 — the confirmed import)', (): void => {
  it('imports favorites through the ONE import path with canonical URLs + ledger merge; unmapped sites listed and skipped', async (): Promise<void> => {
    const h = buildHarness();
    const body = await multipart([
      { name: 'favorites.db', data: fixtureFavoritesDb().data },
      { name: 'downloadedchapters.db', data: fixtureLedgerDb().data },
    ]);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/import/fmd2/apply',
      ...body,
      headers: { ...body.headers },
    });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.favorites.created).toBe(2);
    expect(report.favorites.unmappedSiteIds).toEqual([
      { id: UNMAPPED_BAD_ID, count: 1 },
      { id: UNMAPPED_DEAD_ID, count: 1 },
    ]);
    expect(report.favorites.skipped).toEqual([
      expect.objectContaining({ reason: 'site not installed (unknown catalog id)' }),
      expect.objectContaining({ reason: 'site not installed (unknown catalog id)' }),
    ]);
    expect(report.downloadedLedgerRowsApplied).toBe(2);
    // Canonical absolute URLs (v0.3.1 /api/info principle).
    const urls = h.favorites.list().map((favorite): string => favorite.url).sort();
    expect(urls).toEqual(['https://example.org/manga/one', 'https://example.org/series/two']);
    // Seed semantics: file fields carried (status/currentChapter/enabled).
    const one = h.favorites.get(`${MODULE_A_ID}https://example.org/manga/one`.toLowerCase());
    expect(one?.title).toBe('One');
    expect(one?.status).toBe('Ongoing');
    expect(one?.currentChapter).toBe(12);
    expect(one?.enabled).toBe(true);
    const two = h.favorites.get(`${MODULE_B_ID}https://example.org/series/two`.toLowerCase());
    expect(two?.enabled).toBe(false);
  });

  it('re-import of the same file creates no duplicates (idempotent upsert)', async (): Promise<void> => {
    const h = buildHarness();
    const body = await multipart([{ name: 'favorites.db', data: fixtureFavoritesDb().data }]);
    const first = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/apply', ...body });
    expect(first.statusCode).toBe(200);
    expect(first.json().favorites.created).toBe(2);
    const second = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/apply', ...body });
    expect(second.statusCode).toBe(200);
    const report = second.json();
    expect(report.favorites.created).toBe(0);
    expect(report.favorites.unchanged).toBe(2);
    expect(h.favorites.list()).toHaveLength(2);
  });

  it('applies selected settings to the server surface; proxy login only with credential consent', async (): Promise<void> => {
    const h = buildHarness();
    const body = await multipart([fixtureSettingsDb()]);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/import/fmd2/apply',
      ...body,
      headers: { ...body.headers },
    });
    expect(response.statusCode).toBe(200);
    // Default selections: nothing but favorites (favorites=false here →
    // the file has none; settings NOT selected → not applied).
    expect(h.settings.get().proxy.type).toBe('');
    // Now with explicit selections + proxy credential consent.
    const consent = await multipart([fixtureSettingsDb()], {
      selections: JSON.stringify({
        favorites: true,
        settings: ['proxy', 'performance', 'output', 'favorites-scheduler'],
        credentials: ['proxy'],
      }),
    });
    const applied = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/apply', ...consent });
    expect(applied.statusCode).toBe(200);
    const proxy = h.settings.get().proxy;
    expect(proxy).toMatchObject({ type: 'SOCKS5', host: 'proxy.lan', port: '1080', user: 'proxy-user', pass: 'proxy-pass' });
    expect(h.settings.get().performance).toMatchObject({ requestTimeoutSeconds: 20, retryCount: 2, parallelChapters: 4, threadsPerChapter: 3 });
    expect(h.settings.get().output).toMatchObject({ format: 'cbz', unicodeReplacement: true, unicodeReplacementChar: '_', removeMangaName: true });
    expect(h.settings.getFavoritesSettings()).toMatchObject({ checkAtStartup: true, intervalMinutes: 45 });
    // The report enumerates what was applied and what was NOT imported.
    const appliedKeys = applied.json().settings.applied.map((s: { key: string }): string => s.key);
    expect(appliedKeys).toEqual(expect.arrayContaining(['proxy', 'performance', 'output', 'favorites-scheduler']));
    const notImported = applied.json().settings.notImportable.map((s: { source: string }): string => s.source);
    expect(notImported).toEqual(expect.arrayContaining(['settings.json [saveto] SaveTo']));
    // WITHOUT consent the proxy login would have been dropped:
    const h2 = buildHarness();
    const noConsent = await multipart([fixtureSettingsDb()], {
      selections: JSON.stringify({ settings: ['proxy'] }),
    });
    await h2.app.inject({ method: 'POST', url: '/api/import/fmd2/apply', ...noConsent });
    expect(h2.settings.get().proxy).toMatchObject({ type: 'SOCKS5', host: 'proxy.lan', user: '', pass: '' });
  });

  it('credentials are opt-in and never echoed; website enable states map through', async (): Promise<void> => {
    const h = buildHarness();
    const body = await multipart([fixtureModulesJson(), fixtureFavoritesDb()]);
    // Default (no credentials selection): no account rows.
    const first = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/apply', ...body });
    expect(first.statusCode).toBe(200);
    expect(first.body).not.toContain('user1');
    expect(first.body).not.toContain('pw-one');
    expect(h.accounts.list()).toEqual([]);
    // Opt-in: the account lands with username visible, password sealed.
    const consent = await multipart([fixtureModulesJson(), fixtureFavoritesDb()], {
      selections: JSON.stringify({ credentials: [MODULE_A_ID], settings: ['website-enabled'] }),
    });
    const second = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/apply', ...consent });
    expect(second.statusCode).toBe(200);
    const accounts = h.accounts.list();
    expect(accounts).toEqual([expect.objectContaining({ moduleId: MODULE_A_ID, username: 'user1' })]);
    expect(second.json().credentials.imported).toEqual([
      { moduleId: MODULE_A_ID, fields: ['username', 'password', 'cookies'] },
    ]);
    // modules.json Settings.Enabled=false applied for BetaSource.
    expect(h.modules.get(MODULE_B_ID)?.enabled).toBe(false);
    expect(h.modules.get(MODULE_A_ID)?.enabled).toBe(true);
  });

  it('applies through the analyze token without re-uploading', async (): Promise<void> => {
    const h = buildHarness();
    const body = await multipart([fixtureFavoritesDb()]);
    const analyze = await h.app.inject({ method: 'POST', url: '/api/import/fmd2/analyze', ...body });
    const token = analyze.json().analyzeToken as string;
    const apply = await h.app.inject({
      method: 'POST',
      url: '/api/import/fmd2/apply',
      payload: { token },
      headers: { 'content-type': 'application/json' },
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().favorites.created).toBe(2);
    // An unknown token is a typed 404.
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/import/fmd2/apply',
      payload: { token: 'no-such-token' },
      headers: { 'content-type': 'application/json' },
    });
    expect(missing.statusCode).toBe(404);
    // JSON mode without a token is a 400.
    const noToken = await h.app.inject({
      method: 'POST',
      url: '/api/import/fmd2/apply',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    expect(noToken.statusCode).toBe(400);
  });
});
