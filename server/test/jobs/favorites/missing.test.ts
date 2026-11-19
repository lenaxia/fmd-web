// @vitest-environment node
/**
 * [pipe-health] Missing-chapter check tests (FMD2 uFavoritesManager
 * FCheckMissing parity, web-adapted per DESIGN-NORTHSTAR §6): the
 * REVERSE link-diff and the engine cycle over a REAL SqliteLibraryStore
 * (in-memory file) + a scripted info service.
 *
 * Pinned:
 *   1. pure diff: missing = stored NOT IN live (the exact complement
 *      of the new-chapter diff), ASCII-case-insensitive link equality,
 *      stored order preserved, duplicates stay distinct;
 *   2. the engine cycle reports per favorite AND persists only the
 *      DoCheckMissing observational bookkeeping (status/count/
 *      lastCheck) — the downloaded list is NEVER rewritten, nothing is
 *      enqueued, no auto-action, ever (the charter's core invariant);
 *   3. empty-link favorites skip (:397-399 parity); unknown ids 404;
 *   4. a failed live fetch propagates (the API maps it to a typed 502).
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FavoritesEngine, type FavoriteDownloadQueue } from '../../../src/jobs/favorites/engine.js';
import { missingChapters, newChapterPositions } from '../../../src/jobs/favorites/diff.js';
import { SqliteLibraryStore } from '../../../src/jobs/library/store.js';
import { downloadedChaptersKey } from '../../../src/jobs/library/merge.js';
import { ApiError } from '../../../src/api/errors.js';
import type { NormalizedInfo } from '../../../src/api/services.js';
import type { FavoriteRow } from '../../../src/jobs/library/store.js';
import { mkTmpDir, rmDir } from '../helpers.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const MANGA_URL = 'https://site.example/manga/x';

let dbFile = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
});

/** Scripted GetInfo: throws when `fail` is set, else returns `info`. */
class ScriptedInfo {
  public info: NormalizedInfo = emptyInfo([]);
  public fail: Error | undefined;

  async getInfo(_moduleId: string, _url: string): Promise<NormalizedInfo> {
    if (this.fail !== undefined) {
      throw this.fail;
    }
    return this.info;
  }
}

/** Pipeline stand-in: any enqueue is a test failure (no auto-action). */
class ForbiddingQueue implements FavoriteDownloadQueue {
  public created = 0;

  createDownload(): { jobId: string } {
    this.created += 1;
    throw new Error('checkMissing must never enqueue downloads');
  }
}

function emptyInfo(chapterLinks: string[]): NormalizedInfo {
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
    chapterLinks,
    chapterNames: chapterLinks.map((_, i) => `Ch. ${i + 1}`),
    numChapter: chapterLinks.length,
  };
}

function lines(links: readonly string[]): string {
  return links.length === 0 ? '' : `${links.join('\n')}\n`;
}

interface Harness {
  readonly store: SqliteLibraryStore;
  readonly engine: FavoritesEngine;
  readonly info: ScriptedInfo;
  readonly downloads: ForbiddingQueue;
}

let clock = 1_000_000;

function openHarness(): Harness {
  const dir = mkTmpDir('fav-missing');
  dbFile = path.join(dir, 'app.db');
  const raw = new Database(dbFile);
  const store = new SqliteLibraryStore({ db: raw, libraryRoot: path.join(dir, 'library') });
  const info = new ScriptedInfo();
  const downloads = new ForbiddingQueue();
  const engine = new FavoritesEngine({
    store,
    info,
    downloads,
    now: (): number => (clock += 1_000),
  });
  return { store, engine, info, downloads };
}

function seedFavorite(
  store: SqliteLibraryStore,
  opts?: { downloadedChapterList?: string; url?: string },
): string {
  const mangaKey = downloadedChaptersKey(MODULE, opts?.url ?? MANGA_URL);
  const row: FavoriteRow = {
    mangaKey,
    moduleId: MODULE,
    url: opts?.url ?? MANGA_URL,
    title: 'Fixture Manga',
    autoDownload: false,
    newChapterCount: 0,
    downloadedChapterList: opts?.downloadedChapterList ?? '',
  };
  store.upsertFavorite(row);
  return mangaKey;
}

describe('missingChapters — the reverse link-diff', (): void => {
  it('reports stored links the live list no longer contains (stored order)', (): void => {
    const stored = lines(['/a', '/removed', '/b', '/gone', '/c']);
    const live = ['/a', '/b', '/c', '/new'];
    expect(missingChapters(live, stored)).toEqual(['/removed', '/gone']);
  });

  it('is the exact complement of the forward new-chapter diff', (): void => {
    const stored = lines(['/kept', '/missing', '/also-missing']);
    const live = ['/kept', '/fresh'];
    expect(newChapterPositions(live, stored)).toEqual([1]);
    expect(missingChapters(live, stored)).toEqual(['/missing', '/also-missing']);
  });

  it('link equality is ASCII-case-insensitive (AnsiCompareText parity)', (): void => {
    const stored = lines(['/Ch/One', '/ch/two']);
    const live = ['/CH/ONE', '/ch/two'];
    expect(missingChapters(live, stored)).toEqual([]);
  });

  it('an emptied site list reports every stored chapter', (): void => {
    const stored = lines(['/a', '/b']);
    expect(missingChapters([], stored)).toEqual(['/a', '/b']);
    // And an empty stored list reports nothing, whatever the site does.
    expect(missingChapters(['/a'], '')).toEqual([]);
  });

  it('duplicate stored lines stay distinct entries', (): void => {
    const stored = lines(['/dup', '/dup']);
    expect(missingChapters([], stored)).toEqual(['/dup', '/dup']);
  });
});

describe('FavoritesEngine.checkMissing — the manual cycle', (): void => {
  it('reports removed chapters per favorite and NEVER rewrites the stored list', async (): Promise<void> => {
    const h = openHarness();
    const storedList = lines(['/ch/1', '/ch/2', '/ch/3']);
    const id = seedFavorite(h.store, { downloadedChapterList: storedList });
    h.info.info = emptyInfo(['/ch/1', '/ch/3', '/ch/4']);

    const result = await h.engine.checkMissing(id);

    expect(result.outcome).toBe('checked');
    expect(result.missingChapters).toEqual(['/ch/2']);
    // Observational bookkeeping persisted (DoCheckMissing :421-422/:509).
    const row = h.store.getFavorite(id);
    expect(row?.currentChapter).toBe(3);
    expect(row?.status).toBe('Ongoing');
    expect(row?.lastCheck).toBeDefined();
    // THE invariant: downloaded truth unchanged — /ch/2 stays recorded.
    expect(row?.downloadedChapterList).toBe(storedList);
    expect(result.favorite.downloadedChapterList).toBe(storedList);
    // No auto-action: nothing enqueued, lastUpdated untouched.
    expect(h.downloads.created).toBe(0);
    expect(row?.lastUpdated).toBeUndefined();
  });

  it('a favorite with nothing missing reports an empty list', async (): Promise<void> => {
    const h = openHarness();
    const id = seedFavorite(h.store, { downloadedChapterList: lines(['/a']) });
    h.info.info = emptyInfo(['/a', '/b']);
    const result = await h.engine.checkMissing(id);
    expect(result.missingChapters).toEqual([]);
    expect(h.store.getFavorite(id)?.downloadedChapterList).toBe(lines(['/a']));
  });

  it('a link-less favorite skips before any fetch (:397-399 parity)', async (): Promise<void> => {
    const h = openHarness();
    const id = seedFavorite(h.store, { url: '' });
    const result = await h.engine.checkMissing(id);
    expect(result.outcome).toBe('skipped');
    expect(result.missingChapters).toEqual([]);
  });

  it('an unknown favorite is a typed 404', async (): Promise<void> => {
    const h = openHarness();
    await expect(h.engine.checkMissing('nosuchkey')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    } satisfies Partial<ApiError>);
  });

  it('a failed live fetch propagates (the route maps it to a 502)', async (): Promise<void> => {
    const h = openHarness();
    const id = seedFavorite(h.store, { downloadedChapterList: lines(['/a']) });
    h.info.fail = new Error('site unreachable');
    await expect(h.engine.checkMissing(id)).rejects.toThrow('site unreachable');
  });
});
