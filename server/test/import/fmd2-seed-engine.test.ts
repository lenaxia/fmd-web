// @vitest-environment node
/**
 * The FMD2 favorites.db seed path through the REAL engine + store
 * (SqliteLibraryStore on an in-memory-file app.db): offline seeding
 * (no live fetch — MD_ImportToFavorites parity, uSilentThread.pas:507),
 * ledger merge into downloaded_chapters, and store-level idempotency.
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FavoritesEngine } from '../../src/jobs/favorites/engine.js';
import { SqliteLibraryStore } from '../../src/jobs/library/store.js';
import { downloadedChaptersKey } from '../../src/jobs/library/merge.js';
import type { NormalizedInfo } from '../../src/api/services.js';
import { mkTmpDir, rmDir } from '../jobs/helpers.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const MANGA_URL = 'https://site.example/manga/x';

let dbFile = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
});

/** The info seam — counts calls; the SEED path must NEVER hit it. */
class CountingInfo {
  public calls = 0;

  async getInfo(_moduleId: string, _url: string): Promise<NormalizedInfo> {
    this.calls += 1;
    return {
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
      chapterLinks: ['https://site.example/ch/1', 'https://site.example/ch/2'],
      chapterNames: ['Ch. 1', 'Ch. 2'],
      numChapter: 2,
    };
  }
}

function openEngine(): { engine: FavoritesEngine; store: SqliteLibraryStore; info: CountingInfo } {
  const dir = mkTmpDir('fmd2-seed');
  dbFile = path.join(dir, 'app.db');
  const raw = new Database(dbFile);
  const store = new SqliteLibraryStore({ db: raw, libraryRoot: path.join(dir, 'library') });
  const info = new CountingInfo();
  const engine = new FavoritesEngine({
    store,
    info,
    downloads: { createDownload: (input): { jobId: string } => ({ jobId: input.chapterLink }) },
    now: (): number => 1_760_000_000_000,
  });
  return { engine, store, info };
}

describe('FavoritesEngine.importFavorite seed mode (FMD2 favorites.db import)', (): void => {
  it('seeds offline: no live fetch, file fields carried, ledger row written', async (): Promise<void> => {
    const { engine, store, info } = openEngine();
    const result = await engine.importFavorite({
      moduleId: MODULE,
      url: MANGA_URL,
      title: 'Fixture Manga',
      seed: {
        status: 'Ongoing',
        currentChapter: 12,
        downloadedChapterList: 'Ch.001\nCh.002\n',
        enabled: true,
        dateAdded: Date.UTC(2025, 5, 1, 10, 0, 0),
        ledgerChapters: 'Ch.001\nCh.002\nCh.003\n',
      },
    });
    expect(info.calls).toBe(0);
    expect(result.importOutcome).toBe('created');
    expect(result.transferIngest).toBe(false);
    const row = store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(row?.title).toBe('Fixture Manga');
    expect(row?.status).toBe('Ongoing');
    expect(row?.currentChapter).toBe(12);
    expect(row?.enabled).toBe(true);
    expect(row?.dateAdded).toBe(Date.UTC(2025, 5, 1, 10, 0, 0));
    // The favorite's own list AND the global ledger both carry the file data.
    expect(row?.downloadedChapterList).toBe('Ch.001\nCh.002\n');
    expect(store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('Ch.001\nCh.002\nCh.003\n');
  });

  it('re-import of the same seed is idempotent: unchanged verdict, no duplicates, lists merge once', async (): Promise<void> => {
    const { engine, store } = openEngine();
    const seed = {
      status: 'Ongoing',
      currentChapter: 12,
      downloadedChapterList: 'Ch.001\nCh.002\n',
      enabled: true,
      dateAdded: Date.UTC(2025, 5, 1, 10, 0, 0),
      ledgerChapters: 'Ch.001\nCh.002\n',
    };
    const first = await engine.importFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'T', seed });
    expect(first.importOutcome).toBe('created');
    const second = await engine.importFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'T', seed });
    expect(second.importOutcome).toBe('unchanged');
    expect(store.listFavorites()).toHaveLength(1);
    expect(store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('Ch.001\nCh.002\n');
    expect(store.getFavoriteDownloadedList(downloadedChaptersKey(MODULE, MANGA_URL))).toBe('Ch.001\nCh.002\n');
  });

  it('a richer second import MERGES (union lists, updated verdict), never duplicates', async (): Promise<void> => {
    const { engine, store } = openEngine();
    await engine.importFavorite({
      moduleId: MODULE,
      url: MANGA_URL,
      title: 'T',
      seed: { downloadedChapterList: 'Ch.001\n', ledgerChapters: 'Ch.001\n' },
    });
    const second = await engine.importFavorite({
      moduleId: MODULE,
      url: MANGA_URL,
      title: 'T',
      seed: { downloadedChapterList: 'Ch.002\n', ledgerChapters: 'Ch.002\nch.001\n' },
    });
    expect(second.importOutcome).toBe('updated');
    // Case-insensitive merge keeps ONE variant of each chapter (M2).
    expect(store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('Ch.001\nCh.002\n');
    expect(store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))?.downloadedChapterList).toBe('Ch.001\nCh.002\n');
  });

  it('the tag-100 path (no seed) still live-ingests through the SAME primitive', async (): Promise<void> => {
    const { engine, store, info } = openEngine();
    const result = await engine.importFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'T' });
    expect(info.calls).toBe(1);
    expect(result.transferIngest).toBe(true);
    expect(result.importOutcome).toBe('created');
    // The live chapter list became the favorite's stored downloaded list.
    expect(store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))?.downloadedChapterList).toContain('https://site.example/ch/1');
  });
});
