// @vitest-environment node
/**
 * Synthetic FMD2 data-file fixtures, generated from the PINNED desktop
 * source semantics (/workspace/FMD2):
 *
 * - favorites.db / downloadedchapters.db: the exact CREATE shapes of
 *   baseunits/FavoritesDB.pas:56-71 and DownloadedChaptersDB.pas:118-129
 *   (better-sqlite3 :memory: + serialize → real SQLite bytes).
 * - settings.json / config.json: the TJSONIniFile section shapes read
 *   by frmMain.pas LoadSettings (connections / saveto / update …).
 * - modules.json: the WebsiteModules.pas:609-687 SaveToFile shape,
 *   with Account values sealed through the DCPcrypt-compatible
 *   encryptor (uBaseUnit.pas:1559 oracle — see secrets.ts).
 * - zips: archiver-produced (the same shapes stock zip tools write).
 */
import Database from 'better-sqlite3';
import archiver from 'archiver';

/** The malformed ColorcitoScan-style catalog id (v0.3.1 search-500 lesson). */
export const UNMAPPED_BAD_ID = '5450026642ecrrd48apotd81e57f8e40';
/** A well-formed hex id that simply resolves to nothing in the catalog. */
export const UNMAPPED_DEAD_ID = 'd'.repeat(32);

export interface FixtureFavorite {
  readonly moduleId?: string;
  readonly website?: string;
  readonly link: string;
  readonly title: string;
  readonly status?: string;
  readonly currentchapter?: string;
  readonly downloadedchapterlist?: string;
  readonly saveto?: string;
  readonly enabled?: number;
  readonly dateadded?: string;
  /** legacy layouts: omit moduleid, carry website instead */
  readonly legacyWebsite?: boolean;
}

const FAVORITES_COLUMNS =
  '"id" VARCHAR(3000) NOT NULL PRIMARY KEY,"order" INTEGER,"enabled" BOOLEAN,"moduleid" TEXT,' +
  '"link" TEXT,"title" TEXT,"status" TEXT,"currentchapter" TEXT,"downloadedchapterlist" TEXT,' +
  '"saveto" TEXT,"dateadded" DATETIME,"datelastchecked" DATETIME,"datelastupdated" DATETIME';

export function buildFavoritesDb(rows: readonly FixtureFavorite[]): Buffer {
  const legacy = rows.some((row): boolean => row.legacyWebsite === true);
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE "favorites" (${FAVORITES_COLUMNS}${legacy ? ',"website" TEXT' : ''});`);
  const insert = db.prepare(
    `INSERT INTO "favorites" ("id","order","enabled","moduleid","link","title","status","currentchapter","downloadedchapterlist","saveto","dateadded","datelastchecked","datelastupdated"${
      legacy ? ',"website"' : ''
    }) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?${legacy ? ',?' : ''})`,
  );
  let order = 0;
  for (const row of rows) {
    const moduleId = row.moduleId ?? '';
    const website = row.website ?? '';
    const id = (moduleId !== '' ? moduleId : website).toLowerCase() + row.link;
    const base: unknown[] = [
      id,
      order,
      row.enabled ?? 1,
      moduleId,
      row.link,
      row.title,
      row.status ?? 'Ongoing',
      row.currentchapter ?? '0',
      row.downloadedchapterlist ?? '',
      row.saveto ?? '',
      row.dateadded ?? '2025-06-01 10:00:00.000',
      '2025-06-02 11:00:00.000',
      '2025-06-03 12:00:00.000',
    ];
    if (legacy) {
      base.push(website);
    }
    insert.run(...base);
    order += 1;
  }
  const bytes = db.serialize();
  db.close();
  return Buffer.from(bytes);
}

export interface FixtureLedgerRow {
  readonly moduleId: string;
  readonly link: string;
  readonly chapters: string;
}

export function buildLedgerDb(rows: readonly FixtureLedgerRow[]): Buffer {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE "downloadedchapters" ("id" VARCHAR(3000) NOT NULL PRIMARY KEY,"chapters" TEXT);');
  const insert = db.prepare('INSERT INTO "downloadedchapters" ("id","chapters") VALUES (?,?)');
  for (const row of rows) {
    insert.run((row.moduleId + row.link).toLowerCase(), row.chapters);
  }
  const bytes = db.serialize();
  db.close();
  return Buffer.from(bytes);
}

export interface FixtureSettings {
  readonly useProxy?: boolean;
  readonly proxyType?: string;
  readonly proxyHost?: string;
  readonly proxyPort?: string;
  readonly proxyUserSealed?: string;
  readonly proxyPassSealed?: string;
  readonly timeout?: number;
  readonly retry?: number;
  readonly tasks?: number;
  readonly threadsPerTask?: number;
  readonly compress?: number;
  readonly changeUnicode?: boolean;
  readonly unicodeChar?: string;
  readonly removeMangaName?: boolean;
  readonly favStartup?: boolean;
  readonly favIntervalMinutes?: number;
  readonly favAutoDownload?: boolean;
}

export function buildSettingsJson(settings: FixtureSettings): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        connections: {
          NumberOfTasks: settings.tasks ?? 4,
          NumberOfThreadsPerTask: settings.threadsPerTask ?? 3,
          Retry: settings.retry ?? 2,
          ConnectionTimeout: settings.timeout ?? 20,
          DefaultUserAgent: 'FMD2 desktop UA',
          MaxFavoriteThreads: 5,
          UseProxy: settings.useProxy ?? false,
          ...(settings.useProxy === true
            ? {
                ProxyType: settings.proxyType ?? 'HTTP',
                Host: settings.proxyHost ?? 'proxy.lan',
                Port: settings.proxyPort ?? '1080',
                User: settings.proxyUserSealed ?? '',
                Pass: settings.proxyPassSealed ?? '',
              }
            : {}),
        },
        saveto: {
          SaveTo: 'C:\\Users\\me\\Downloads\\manga',
          Compress: settings.compress ?? 1,
          ChangeUnicodeCharacter: settings.changeUnicode ?? false,
          ChangeUnicodeCharacterStr: settings.unicodeChar ?? '_',
          RemoveMangaNameFromChapter: settings.removeMangaName ?? false,
          GenerateMangaFolder: true,
          PDFQuality: 90,
        },
        update: {
          AutoCheckFavStartup: settings.favStartup ?? true,
          AutoCheckFavInterval: true,
          AutoCheckFavIntervalMinutes: settings.favIntervalMinutes ?? 45,
          AutoCheckFavAutoDownload: settings.favAutoDownload ?? false,
        },
        droptarget: { Mode: 1, Opacity: 255 },
      },
      null,
      2,
    ),
  );
}

export interface FixtureWebsiteModule {
  readonly moduleId: string;
  readonly enabled?: boolean;
  readonly proxy?: {
    readonly type?: string;
    readonly host?: string;
    readonly port?: string;
    readonly user?: string;
    readonly pass?: string;
  };
  readonly account?: {
    readonly enabled?: boolean;
    readonly username?: string;
    readonly password?: string;
    readonly cookies?: string;
  };
  readonly cookies?: number;
}

export function buildModulesJson(
  sites: readonly FixtureWebsiteModule[],
  seal: (value: string) => string,
): Buffer {
  return Buffer.from(
    JSON.stringify(
      sites.map((site): Record<string, unknown> => ({
        ID: site.moduleId,
        Settings: {
          Enabled: site.enabled ?? true,
          MaxTaskLimit: 0,
          ...(site.proxy !== undefined
            ? {
                HTTP: {
                  Proxy: {
                    ProxyType: site.proxy.type ?? 'ptDefault',
                    ProxyHost: site.proxy.host ?? '',
                    ProxyPort: site.proxy.port ?? '',
                    ProxyUsername: site.proxy.user ?? '',
                    ProxyPassword: site.proxy.pass ?? '',
                  },
                },
              }
            : {}),
        },
        ...(site.account !== undefined
          ? {
              Account: {
                Enabled: site.account.enabled ?? true,
                Username: seal(site.account.username ?? ''),
                Password: seal(site.account.password ?? ''),
                Cookies: seal(site.account.cookies ?? ''),
              },
            }
          : {}),
        ...(site.cookies !== undefined && site.cookies > 0
          ? { Cookies: Array.from({ length: site.cookies }, (_, i): Record<string, unknown> => ({ Name: `c${i}`, Value: 'v' })) }
          : {}),
      })),
      null,
      2,
    ),
  );
}

export function buildConfigJson(): Buffer {
  return Buffer.from(
    JSON.stringify({ config: { default_selected_websites: '', db_url: 'https://db.local', update_url: 'https://upd.local', update_package_name: 'fmd' } }, null, 2),
  );
}

/** A zip built the way stock tools build them (archiver → deflate). */
export async function buildZip(files: readonly { name: string; data: Buffer }[]): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject): void => {
    archive.on('data', (chunk: Buffer): void => {
      chunks.push(chunk);
    });
    archive.on('end', (): void => resolve());
    archive.on('error', (err): void => reject(err));
  });
  for (const file of files) {
    archive.append(file.data, { name: file.name });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}
