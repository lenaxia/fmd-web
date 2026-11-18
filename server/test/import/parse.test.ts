// @vitest-environment node
/**
 * FMD2 file parsing against the pinned desktop-source semantics:
 * favorites.db (current + legacy layouts), downloadedchapters.db,
 * settings.json (nested + flat TJSONIniFile variants), modules.json
 * (sealed accounts decrypted in-memory), config.json detection, and
 * the zip-of-data-dir path. Corruption is a Fmd2ParseError (→ 400).
 */
import { describe, expect, it } from 'vitest';
import { parseFmd2Upload, parseFmd2DateTime } from '../../src/import/fmd2/parse.js';
import { encryptFmd2Secret } from '../../src/import/fmd2/secrets.js';
import {
  UNMAPPED_BAD_ID,
  buildFavoritesDb,
  buildLedgerDb,
  buildModulesJson,
  buildSettingsJson,
  buildConfigJson,
  buildZip,
} from './fmd2-fixtures.js';

const MODULE_A = 'a'.repeat(32);

describe('parseFmd2DateTime (SQLiteData.PrepSQLValue(TDateTime) form)', (): void => {
  it('parses the YYYY-MM-DD HH:MM:SS.mmm shape to epoch ms', (): void => {
    expect(parseFmd2DateTime('2025-06-01 10:00:00.000')).toBe(Date.UTC(2025, 5, 1, 10, 0, 0, 0));
    expect(parseFmd2DateTime('2020-02-29 23:59:59.999')).toBe(Date.UTC(2020, 1, 29, 23, 59, 59, 999));
  });
  it('tolerates the second-precision form and rejects garbage', (): void => {
    expect(parseFmd2DateTime('2025-06-01 10:00:00')).toBe(Date.UTC(2025, 5, 1, 10, 0, 0));
    expect(parseFmd2DateTime('')).toBeNull();
    expect(parseFmd2DateTime('not a date')).toBeNull();
    expect(parseFmd2DateTime(42)).toBeNull();
  });
});

describe('favorites.db parsing (FavoritesDB.pas schema)', (): void => {
  it('reads rows with column semantics intact', (): void => {
    const upload = parseFmd2Upload([
      {
        name: 'favorites.db',
        bytes: buildFavoritesDb([
          {
            moduleId: MODULE_A,
            link: '/manga/one',
            title: 'One',
            status: 'Ongoing',
            currentchapter: '12',
            downloadedchapterlist: 'Ch.001\nCh.002\n',
            saveto: 'C:\\manga\\one',
            enabled: 1,
            dateadded: '2025-06-01 10:00:00.000',
          },
          { moduleId: UNMAPPED_BAD_ID, link: '/dead', title: 'Dead Site Entry', enabled: 0 },
        ]),
      },
    ]);
    expect(upload.hasFavoritesDb).toBe(true);
    expect(upload.favorites).toHaveLength(2);
    const first = upload.favorites[0]!;
    expect(first.moduleId).toBe(MODULE_A);
    expect(first.link).toBe('/manga/one');
    expect(first.title).toBe('One');
    expect(first.currentChapter).toBe(12);
    expect(first.downloadedChapterList).toBe('Ch.001\nCh.002\n');
    expect(first.enabled).toBe(true);
    expect(first.dateAddedMs).toBe(Date.UTC(2025, 5, 1, 10, 0, 0));
    expect(upload.favorites[1]!.enabled).toBe(false);
  });

  it('legacy website-column rows carry the website as the module reference', (): void => {
    const upload = parseFmd2Upload([
      {
        name: 'favorites.db',
        bytes: buildFavoritesDb([{ website: 'MangaHere', link: '/old', title: 'FMD1 Entry', legacyWebsite: true }]),
      },
    ]);
    expect(upload.favorites).toHaveLength(1);
    expect(upload.favorites[0]!.moduleId).toBe('MangaHere');
  });
});

describe('downloadedchapters.db parsing (DownloadedChaptersDB.pas schema)', (): void => {
  it('reads id/chapters rows keyed LowerCase(moduleid+link)', (): void => {
    const upload = parseFmd2Upload([
      {
        name: 'downloadedchapters.db',
        bytes: buildLedgerDb([{ moduleId: MODULE_A, link: '/manga/one', chapters: 'Ch.001\nCh.002\n' }]),
      },
    ]);
    expect(upload.hasLedgerDb).toBe(true);
    expect(upload.ledger).toEqual([{ id: `${MODULE_A}/manga/one`, chapters: 'Ch.001\nCh.002\n' }]);
  });
});

describe('settings.json / config.json parsing', (): void => {
  it('flattens the nested TJSONIniFile sections', (): void => {
    const upload = parseFmd2Upload([{ name: 'settings.json', bytes: buildSettingsJson({ useProxy: true }) }]);
    const get = (section: string, key: string): string | number | boolean | undefined =>
      upload.settings.find((item): boolean => item.section === section && item.key === key)?.value;
    expect(get('connections', 'UseProxy')).toBe(true);
    expect(get('connections', 'NumberOfTasks')).toBe(4);
    expect(get('saveto', 'Compress')).toBe(1);
    expect(get('update', 'AutoCheckFavIntervalMinutes')).toBe(45);
  });

  it('accepts the flat "section/key" variant with identical semantics', (): void => {
    const upload = parseFmd2Upload([
      { name: 'settings.json', bytes: Buffer.from(JSON.stringify({ 'connections/Retry': 7, 'update/AutoCheckFavStartup': false })) },
    ]);
    expect(upload.settings).toContainEqual({ section: 'connections', key: 'Retry', value: 7 });
    expect(upload.settings).toContainEqual({ section: 'update', key: 'AutoCheckFavStartup', value: false });
  });

  it('config.json is detected and ignored (bootstrap only)', (): void => {
    const upload = parseFmd2Upload([{ name: 'config.json', bytes: buildConfigJson() }]);
    expect(upload.settings).toHaveLength(0);
    expect(upload.ignored).toEqual([
      { name: 'config.json', reason: expect.stringContaining('bootstrap') },
    ]);
  });

  it('invalid JSON is a parse error', (): void => {
    expect((): ReturnType<typeof parseFmd2Upload> =>
      parseFmd2Upload([{ name: 'settings.json', bytes: Buffer.from('{oops') }])).toThrow(/not valid JSON/);
  });
});

describe('modules.json parsing (WebsiteModules.pas SaveToFile shape)', (): void => {
  it('extracts enabled flags, per-site proxies and DECRYPTS sealed accounts', (): void => {
    const upload = parseFmd2Upload([
      {
        name: 'modules.json',
        bytes: buildModulesJson(
          [
            {
              moduleId: MODULE_A,
              enabled: false,
              proxy: { type: 'ptSOCKS5', host: 'site-proxy.lan', port: '1080' },
              account: { username: 'user1', password: 'pw-one', cookies: 'session=abc' },
            },
          ],
          encryptFmd2Secret,
        ),
      },
    ]);
    expect(upload.websites).toHaveLength(1);
    const site = upload.websites[0]!;
    expect(site.enabled).toBe(false);
    expect(site.proxy).toMatchObject({ kind: 'SOCKS5', host: 'site-proxy.lan', port: '1080' });
    // Decrypted in memory — the parser hands apply the plaintext.
    expect(site.account).toMatchObject({ username: 'user1', password: 'pw-one', cookies: 'session=abc' });
  });

  it('ptDefault proxies stay unset and ptDirect maps to the explicit-direct kind', (): void => {
    const upload = parseFmd2Upload([
      {
        name: 'modules.json',
        bytes: buildModulesJson(
          [
            { moduleId: MODULE_A, proxy: { type: 'ptDefault' } },
            { moduleId: 'b'.repeat(32), proxy: { type: 'ptDirect' } },
          ],
          encryptFmd2Secret,
        ),
      },
    ]);
    expect(upload.websites[0]!.proxy?.kind).toBe('unset');
    expect(upload.websites[1]!.proxy?.kind).toBe('');
  });
});

describe('zip of the FMD2 data dir', (): void => {
  it('expands and classifies nested entries by content', async (): Promise<void> => {
    const zipBytes = await buildZip([
      { name: 'userdata/favorites.db', data: buildFavoritesDb([{ moduleId: MODULE_A, link: '/z', title: 'Z' }]) },
      { name: 'userdata/downloadedchapters.db', data: buildLedgerDb([{ moduleId: MODULE_A, link: '/z', chapters: 'Ch.1\n' }]) },
      { name: 'userdata/settings.json', data: buildSettingsJson({}) },
      { name: 'userdata/modules.json', data: buildModulesJson([{ moduleId: MODULE_A }], encryptFmd2Secret) },
      { name: 'config.json', data: buildConfigJson() },
    ]);
    const upload = parseFmd2Upload([{ name: 'fmd2-backup.zip', bytes: zipBytes }]);
    expect(upload.hasFavoritesDb).toBe(true);
    expect(upload.hasLedgerDb).toBe(true);
    expect(upload.favorites).toHaveLength(1);
    expect(upload.settings.length).toBeGreaterThan(0);
    expect(upload.websites).toHaveLength(1);
    expect(upload.files).toContain('fmd2-backup.zip');
  });

  it('a corrupt zip is a parse error (never a crash)', (): void => {
    expect((): ReturnType<typeof parseFmd2Upload> =>
      parseFmd2Upload([{ name: 'backup.zip', bytes: Buffer.from('PK\u0003\u0004 definitely not a zip body') }])).toThrow(
      /unreadable zip/,
    );
  });

  it('corrupt sqlite bytes are a parse error', (): void => {
    const fake = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(256, 7)]);
    expect((): ReturnType<typeof parseFmd2Upload> =>
      parseFmd2Upload([{ name: 'favorites.db', bytes: fake }])).toThrow(/not a readable SQLite database/);
  });

  it('a .sqlite-named non-database is rejected explicitly', (): void => {
    expect((): ReturnType<typeof parseFmd2Upload> =>
      parseFmd2Upload([{ name: 'db.sqlite', bytes: Buffer.from('just text') }])).toThrow(/expected an SQLite database/);
  });
});
