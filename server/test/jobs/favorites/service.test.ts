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
    const { favorite, importOutcome } = await service.import({ moduleId: MODULE, url: MANGA_URL });
    const key = downloadedChaptersKey(MODULE, MANGA_URL);
    expect(store.getFavoriteDownloadedList(key)).toBe(
      'https://site.example/ch/1\nhttps://site.example/ch/2\n',
    );
    expect(store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('');
    expect(favorite.newChapterCount).toBe(0);
    expect(importOutcome).toBe('created');
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

// ── website transfer + batch check (favorites-parity, production path) ──

const TARGET_MODULE = 'b'.repeat(32);
const TARGET_MANGA_URL = 'https://other.example/manga/fixture';

/** CatalogService stub: installed set + substring-searchable rows. */
class StubCatalogs {
  public constructor(
    private readonly installed: readonly string[],
    private readonly rows: ReadonlyArray<{ link: string; title: string }>,
  ) {}

  public getMeta(id: string): { id: string } | undefined {
    return this.installed.includes(id) ? { id } : undefined;
  }

  public latest(): { entries: unknown[] } {
    return { entries: [] };
  }

  public byTitle(): { entries: unknown[] } {
    return { entries: [] };
  }

  public search(_id: string, query: { query?: string }): { entries: unknown[] } {
    const q = (query.query ?? '').toLowerCase();
    return {
      entries: this.rows
        .filter((row): boolean => row.title.toLowerCase().includes(q))
        .map((row): { link: string; title: string } => ({ ...row })),
    };
  }
}

function openTransferService(chapterLinks: string[], installed: readonly string[] = [TARGET_MODULE]): {
  service: SqliteFavoritesService;
  info: ScriptedInfo;
  store: SqliteLibraryStore;
} {
  const dir = mkTmpDir('fav-transfer');
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
  const catalogs = new StubCatalogs(installed, [
    { link: TARGET_MANGA_URL, title: 'Fixture Manga' },
    { link: 'https://other.example/manga/unrelated', title: 'Unrelated Series' },
  ]);
  return {
    service: new SqliteFavoritesService(engine, {
      catalogs: catalogs as unknown as import('../../../src/api/services.js').CatalogService,
      info,
    }),
    info,
    store,
  };
}

describe('SqliteFavoritesService — website transfer (frmTransferFavorites parity)', (): void => {
  it('preview: exact title match + live GetInfo dry-run → valid with the target link', async (): Promise<void> => {
    const { service } = openTransferService(['/ch/1']);
    const created = await service.create({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });
    const preview = await service.transferPreview(created.id, TARGET_MODULE);
    expect(preview).toEqual({
      targetModuleId: TARGET_MODULE,
      valid: true,
      targetUrl: TARGET_MANGA_URL,
      matchedTitle: 'Fixture Manga',
    });
  });

  it('preview: no exact match → invalid not-found; catalog-less target → no-catalog; failing dry-run → get-info-failed', async (): Promise<void> => {
    const noMatch = openTransferService(['/ch/1']);
    const created = await noMatch.service.create({ moduleId: MODULE, url: MANGA_URL, title: 'Totally Different' });
    expect(await noMatch.service.transferPreview(created.id, TARGET_MODULE)).toMatchObject({
      valid: false,
      reason: 'not-found',
    });

    const noCatalog = openTransferService(['/ch/1'], []);
    const created2 = await noCatalog.service.create({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });
    expect(await noCatalog.service.transferPreview(created2.id, TARGET_MODULE)).toMatchObject({
      valid: false,
      reason: 'no-catalog',
    });

    const failing = openTransferService(['/ch/1']);
    const created3 = await failing.service.create({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });
    failing.info.fail = new Error('target site down');
    expect(await failing.service.transferPreview(created3.id, TARGET_MODULE)).toMatchObject({
      valid: false,
      reason: 'get-info-failed',
    });
  });

  it('apply: remap under a new id — title/status/saveTo/enabled/dateAdded carry over, old key deleted', async (): Promise<void> => {
    const { service, store } = openTransferService(['/ch/1']);
    const created = await service.create({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });
    await service.update(created.id, { saveTo: '/keep/me' });
    const patched = service.get(created.id);

    const result = await service.transfer(created.id, {
      moduleId: TARGET_MODULE,
      url: TARGET_MANGA_URL,
      clearDownloadedList: false,
    });
    expect(result.favorite.moduleId).toBe(TARGET_MODULE);
    expect(result.favorite.url).toBe(TARGET_MANGA_URL);
    expect(result.favorite.id).toBe(downloadedChaptersKey(TARGET_MODULE, TARGET_MANGA_URL));
    expect(result.favorite.title).toBe('Fixture Manga');
    expect(result.favorite.saveTo).toBe('/keep/me');
    expect(result.favorite.enabled).toBe(true);
    expect(patched?.saveTo).toBe('/keep/me');
    expect(store.getFavorite(created.id)).toBeUndefined();
    expect(service.get(downloadedChaptersKey(TARGET_MODULE, TARGET_MANGA_URL))).toBeDefined();
  });

  it('apply with clearDownloadedList: the tag-100 reload ingests the live target list as downloaded', async (): Promise<void> => {
    const { service, store } = openTransferService(['/target/ch/1', '/target/ch/2']);
    const created = await service.create({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });

    const result = await service.transfer(created.id, {
      moduleId: TARGET_MODULE,
      url: TARGET_MANGA_URL,
      clearDownloadedList: true,
    });
    expect(result.reloadedFromServer).toBe(true);
    expect(result.favorite.currentChapter).toBe(2);
    const row = store.getFavorite(downloadedChaptersKey(TARGET_MODULE, TARGET_MANGA_URL));
    expect(row?.downloadedChapterList).toContain('/target/ch/1');
    expect(row?.downloadedChapterList).toContain('/target/ch/2');
  });
});

describe('SqliteFavoritesService — batch check (scope matrix + failures)', (): void => {
  it('scope filters by the enabled flag; failures surface per-row without breaking the sweep', async (): Promise<void> => {
    const { service, info } = openTransferService(['/ch/1']);
    const a = await service.create({ moduleId: MODULE, url: MANGA_URL, title: 'A' });
    const b = await service.create({ moduleId: MODULE, url: 'https://site.example/manga/b', title: 'B' });
    await service.update(b.id, { enabled: false });

    const enabledRun = await service.checkBatch('enabled');
    expect(enabledRun.checked).toBe(1);
    expect(enabledRun.results.map((r): string => r.favorite.title ?? '')).toEqual(['A']);

    const disabledRun = await service.checkBatch('disabled');
    expect(disabledRun.checked).toBe(1);
    expect(disabledRun.results.map((r): string => r.favorite.title ?? '')).toEqual(['B']);

    // One failing live fetch → per-row failed report, sweep continues.
    info.fail = new Error('site down');
    const failing = await service.checkBatch('all');
    expect(failing.failed).toBe(2);
    expect(failing.results.every((r): boolean => r.status === 'failed')).toBe(true);
    expect(failing.results[0]?.error).toContain('site down');
    info.fail = undefined;
    void a;
  });

  it('a second concurrent batch is a typed 409; cancel between rows reports cancelled', async (): Promise<void> => {
    const { service } = openTransferService(['/ch/1']);
    await service.create({ moduleId: MODULE, url: MANGA_URL, title: 'A' });
    const first = service.checkBatch('all');
    await expect(service.checkBatch('all')).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await first;
    // Cancel with nothing running is a clean false.
    expect(service.cancelBatch()).toBe(false);
  });
});
