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
 * atomic finalize. Implemented by {@link SqliteLibraryStore}.
 */
export interface LibraryStore extends DownloadedChaptersAccess {
  /** Favorite-side stored list ('' when the favorite is absent). */
  getFavoriteDownloadedList(mangaKey: string): string;
  /** Favorites engine hook (Phase 4) — insert-or-replace a favorite. */
  upsertFavorite(favorite: FavoriteRow): void;
  /** Delete a favorite (its downloaded_chapters row is NOT touched). */
  deleteFavorite(mangaKey: string): void;
  /** §7.2 dual-write chapter completion (see module doc). */
  completeChapter(request: ChapterCompletionRequest): ChapterCompletionResult;
  /** §7.1 step 5 — atomic move into library/<module>/<manga>/. */
  finalize(request: FinalizeRequest): FinalizeResult;
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
      downloaded_chapter_list TEXT
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
            downloaded_chapter_list)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(manga_key) DO UPDATE SET
           module_id = excluded.module_id,
           url = excluded.url,
           title = excluded.title,
           status = excluded.status,
           current_chapter = excluded.current_chapter,
           last_check = excluded.last_check,
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
        favorite.downloadedChapterList ?? null,
      );
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
}
