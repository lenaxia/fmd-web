// @vitest-environment node
/**
 * §10 FavoriteService production adapter — SqliteFavoritesService over
 * the REAL FavoritesEngine + SqliteLibraryStore (in-memory file) + a
 * scripted info service: the exact path the API routes take in
 * production (CRUD, the auto-download toggle, check-now, D4 import).
 * Offline; the wire projection (RFC 3339 timestamps, nullable fields)
 * is asserted against the OpenAPI FavoriteSchema.
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteFavoritesService } from '../../../src/runtime/favorites-service.js';
import { FavoritesEngine } from '../../../src/jobs/favorites/engine.js';
import { SqliteLibraryStore } from '../../../src/jobs/library/store.js';
import { downloadedChaptersKey } from '../../../src/jobs/library/merge.js';
import { FavoriteSchema } from '../../../src/api/schemas.js';
import type { NormalizedInfo } from '../../../src/api/services.js';
import { ApiError } from '../../../src/api/errors.js';
import { mkTmpDir, rmDir } from '../helpers.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const MANGA_URL = 'https://site.example/manga/x';

let dbFile = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
});

class ScriptedInfo {
  public info: NormalizedInfo;
  public fail: Error | undefined;

  constructor(chapterLinks: string[]) {
    this.info = {
      title: 'Fixture Manga',
      altTitles: '',
      authors: '',
      artists: '',
      genres: '',
      status: 'Ongoing',
      summary: '',
      coverLink: '',
      url: MANGA_URL,
      link: MANGA_URL,
      chapterLinks,
      chapterNames: chapterLinks.map((_, i) => `Ch. ${i + 1}`),
      numChapter: chapterLinks.length,
    };
  }

  async getInfo(_moduleId: string, _url: string): Promise<NormalizedInfo> {
    if (this.fail !== undefined) {
      throw this.fail;
    }
    return this.info;
  }
}

function openService(chapterLinks: string[]): {
  service: SqliteFavoritesService;
  info: ScriptedInfo;
  store: SqliteLibraryStore;
} {
  const dir = mkTmpDir('fav-service');
  dbFile = path.join(dir, 'app.db');
  const raw = new Database(dbFile);
  const store = new SqliteLibraryStore({ db: raw, libraryRoot: path.join(dir, 'library') });
  const info = new ScriptedInfo(chapterLinks);
  const engine = new FavoritesEngine({
    store,
    info,
    downloads: { createDownload: (input): { jobId: string } => ({ jobId: input.chapterLink }) },
    now: (): number => 1_760_000_000_000,
  });
  return { service: new SqliteFavoritesService(engine), info, store };
}

describe('SqliteFavoritesService (production adapter over the §7.2 engine)', (): void => {
  it('create → wire projection validating against the OpenAPI FavoriteSchema', async (): Promise<void> => {
    const { service } = openService(['https://site.example/ch/1']);
    const favorite = await service.create({ moduleId: MODULE, url: MANGA_URL, title: 'T' });
    expect(() => FavoriteSchema.parse(favorite)).not.toThrow();
    expect(favorite.id).toBe(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(favorite.autoDownload).toBe(false);
    // FMD2 Add parity: create does NOT live-fetch — the scheduler's
    // first check stamps these
    expect(favorite.currentChapter).toBeNull();
    expect(favorite.lastCheck).toBeNull();
    expect(favorite.newChapterCount).toBe(0);
    expect(favorite.title).toBe('T');
  });

  it('a duplicate create is a typed 409', async (): Promise<void> => {
    const { service } = openService([]);
    await service.create({ moduleId: MODULE, url: MANGA_URL });
    await expect(service.create({ moduleId: MODULE, url: MANGA_URL })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  it('check-now: immediate CurrentChapter/Status update + badge, nothing queued when off', async (): Promise<void> => {
    const { service } = openService(['https://site.example/ch/1', 'https://site.example/ch/2']);
    await service.create({ moduleId: MODULE, url: MANGA_URL });

    const result = await service.checkNow(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(result.favorite.currentChapter).toBe(2);
    expect(result.favorite.status).toBe('Ongoing');
    expect(result.favorite.newChapterCount).toBe(2);
    expect(result.queuedDownloads).toBe(0);
    expect(result.newChapters.map((c) => c.link)).toEqual([
      'https://site.example/ch/1',
      'https://site.example/ch/2',
    ]);
  });

  it('toggle on → check-now enqueues through the pipeline and dual-writes the merge', async (): Promise<void> => {
    const { service, store } = openService(['https://site.example/ch/1', 'https://site.example/ch/2']);
    await service.create({ moduleId: MODULE, url: MANGA_URL });
    expect(service.update(downloadedChaptersKey(MODULE, MANGA_URL), { autoDownload: true }).autoDownload).toBe(true);

    const result = await service.checkNow(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(result.queuedDownloads).toBe(2);
    // dual-write: the favorite list holds BOTH chapters, the global row the new ones
    const key = downloadedChaptersKey(MODULE, MANGA_URL);
    expect(store.getFavoriteDownloadedList(key)).toContain('https://site.example/ch/1');
    expect(store.getFavoriteDownloadedList(key)).toContain('https://site.example/ch/2');
    expect(store.getDownloadedChapters(MODULE, MANGA_URL)).toBe(
      'https://site.example/ch/1\nhttps://site.example/ch/2\n',
    );
  });

  it('import marks every live chapter downloaded in the favorite list (global row untouched)', async (): Promise<void> => {
    const { service, store } = openService(['https://site.example/ch/1', 'https://site.example/ch/2']);
    const favorite = await service.import({ moduleId: MODULE, url: MANGA_URL });
    const key = downloadedChaptersKey(MODULE, MANGA_URL);
    expect(store.getFavoriteDownloadedList(key)).toBe(
      'https://site.example/ch/1\nhttps://site.example/ch/2\n',
    );
    expect(store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('');
    expect(favorite.newChapterCount).toBe(0);
    // follow-up check finds nothing new
    const check = await service.checkNow(key);
    expect(check.newChapters).toEqual([]);
  });

  it('update/remove: unknown ids are typed 404s; remove deletes only the favorite row', async (): Promise<void> => {
    const { service, store } = openService([]);
    const key = downloadedChaptersKey(MODULE, MANGA_URL);
    // update/remove are SYNC port methods — they throw the typed ApiError
    expect((): unknown => service.update('unknown', { autoDownload: true })).toThrow(ApiError);
    await expect(service.checkNow('unknown')).rejects.toMatchObject({ status: 404 });
    expect((): void => service.remove('unknown')).toThrow(ApiError);

    await service.create({ moduleId: MODULE, url: MANGA_URL });
    store.setDownloadedChapters(MODULE, MANGA_URL, 'https://site.example/ch/9\n');
    service.remove(key);
    expect(service.get(key)).toBeUndefined();
    expect(service.list()).toEqual([]);
    // the ledger row survives (delete-favorite contract)
    expect(store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('https://site.example/ch/9\n');
  });

  it('a failed live fetch propagates as a plain error (the route maps it to 502)', async (): Promise<void> => {
    const { service, info } = openService([]);
    await service.create({ moduleId: MODULE, url: MANGA_URL });
    info.fail = new Error('site down');
    await expect(service.checkNow(downloadedChaptersKey(MODULE, MANGA_URL))).rejects.toThrow('site down');
  });
});
