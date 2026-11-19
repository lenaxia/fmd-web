// @vitest-environment node
/**
 * Favorites engine tests (DESIGN §7.2/D8) — the orchestration loop over
 * a REAL SqliteLibraryStore (in-memory file) + a scripted info service:
 *
 *   1. immediate CurrentChapter/Status update on GetInfo success
 *      (uFavoritesManager.pas:346-348) — before any download step;
 *   2. new-chapter diff over the stored list (case-insensitive);
 *   3. auto-download enqueues through the Phase-3 pipeline and the
 *      merged list dual-writes to BOTH favorite + downloaded_chapters
 *      (:1131-1133) — a follow-up check re-detects nothing;
 *   4. the tag-100 transfer branch (:356-361) via importFavorite —
 *      everything live becomes the favorite's stored list, global
 *      ledger untouched;
 *   5. a failed GetInfo propagates and leaves the row untouched.
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FavoritesEngine, type FavoriteDownloadQueue } from '../../../src/jobs/favorites/engine.js';
import { SqliteLibraryStore } from '../../../src/jobs/library/store.js';
import { downloadedChaptersKey } from '../../../src/jobs/library/merge.js';
import { parseJobPayload } from '../../../src/jobs/queue/payloads.js';
import type { NormalizedInfo } from '../../../src/api/services.js';
import { mkTmpDir, rmDir } from '../helpers.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const MANGA_URL = 'https://site.example/manga/x';

let dbFile = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
});

interface Harness {
  readonly store: SqliteLibraryStore;
  readonly engine: FavoritesEngine;
  readonly info: ScriptedInfo;
  readonly queue: RecordingQueue;
}

/** Scripted GetInfo: throws when `fail` is set, else returns `info`. */
class ScriptedInfo {
  public info: NormalizedInfo = emptyInfo([]);
  public fail: Error | undefined;
  public calls = 0;

  async getInfo(_moduleId: string, _url: string): Promise<NormalizedInfo> {
    this.calls += 1;
    if (this.fail !== undefined) {
      throw this.fail;
    }
    return this.info;
  }
}

/** Recording pipeline stand-in (the Phase-3 enqueue port). */
class RecordingQueue implements FavoriteDownloadQueue {
  readonly created: Array<{ moduleId: string; mangaUrl: string; chapterLink: string; chapterName?: string; mangaKey?: string; mangaTitle?: string }> = [];

  createDownload(input: {
    moduleId: string;
    mangaUrl: string;
    chapterLink: string;
    chapterName?: string;
    mangaKey?: string;
    mangaTitle?: string;
  }): { jobId: string } {
    this.created.push({ ...input });
    return { jobId: `job-${this.created.length}` };
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

function openHarness(): Harness {
  const dir = mkTmpDir('fav-engine');
  dbFile = path.join(dir, 'app.db');
  const raw = new Database(dbFile);
  const store = new SqliteLibraryStore({ db: raw, libraryRoot: path.join(dir, 'library') });
  const info = new ScriptedInfo();
  const queue = new RecordingQueue();
  const engine = new FavoritesEngine({
    store,
    info,
    downloads: queue,
    now: (): number => 1_000_000,
  });
  return { store, engine, info, queue };
}

describe('FavoritesEngine — DoCheck orchestration (§7.2)', (): void => {
  it('updates CurrentChapter + Status IMMEDIATELY on success, before any download step', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'X' });
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);

    const result = await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));

    expect(result.outcome).toBe('checked');
    const row = h.store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    // :346-348 — immediate update, persisted even though nothing downloaded
    expect(row?.currentChapter).toBe(2);
    expect(row?.status).toBe('Ongoing');
    expect(row?.lastCheck).toBe(1_000_000);
    expect(row?.newChapterCount).toBe(2);
    // no auto-download → no downloads, no dual-write
    expect(h.queue.created).toEqual([]);
    expect(h.store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('');
  });

  it('a fresh favorite reports EVERY live chapter as new (empty stored list)', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL });
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);

    const result = await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));

    expect(result.newChapters.map((c) => c.link)).toEqual([
      'https://site.example/ch/1',
      'https://site.example/ch/2',
    ]);
    expect(result.newChapters.map((c) => c.name)).toEqual(['Ch. 1', 'Ch. 2']);
    expect(result.newChapters.map((c) => c.position)).toEqual([0, 1]);
  });

  it('case variants in the stored list are NOT new (IndexOf membership parity)', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL });
    h.store.upsertFavorite({
      ...h.store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))!,
      downloadedChapterList: 'HTTPS://SITE.EXAMPLE/CH/1\nhttps://site.example/ch/2\n',
    });
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);

    const result = await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(result.newChapters).toEqual([]);
    expect(h.store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))?.newChapterCount).toBe(0);
  });

  it('auto-download: enqueues every new chapter through the pipeline, then dual-writes the merge', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture', autoDownload: true });
    h.store.upsertFavorite({
      ...h.store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))!,
      downloadedChapterList: 'https://site.example/ch/1\n',
    });
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2', 'https://site.example/ch/3']);

    const result = await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));

    // pipeline enqueue: exactly the new chapters, live order, provenance key
    expect(h.queue.created.map((j) => j.chapterLink)).toEqual([
      'https://site.example/ch/2',
      'https://site.example/ch/3',
    ]);
    expect(h.queue.created.every((j) => j.mangaKey === downloadedChaptersKey(MODULE, MANGA_URL))).toBe(true);
    expect(h.queue.created.every((j) => j.moduleId === MODULE)).toBe(true);
    expect(h.queue.created.every((j) => j.mangaTitle === 'Fixture')).toBe(true);
    expect(result.queuedDownloads).toBe(2);
    // dual-write :1131-1133 — favorite side merges case-insensitively
    const favorite = h.store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))!;
    expect(favorite.downloadedChapterList).toBe(
      'https://site.example/ch/1\nhttps://site.example/ch/2\nhttps://site.example/ch/3\n',
    );
    // dual-write :1133 — global row stores the NEW links (SetChapters semantics)
    expect(h.store.getDownloadedChapters(MODULE, MANGA_URL)).toBe(
      'https://site.example/ch/2\nhttps://site.example/ch/3\n',
    );
  });

  it('after the dual-write a follow-up check re-detects nothing (mid-download parity)', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL, autoDownload: true });
    h.info.info = emptyInfo(['https://site.example/ch/1']);
    await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(h.queue.created).toHaveLength(1);

    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);
    const second = await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    // ch/1 was dual-written; only ch/2 is new; ch/1 NOT re-enqueued
    expect(h.queue.created.map((j) => j.chapterLink)).toEqual([
      'https://site.example/ch/1',
      'https://site.example/ch/2',
    ]);
    expect(second.newChapters.map((c) => c.link)).toEqual(['https://site.example/ch/2']);
    // merged list converged: re-check is a no-op
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);
    const third = await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(third.newChapters).toEqual([]);
    expect(third.queuedDownloads).toBe(0);
  });

  it('auto-download off (default): new chapters update the badge but enqueue nothing', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL });
    h.info.info = emptyInfo(['https://site.example/ch/1']);

    const result = await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(result.newChapters).toHaveLength(1);
    expect(result.queuedDownloads).toBe(0);
    expect(h.queue.created).toEqual([]);
    expect(h.store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('');
  });

  it('the enqueued payload round-trips the queue schema incl. the mangaKey provenance', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL, autoDownload: true });
    h.info.info = emptyInfo(['https://site.example/ch/1']);
    await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    const payload = parseJobPayload(
      JSON.stringify({
        type: 'download',
        ...h.queue.created[0],
      }),
    );
    expect(payload).toEqual({
      type: 'download',
      moduleId: MODULE,
      mangaUrl: MANGA_URL,
      chapterLink: 'https://site.example/ch/1',
      chapterName: 'Ch. 1',
      // D1 §7: the payload carries the 1-based live-list ordinal —
      // the <numbering> source, assigned at enqueue (never a title
      // parse; the gate enforces it).
      chapterPosition: 1,
      mangaKey: downloadedChaptersKey(MODULE, MANGA_URL),
    });
  });

  it('importFavorite (tag-100, :356-361): every live chapter becomes the stored list, global row untouched', async (): Promise<void> => {
    const h = openHarness();
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);

    const result = await h.engine.importFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'Transferred' });

    expect(result.transferIngest).toBe(true);
    expect(result.queuedDownloads).toBe(0);
    const key = downloadedChaptersKey(MODULE, MANGA_URL);
    const row = h.store.getFavorite(key)!;
    expect(row.downloadedChapterList).toBe('https://site.example/ch/1\nhttps://site.example/ch/2\n');
    expect(row.currentChapter).toBe(2);
    expect(row.newChapterCount).toBe(0);
    // parity: the transfer branch touches ONLY the favorite list
    expect(h.store.getDownloadedChapters(MODULE, MANGA_URL)).toBe('');
    expect(h.queue.created).toEqual([]);
    // …and the follow-up check finds nothing new
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);
    const next = await h.engine.checkFavorite(key);
    expect(next.newChapters).toEqual([]);
  });

  it('createFavorite does NOT live-fetch (FMD2 Add parity) and starts with an empty list', (): void => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'T' });
    expect(h.info.calls).toBe(0);
    const row = h.store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))!;
    expect(row.downloadedChapterList).toBe('');
    expect(row.autoDownload).toBe(false);
    expect(row.title).toBe('T');
  });

  it('an empty-link favorite is skipped (:332-334)', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL });
    h.store.upsertFavorite({ ...h.store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))!, url: '' });

    const result = await h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL));
    expect(result.outcome).toBe('skipped');
    expect(h.info.calls).toBe(0);
  });

  it('a failed GetInfo propagates and leaves the favorite untouched', async (): Promise<void> => {
    const h = openHarness();
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL });
    h.info.fail = new Error('site down');

    await expect(
      h.engine.checkFavorite(downloadedChaptersKey(MODULE, MANGA_URL)),
    ).rejects.toThrow('site down');
    const row = h.store.getFavorite(downloadedChaptersKey(MODULE, MANGA_URL))!;
    expect(row.lastCheck).toBeUndefined();
    expect(row.currentChapter).toBeUndefined();
    expect(row.newChapterCount).toBe(0);
  });

  it('an unknown favorite key is a typed 404', async (): Promise<void> => {
    const h = openHarness();
    await expect(h.engine.checkFavorite('nope')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});
