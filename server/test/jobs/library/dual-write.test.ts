import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteLibraryStore } from '../../../src/jobs/library/store.js';
import { downloadedChaptersKey } from '../../../src/jobs/library/merge.js';
import { mkTmpDir, rmDir } from '../helpers.js';

/**
 * Dual-write contract test (DESIGN §7.2, uFavoritesManager.pas:1131-1133):
 * completing a chapter updates BOTH the favorite-side stored list (when
 * the favorite exists) and the global `downloaded_chapters` — the exact
 * favorites Phase-4 diff input — plus the TDownloadedChaptersDB
 * set/get/delete parity (DownloadedChaptersDB.pas:62-90, 154-168).
 */

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const URL = 'https://site.example/manga/x';

let dbFile = '';
let libraryRoot = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
  libraryRoot = '';
});

interface Harness {
  readonly store: SqliteLibraryStore;
  readonly raw: Database.Database;
}

function openHarness(): Harness {
  const dir = mkTmpDir('lib-dualwrite');
  dbFile = path.join(dir, 'app.db');
  libraryRoot = path.join(dir, 'library');
  const raw = new Database(dbFile);
  const store = new SqliteLibraryStore({ db: raw, libraryRoot });
  return { store, raw };
}

describe('downloaded_chapters — TDownloadedChaptersDB parity', () => {
  it('a NEW row stores the value AS-IS (:77-79 — no merge, no sort)', () => {
    const { store } = openHarness();
    store.setDownloadedChapters(MODULE, URL, 'Z-last\nA-first\n');
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('Z-last\nA-first\n');
  });

  it('an EXISTING row merges case-insensitively (:70-74)', () => {
    const { store } = openHarness();
    store.setDownloadedChapters(MODULE, URL, 'Chapter 2\nChapter 1\n');
    store.setDownloadedChapters(MODULE, URL, 'chapter 3\nChapter 1\n');
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('Chapter 1\nChapter 2\nchapter 3\n');
  });

  it('an empty value is a no-op (:65)', () => {
    const { store } = openHarness();
    store.setDownloadedChapters(MODULE, URL, '');
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('');
    store.setDownloadedChapters(MODULE, URL, 'Ch1\n');
    store.setDownloadedChapters(MODULE, URL, '');
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('Ch1\n');
  });

  it('absent rows read as "" (:50)', () => {
    const { store } = openHarness();
    expect(store.getDownloadedChapters(MODULE, 'https://missing')).toBe('');
  });

  it('case-variant (moduleId, link) pairs address the SAME row (:55, :78)', () => {
    const { store, raw } = openHarness();
    store.setDownloadedChapters('ModuleID', 'Link/One', 'A\n');
    store.setDownloadedChapters('moduleid', 'link/one', 'B\n');
    expect(store.getDownloadedChapters(MODULE, 'https://other')).toBe('');
    expect(store.getDownloadedChapters('MODULEID', 'LINK/ONE')).toBe('A\nB\n');
    const rows = raw.prepare('SELECT id FROM downloaded_chapters').all() as { id: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(downloadedChaptersKey('ModuleID', 'Link/One'));
  });

  it('Delete(ModuleID, Link) removes the row (:154-168)', () => {
    const { store } = openHarness();
    store.setDownloadedChapters(MODULE, URL, 'A\n');
    store.deleteDownloadedChapters(MODULE, URL);
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('');
  });

  it('rows persist across connections (WAL app.db)', () => {
    const { store, raw } = openHarness();
    store.setDownloadedChapters(MODULE, URL, 'A\nB\n');
    raw.close();
    const reopened = new Database(dbFile);
    const again = new SqliteLibraryStore({ db: reopened });
    expect(again.getDownloadedChapters(MODULE, URL)).toBe('A\nB\n');
    reopened.close();
  });
});

describe('completeChapter — the §7.2 dual-write contract (:1131-1133)', () => {
  it('updates BOTH the favorite-side list and downloaded_chapters when the favorite exists', () => {
    const { store } = openHarness();
    store.upsertFavorite({
      mangaKey: 'fav-1',
      moduleId: MODULE,
      url: URL,
      downloadedChapterList: 'https://site.example/manga/x/c1\n',
    });
    const result = store.completeChapter({
      moduleId: MODULE,
      url: URL,
      chapterLinks: ['https://site.example/manga/x/c2'],
      mangaKey: 'fav-1',
    });
    expect(result.globalUpdated).toBe(true);
    expect(result.favoriteUpdated).toBe(true);
    expect(result.key).toBe(downloadedChaptersKey(MODULE, URL));
    // global side (:1133 — SetChapters semantics): this completion's
    // first global row stores the links text AS-IS (:77-79) — the
    // favorite's pre-existing list does NOT leak into the global ledger
    expect(store.getDownloadedChapters(MODULE, URL)).toBe(
      'https://site.example/manga/x/c2\n',
    );
    // favorite side (:1131 — MergeCaseInsensitive overwrite)
    expect(store.getFavoriteDownloadedList('fav-1')).toBe(
      'https://site.example/manga/x/c1\nhttps://site.example/manga/x/c2\n',
    );
  });

  it('case-variant chapter links dedupe on the favorite side (global new-row stays raw)', () => {
    const { store, raw } = openHarness();
    store.upsertFavorite({
      mangaKey: 'fav-1',
      moduleId: MODULE,
      url: URL,
      downloadedChapterList: 'Ch.1\n',
    });
    store.completeChapter({
      moduleId: MODULE,
      url: URL,
      chapterLinks: ['ch.1', 'CH.2', 'Ch.2'],
      mangaKey: 'fav-1',
    });
    // global: a NEW row stores the value as-is (:77-79 — case variants
    // and duplicates survive verbatim; they merge on later writes)
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('ch.1\nCH.2\nCh.2\n');
    // favorite: merged case-insensitively, first-added variant wins
    expect(store.getFavoriteDownloadedList('fav-1')).toBe('Ch.1\nCH.2\n');
    const rows = raw.prepare('SELECT id FROM downloaded_chapters').all() as { id: string }[];
    expect(rows.length).toBe(1);
  });

  it('NO favorite → only the global side is written', () => {
    const { store } = openHarness();
    const result = store.completeChapter({
      moduleId: MODULE,
      url: URL,
      chapterLinks: ['c1', 'c2'],
    });
    expect(result.globalUpdated).toBe(true);
    expect(result.favoriteUpdated).toBe(false);
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('c1\nc2\n');
  });

  it('a mangaKey without a favorite row → only the global side', () => {
    const { store } = openHarness();
    const result = store.completeChapter({
      moduleId: MODULE,
      url: URL,
      chapterLinks: ['c1'],
      mangaKey: 'no-such-favorite',
    });
    expect(result.globalUpdated).toBe(true);
    expect(result.favoriteUpdated).toBe(false);
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('c1\n');
  });

  it('an empty link list writes nothing on either side (:65 parity)', () => {
    const { store } = openHarness();
    store.upsertFavorite({ mangaKey: 'fav-1', moduleId: MODULE, url: URL });
    const result = store.completeChapter({
      moduleId: MODULE,
      url: URL,
      chapterLinks: [],
      mangaKey: 'fav-1',
    });
    expect(result.globalUpdated).toBe(false);
    expect(result.favoriteUpdated).toBe(false);
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('');
    expect(store.getFavoriteDownloadedList('fav-1')).toBe('');
  });

  it('repeated completions keep merging (dual-write is cumulative)', () => {
    const { store } = openHarness();
    store.upsertFavorite({ mangaKey: 'fav-1', moduleId: MODULE, url: URL });
    store.completeChapter({ moduleId: MODULE, url: URL, chapterLinks: ['c2'], mangaKey: 'fav-1' });
    store.completeChapter({ moduleId: MODULE, url: URL, chapterLinks: ['c1'], mangaKey: 'fav-1' });
    store.completeChapter({ moduleId: MODULE, url: URL, chapterLinks: ['C2'], mangaKey: 'fav-1' });
    expect(store.getDownloadedChapters(MODULE, URL)).toBe('c1\nc2\n');
    expect(store.getFavoriteDownloadedList('fav-1')).toBe('c1\nc2\n');
  });
});

describe('SqliteLibraryStore — finalize integration', () => {
  it('finalize moves the packed chapter into the library (§7.1 step 5)', () => {
    const { store } = openHarness();
    const source = path.join(path.dirname(dbFile), 'pack.zip');
    fs.writeFileSync(source, Buffer.from('PK-payload'));
    const result = store.finalize({
      moduleId: MODULE,
      manga: 'My Manga',
      fileName: 'Ch. 1',
      ext: 'zip',
      sourcePath: source,
    });
    expect(result.bytes).toBe(10);
    expect(fs.readFileSync(result.path).toString()).toBe('PK-payload');
    expect(result.path.endsWith(path.join(MODULE, 'My Manga', 'Ch. 1.zip'))).toBe(true);
  });

  it('finalize without a libraryRoot refuses loudly', () => {
    const dir = mkTmpDir('lib-noroot');
    const raw = new Database(path.join(dir, 'app.db'));
    const store = new SqliteLibraryStore({ db: raw });
    expect(() =>
      store.finalize({
        moduleId: MODULE,
        manga: 'm',
        fileName: 'c',
        ext: 'zip',
        sourcePath: path.join(dir, 'x.zip'),
      }),
    ).toThrow(/libraryRoot/);
    raw.close();
    rmDir(dir);
  });
});
