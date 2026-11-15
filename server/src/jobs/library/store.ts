/**
 * Library store (DESIGN §7.1/§9) — the persistence + finalize facade a
 * download job completes through. `LibraryStore` is the exported
 * interface; `SqliteLibraryStore` is the app.db implementation.
 *
 * Dedupe parity — FMD2 `TDownloadedChaptersDB`
 * (DownloadedChaptersDB.pas): one row per `LowerCase(ModuleID+Link)`
 * (:55, :78) holding the chapter list; an existing row merges
 * case-insensitively (`MergeCaseInsensitive([stored, value])`, :73),
 * a new row stores the value AS-IS (:78-79), an empty value is a
 * no-op (:65); delete by the same key (:154-168). Table `§9`:
 * `downloaded_chapters(id PK, chapters TEXT, updated_at)`.
 *
 * Dual-write contract (§7.2, uFavoritesManager.pas:1131-1133): on
 * chapter completion BOTH sides update —
 *   - global: `DownloadedChapters.Chapters[ModuleID, Link] :=
 *     chapterLinks.Text` (SetChapters merge semantics, :1133);
 *   - favorite-side (only when the favorite exists):
 *     `downloadedChapterList := MergeCaseInsensitive([stored,
 *     chapterLinks.Text])` (:1131).
 * fmd-web runs both writes in ONE SQLite transaction — the dual-write
 * is atomic (stronger than FMD2's two independent writes; the file
 * finalize precedes the ledger write so the ledger never cites a
 * missing artifact).
 */
import type Database from 'better-sqlite3';
import { downloadedChaptersKey, linesToText, mergeCaseInsensitive } from './merge.js';
import type { FinalizeRequest, FinalizeResult } from './finalize.js';
import { LibraryFinalizer } from './finalize.js';

/** §9 `downloaded_chapters` — set/read/delete + key (TDownloadedChaptersDB parity). */
export interface DownloadedChaptersAccess {
  /** `Chapters[ModuleID, Link]` get — '' when the row is absent (:47-60). */
  getDownloadedChapters(moduleId: string, link: string): string;
  /** `Chapters[ModuleID, Link]` set — merge-or-insert, '' no-op (:62-90). */
  setDownloadedChapters(moduleId: string, link: string, chapters: string): void;
  /** `Delete(ModuleID, Link)` (:154-168). */
  deleteDownloadedChapters(moduleId: string, link: string): void;
}

/** §9 `favorite` row (Phase-4 favorites engine reads/writes through here). */
export interface FavoriteRow {
  readonly mangaKey: string;
  readonly moduleId: string;
  readonly url: string;
  readonly title?: string;
  readonly status?: string;
  readonly currentChapter?: number;
  readonly lastCheck?: number;
  /** §7.2 `DateLastUpdated` parity — stamped when new chapters appear. */
  readonly lastUpdated?: number;
  /** Auto-download eligible new chapters through the Phase-3 pipeline. */
  readonly autoDownload?: boolean;
  /** New-chapter count at the last check (Favorites page badge). */
  readonly newChapterCount?: number;
  /** Case-insensitive merged list (M2) — trailing-LF text or ''. */
  readonly downloadedChapterList?: string;
}

export interface ChapterCompletionRequest {
  readonly moduleId: string;
  /** The manga link — the global dedupe key component. */
  readonly url: string;
  /** The chapter links downloaded (post-§5.8 normalization). */
  readonly chapterLinks: readonly string[];
  /** Favorite row to dual-write when it exists (§7.2). */
  readonly mangaKey?: string;
}

export interface ChapterCompletionResult {
  /** LowerCase(ModuleID+Link) — the global row key. */
  readonly key: string;
  /** false when there was nothing to write (empty link list). */
  readonly globalUpdated: boolean;
  /** true when the favorite-side list was merged (favorite existed). */
  readonly favoriteUpdated: boolean;
}

/**
 * The library facade (§7.1/§9): dedupe ledger + dual-write completion +
 * atomic finalize + the listing/download rows. Implemented by
 * {@link SqliteLibraryStore}.
 */
export interface LibraryStore extends DownloadedChaptersAccess {
  /** Favorite-side stored list ('' when the favorite is absent). */
  getFavoriteDownloadedList(mangaKey: string): string;
  /** Favorites engine hook (Phase 4) — insert-or-replace a favorite. */
  upsertFavorite(favorite: FavoriteRow): void;
  /** One favorite by key (undefined when absent). */
  getFavorite(mangaKey: string): FavoriteRow | undefined;
  /** All favorites, insertion order (Favorites page listing). */
  listFavorites(): FavoriteRow[];
  /** Delete a favorite (its downloaded_chapters row is NOT touched). */
  deleteFavorite(mangaKey: string): void;
  /** §7.2 dual-write chapter completion (see module doc). */
  completeChapter(request: ChapterCompletionRequest): ChapterCompletionResult;
  /** §7.1 step 5 — atomic move into library/<module>/<manga>/. */
  finalize(request: FinalizeRequest): FinalizeResult;
  /** Record a finalized artifact (insert-or-update by absolute path). */
  recordLibraryFile(entry: {
    moduleId: string;
    manga: string;
    fileName: string;
    path: string;
    bytes: number;
    createdAt?: number;
  }): LibraryFileRow;
  /** Listing rows newest-first, `beforeId` exclusive (keyset cursor). */
  listLibraryFiles(opts?: { limit?: number; beforeId?: number }): LibraryFileRow[];
  /** One listing row (with its absolute path for the download route). */
  getLibraryFile(id: string): (LibraryFileRow & { readonly path: string }) | undefined;
}

/** One §7.1 finalized artifact as the listing API projects it. */
export interface LibraryFileRow {
  readonly id: string;
  readonly moduleId: string;
  readonly manga: string;
  readonly fileName: string;
  readonly bytes: number;
  /** RFC 3339 UTC (ISO string of the stored epoch ms). */
  readonly createdAt: string;
}

export interface SqliteLibraryStoreOptions {
  readonly db: Database.Database;
  /** Library root for finalize; omit to disable finalize support. */
  readonly libraryRoot?: string;
  /** Deterministic finalize token (tests). */
  readonly finalizeToken?: () => string;
}

/** §9 tables this store owns (migrations land with the db story). */
export function ensureLibrarySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS downloaded_chapters (
      id         TEXT PRIMARY KEY,
      chapters   TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorite (
      manga_key              TEXT PRIMARY KEY,
      module_id              TEXT NOT NULL,
      url                    TEXT NOT NULL,
      title                  TEXT,
      status                 TEXT,
      current_chapter        INTEGER,
      last_check             INTEGER,
      last_updated           INTEGER,
      auto_download          INTEGER NOT NULL DEFAULT 1,
      new_chapter_count      INTEGER NOT NULL DEFAULT 0,
      downloaded_chapter_list TEXT
    );
    CREATE TABLE IF NOT EXISTS library_files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id  TEXT NOT NULL,
      manga      TEXT NOT NULL,
      file       TEXT NOT NULL,
      path       TEXT NOT NULL UNIQUE,
      bytes      INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

export class SqliteLibraryStore implements LibraryStore {
  private readonly finalizer: LibraryFinalizer | undefined;

  public constructor(private readonly options: SqliteLibraryStoreOptions) {
    ensureLibrarySchema(options.db);
    this.finalizer =
      options.libraryRoot !== undefined
        ? new LibraryFinalizer({
            libraryRoot: options.libraryRoot,
            ...(options.finalizeToken !== undefined ? { token: options.finalizeToken } : {}),
          })
        : undefined;
  }

  public getDownloadedChapters(moduleId: string, link: string): string {
    const key = downloadedChaptersKey(moduleId, link);
    const row = this.options.db
      .prepare('SELECT chapters FROM downloaded_chapters WHERE id = ?')
      .get(key) as { chapters: string | null } | undefined;
    return row?.chapters ?? '';
  }

  public setDownloadedChapters(moduleId: string, link: string, chapters: string): void {
    // :65 — an empty value is a no-op
    if (chapters === '') {
      return;
    }
    const key = downloadedChaptersKey(moduleId, link);
    const now = Date.now();
    const insert = this.options.db.transaction((): void => {
      const existing = this.options.db
        .prepare('SELECT chapters FROM downloaded_chapters WHERE id = ?')
        .get(key) as { chapters: string | null } | undefined;
      if (existing === undefined) {
        // :77-79 — a NEW row stores the value as-is (no merge, no sort)
        this.options.db
          .prepare('INSERT INTO downloaded_chapters (id, chapters, updated_at) VALUES (?, ?, ?)')
          .run(key, chapters, now);
      } else {
        // :70-74 — an existing row merges case-insensitively
        const merged = mergeCaseInsensitive(existing.chapters ?? '', chapters);
        this.options.db
          .prepare('UPDATE downloaded_chapters SET chapters = ?, updated_at = ? WHERE id = ?')
          .run(merged, now, key);
      }
    });
    insert();
  }

  public deleteDownloadedChapters(moduleId: string, link: string): void {
    this.options.db
      .prepare('DELETE FROM downloaded_chapters WHERE id = ?')
      .run(downloadedChaptersKey(moduleId, link));
  }

  public getFavoriteDownloadedList(mangaKey: string): string {
    const row = this.options.db
      .prepare('SELECT downloaded_chapter_list FROM favorite WHERE manga_key = ?')
      .get(mangaKey) as { downloaded_chapter_list: string | null } | undefined;
    return row?.downloaded_chapter_list ?? '';
  }

  public upsertFavorite(favorite: FavoriteRow): void {
    this.options.db
      .prepare(
        `INSERT INTO favorite
            (manga_key, module_id, url, title, status, current_chapter, last_check,
             last_updated, auto_download, new_chapter_count, downloaded_chapter_list)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(manga_key) DO UPDATE SET
            module_id = excluded.module_id,
            url = excluded.url,
            title = excluded.title,
            status = excluded.status,
            current_chapter = excluded.current_chapter,
            last_check = excluded.last_check,
            last_updated = excluded.last_updated,
            auto_download = excluded.auto_download,
            new_chapter_count = excluded.new_chapter_count,
            downloaded_chapter_list = excluded.downloaded_chapter_list`,
      )
      .run(
        favorite.mangaKey,
        favorite.moduleId,
        favorite.url,
        favorite.title ?? null,
        favorite.status ?? null,
        favorite.currentChapter ?? null,
        favorite.lastCheck ?? null,
        favorite.lastUpdated ?? null,
        favorite.autoDownload === false ? 0 : 1,
        favorite.newChapterCount ?? 0,
        favorite.downloadedChapterList ?? null,
      );
  }

  public getFavorite(mangaKey: string): FavoriteRow | undefined {
    const row = this.options.db
      .prepare(
        `SELECT manga_key, module_id, url, title, status, current_chapter, last_check,
                last_updated, auto_download, new_chapter_count, downloaded_chapter_list
           FROM favorite WHERE manga_key = ?`,
      )
      .get(mangaKey) as FavoriteDbRow | undefined;
    return row === undefined ? undefined : toFavoriteRow(row);
  }

  public listFavorites(): FavoriteRow[] {
    const rows = this.options.db
      .prepare(
        `SELECT manga_key, module_id, url, title, status, current_chapter, last_check,
                last_updated, auto_download, new_chapter_count, downloaded_chapter_list
           FROM favorite ORDER BY rowid`,
      )
      .all() as FavoriteDbRow[];
    return rows.map(toFavoriteRow);
  }

  public deleteFavorite(mangaKey: string): void {
    this.options.db.prepare('DELETE FROM favorite WHERE manga_key = ?').run(mangaKey);
  }

  public completeChapter(request: ChapterCompletionRequest): ChapterCompletionResult {
    const key = downloadedChaptersKey(request.moduleId, request.url);
    const chaptersText = linesToText(request.chapterLinks);
    if (chaptersText === '') {
      // SetChapters('') is a no-op (:65) and merging '' into the
      // favorite list adds nothing — nothing to write on either side.
      return { key, globalUpdated: false, favoriteUpdated: false };
    }
    const now = Date.now();
    const write = this.options.db.transaction((): boolean => {
      // global side (:1133 → SetChapters merge semantics)
      const existing = this.options.db
        .prepare('SELECT chapters FROM downloaded_chapters WHERE id = ?')
        .get(key) as { chapters: string | null } | undefined;
      if (existing === undefined) {
        this.options.db
          .prepare('INSERT INTO downloaded_chapters (id, chapters, updated_at) VALUES (?, ?, ?)')
          .run(key, chaptersText, now);
      } else {
        this.options.db
          .prepare('UPDATE downloaded_chapters SET chapters = ?, updated_at = ? WHERE id = ?')
          .run(mergeCaseInsensitive(existing.chapters ?? '', chaptersText), now, key);
      }
      // favorite side (:1131 — only when the favorite exists)
      if (request.mangaKey === undefined) {
        return false;
      }
      const favorite = this.options.db
        .prepare('SELECT downloaded_chapter_list FROM favorite WHERE manga_key = ?')
        .get(request.mangaKey) as { downloaded_chapter_list: string | null } | undefined;
      if (favorite === undefined) {
        return false;
      }
      const merged = mergeCaseInsensitive(favorite.downloaded_chapter_list ?? '', chaptersText);
      this.options.db
        .prepare('UPDATE favorite SET downloaded_chapter_list = ?, last_check = ? WHERE manga_key = ?')
        .run(merged, now, request.mangaKey);
      return true;
    });
    const favoriteUpdated: boolean = write();
    return { key, globalUpdated: true, favoriteUpdated };
  }

  public finalize(request: FinalizeRequest): FinalizeResult {
    if (this.finalizer === undefined) {
      throw new Error('SqliteLibraryStore was opened without a libraryRoot — finalize unavailable');
    }
    return this.finalizer.finalize(request);
  }

  public recordLibraryFile(entry: {
    moduleId: string;
    manga: string;
    fileName: string;
    path: string;
    bytes: number;
    createdAt?: number;
  }): LibraryFileRow {
    const now = entry.createdAt ?? Date.now();
    this.options.db
      .prepare(
        `INSERT INTO library_files (module_id, manga, file, path, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           module_id = excluded.module_id,
           manga = excluded.manga,
           file = excluded.file,
           bytes = excluded.bytes,
           created_at = excluded.created_at`,
      )
      .run(entry.moduleId, entry.manga, entry.fileName, entry.path, entry.bytes, now);
    const row = this.options.db
      .prepare('SELECT id, module_id, manga, file, bytes, created_at FROM library_files WHERE path = ?')
      .get(entry.path) as {
      id: number;
      module_id: string;
      manga: string;
      file: string;
      bytes: number;
      created_at: number;
    };
    return toLibraryFileRow(row);
  }

  public listLibraryFiles(opts?: { limit?: number; beforeId?: number }): LibraryFileRow[] {
    const limit = Math.max(1, Math.trunc(opts?.limit ?? 50));
    const beforeId = opts?.beforeId;
    const rows = (
      beforeId === undefined
        ? this.options.db
            .prepare('SELECT id, module_id, manga, file, bytes, created_at FROM library_files ORDER BY id DESC LIMIT ?')
            .all(limit) as LibraryFileDbRow[]
        : this.options.db
            .prepare(
              'SELECT id, module_id, manga, file, bytes, created_at FROM library_files WHERE id < ? ORDER BY id DESC LIMIT ?',
            )
            .all(beforeId, limit) as LibraryFileDbRow[]
    );
    return rows.map(toLibraryFileRow);
  }

  public getLibraryFile(id: string): (LibraryFileRow & { readonly path: string }) | undefined {
    const row = this.options.db
      .prepare('SELECT id, module_id, manga, file, path, bytes, created_at FROM library_files WHERE id = ?')
      .get(Number(id)) as
      | (LibraryFileDbRow & { readonly path: string })
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { ...toLibraryFileRow(row), path: row.path };
  }
}

interface LibraryFileDbRow {
  readonly id: number;
  readonly module_id: string;
  readonly manga: string;
  readonly file: string;
  readonly bytes: number;
  readonly created_at: number;
}

interface FavoriteDbRow {
  readonly manga_key: string;
  readonly module_id: string;
  readonly url: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly current_chapter: number | null;
  readonly last_check: number | null;
  readonly last_updated: number | null;
  readonly auto_download: number | null;
  readonly new_chapter_count: number | null;
  readonly downloaded_chapter_list: string | null;
}

function toFavoriteRow(row: FavoriteDbRow): FavoriteRow {
  return {
    mangaKey: row.manga_key,
    moduleId: row.module_id,
    url: row.url,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.current_chapter !== null ? { currentChapter: row.current_chapter } : {}),
    ...(row.last_check !== null ? { lastCheck: row.last_check } : {}),
    ...(row.last_updated !== null ? { lastUpdated: row.last_updated } : {}),
    autoDownload: row.auto_download !== 0,
    newChapterCount: row.new_chapter_count ?? 0,
    ...(row.downloaded_chapter_list !== null
      ? { downloadedChapterList: row.downloaded_chapter_list }
      : {}),
  };
}

function toLibraryFileRow(row: LibraryFileDbRow): LibraryFileRow {
  return {
    id: String(row.id),
    moduleId: row.module_id,
    manga: row.manga,
    fileName: row.file,
    bytes: row.bytes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
