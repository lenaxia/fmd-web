// @vitest-environment node

/**
 * [inbox] The check-engine emission seam (D1 §2 INBOX): the feed
 * derives from the ONE detection path — FavoritesEngine.checkFavorite
 * — wherever the check came from (scheduler sweep, manual check-now,
 * batch check all call it). Pinned here:
 *
 * 1. a check that finds new chapters records EXACTLY the new set
 *    (links + names), with the favorite's identity and snapshots;
 * 2. a check that finds nothing new records nothing;
 * 3. already-known chapters are not re-recorded (diff parity);
 * 4. the tag-100 transfer ingest records nothing (its newChapters is
 *    [] by construction — everything is marked downloaded);
 * 5. a THROWING sink never takes the check down (the feed is
 *    advisory to the pipe: the favorite row still persists);
 * 6. wiring the REAL SqliteInboxService lands the rows idempotently
 *    (the assembly posture).
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FavoritesEngine } from '../../../src/jobs/favorites/engine.js';
import { SqliteLibraryStore } from '../../../src/jobs/library/store.js';
import { SqliteInboxService } from '../../../src/runtime/inbox.js';
import { downloadedChaptersKey } from '../../../src/jobs/library/merge.js';
import type { NormalizedInfo } from '../../../src/api/services.js';
import type { FavoriteRow } from '../../../src/jobs/library/store.js';
import { mkTmpDir, rmDir } from '../helpers.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const MANGA_URL = 'https://site.example/manga/x';
const KEY = downloadedChaptersKey(MODULE, MANGA_URL);

let dbFile = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
});

class ScriptedInfo {
  public info: NormalizedInfo = emptyInfo([]);
  async getInfo(_moduleId: string, _url: string): Promise<NormalizedInfo> {
    return this.info;
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
    coverLink: 'https://cdn.example/cover.jpg',
    url: MANGA_URL,
    link: MANGA_URL,
    chapterLinks,
    chapterNames: chapterLinks.map((_, i) => `Ch. ${i + 1}`),
    numChapter: chapterLinks.length,
  };
}

/** The engine's `inbox` dep shape (record-only — exactly what the seam allows). */
interface InboxSeam {
  recordNewChapters(
    favorite: FavoriteRow,
    chapters: ReadonlyArray<{ readonly link: string; readonly name: string }>,
    at: number,
  ): void;
}

/** The recording sink double. */
class RecordingInbox implements InboxSeam {
  public readonly calls: Array<{
    favorite: FavoriteRow;
    chapters: ReadonlyArray<{ link: string; name: string }>;
    at: number;
  }> = [];
  public recordNewChapters(
    favorite: FavoriteRow,
    chapters: ReadonlyArray<{ readonly link: string; readonly name: string }>,
    at: number,
  ): void {
    this.calls.push({
      favorite,
      // project to the seam's {link, name} exactly like the real sink
      chapters: chapters.map((chapter): { link: string; name: string } => ({
        link: chapter.link,
        name: chapter.name,
      })),
      at,
    });
  }
}

class ThrowingInbox implements InboxSeam {
  public recordNewChapters(): void {
    throw new Error('sink down');
  }
}

function openHarness(seam?: InboxSeam): {
  store: SqliteLibraryStore;
  engine: FavoritesEngine;
  info: ScriptedInfo;
} {
  const dir = mkTmpDir('fav-inbox');
  dbFile = path.join(dir, 'app.db');
  const store = new SqliteLibraryStore({ db: new Database(dbFile), libraryRoot: path.join(dir, 'library') });
  const info = new ScriptedInfo();
  const engine = new FavoritesEngine({
    store,
    info,
    downloads: { createDownload: (): { jobId: string } => ({ jobId: 'job-1' }) },
    ...(seam !== undefined ? { inbox: seam } : {}),
    now: (): number => 1_000_000,
  });
  return { store, engine, info };
}

describe('FavoritesEngine — [inbox] the feed derives from the one detection path', () => {
  it('a check with new chapters records EXACTLY the new set, with identity + snapshots', async () => {
    const sink = new RecordingInbox();
    const h = openHarness(sink);
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);

    await h.engine.checkFavorite(KEY);

    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0]!;
    expect(call.at).toBe(1_000_000);
    expect(call.favorite.mangaKey).toBe(KEY);
    expect(call.favorite.moduleId).toBe(MODULE);
    // the snapshots ride the UPDATED favorite row (coverLink merged
    // from the live info before the recording)
    expect(call.favorite.title).toBe('Fixture Manga');
    expect(call.favorite.coverLink).toBe('https://cdn.example/cover.jpg');
    expect(call.chapters).toEqual([
      { link: 'https://site.example/ch/1', name: 'Ch. 1' },
      { link: 'https://site.example/ch/2', name: 'Ch. 2' },
    ]);
  });

  it('a check that finds nothing new records nothing (and the seam is never called)', async () => {
    const sink = new RecordingInbox();
    const h = openHarness(sink);
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL });
    h.info.info = emptyInfo([]);

    await h.engine.checkFavorite(KEY);

    expect(sink.calls).toHaveLength(0);
  });

  it('already-known chapters are not re-recorded (diff parity — only NEW links feed the inbox)', async () => {
    const sink = new RecordingInbox();
    const h = openHarness(sink);
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL });
    h.store.upsertFavorite({
      ...h.store.getFavorite(KEY)!,
      downloadedChapterList: 'https://site.example/ch/1\n',
    });
    h.info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);

    await h.engine.checkFavorite(KEY);

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]!.chapters).toEqual([{ link: 'https://site.example/ch/2', name: 'Ch. 2' }]);
  });

  it('the tag-100 transfer ingest records nothing (everything is marked downloaded, no diff)', async () => {
    const sink = new RecordingInbox();
    const h = openHarness(sink);
    h.info.info = emptyInfo(['https://site.example/ch/1']);

    await h.engine.importFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });

    expect(sink.calls).toHaveLength(0);
    // sanity: the transfer branch really ran (stored list = live list)
    expect(h.store.getFavorite(KEY)?.downloadedChapterList).toContain('https://site.example/ch/1');
  });

  it('a THROWING sink never takes the check down — the favorite row still persists', async () => {
    const h = openHarness(new ThrowingInbox());
    h.engine.createFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });
    h.info.info = emptyInfo(['https://site.example/ch/1']);

    const result = await h.engine.checkFavorite(KEY);

    expect(result.outcome).toBe('checked');
    expect(result.newChapters).toHaveLength(1);
    expect(h.store.getFavorite(KEY)?.currentChapter).toBe(1);
  });

  it('the REAL SqliteInboxService lands the rows idempotently (the assembly wiring posture)', async () => {
    const dir = mkTmpDir('fav-inbox-real');
    dbFile = path.join(dir, 'app.db');
    const raw = new Database(dbFile);
    const store = new SqliteLibraryStore({ db: raw, libraryRoot: path.join(dir, 'library') });
    const service = new SqliteInboxService(raw);
    const info = new ScriptedInfo();
    const engine = new FavoritesEngine({
      store,
      info,
      downloads: { createDownload: (): { jobId: string } => ({ jobId: 'job-1' }) },
      inbox: {
        recordNewChapters: (favorite, chapters, at): void => {
          service.record({
            moduleId: favorite.moduleId,
            mangaKey: favorite.mangaKey,
            mangaUrl: favorite.url,
            ...(favorite.title !== undefined ? { mangaTitle: favorite.title } : {}),
            ...(favorite.coverLink !== undefined && favorite.coverLink !== ''
              ? { coverLink: favorite.coverLink }
              : {}),
            chapters: chapters.map((chapter): { readonly link: string; readonly name: string } => ({
              link: chapter.link,
              name: chapter.name,
            })),
            at,
          });
        },
      },
      now: (): number => 1_000_000,
    });
    engine.createFavorite({ moduleId: MODULE, url: MANGA_URL, title: 'Fixture Manga' });
    info.info = emptyInfo(['https://site.example/ch/1', 'https://site.example/ch/2']);

    await engine.checkFavorite(KEY);
    // a re-check (no auto-download → the stored list never learns the
    // links) re-detects and re-records — idempotently
    await engine.checkFavorite(KEY);

    const feed = service.list('new', 2_000_000);
    expect(feed.newCount).toBe(2);
    expect(feed.entries.map((entry) => entry.chapterLabel)).toEqual(['Ch. 1', 'Ch. 2']);
    expect(feed.entries[0]?.mangaTitle).toBe('Fixture Manga');
    expect(feed.entries[0]?.coverLink).toBe('https://cdn.example/cover.jpg');
  });
});
