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
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { downloadedChaptersKey, linesToText, mergeCaseInsensitive } from './merge.js';
import { sanitizeFileName } from './filenames.js';
import { isForeignClaim, safeFolderComponent, suffixedMangaFolder } from './layout.js';
import { lexicalRelFromRoot } from '../../fs-walk.js';
import type { LibraryLedgerRow } from './reconcile.js';
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
  /** Per-favorite download directory override ('' = default layout). */
  readonly saveTo?: string;
  /**
   * [library-layout] The effective library folder for the favorite's
   * chapters — the clean sanitized title, or the suffixed
   * `<manga> [<module>]` duplicate form. COMPUTED ONCE at the first
   * default-layout download and persisted (the same additive-column
   * seam saveTo rides); never recomputed — adding/deleting other
   * favorites must never re-point an existing folder. Absent while no
   * default-layout download has run (and forever for saveTo-only
   * favorites — an overridden prefix has no effective folder).
   */
  readonly libraryFolder?: string;
  /** Disabled favorites are skipped by the scheduler (FMD2 `Enabled`). */
  readonly enabled?: boolean;
  /** Creation stamp (FMD2 `DateAdded`, epoch ms). */
  readonly dateAdded?: number;
  /**
   * Covers live-defect: the §5.8 coverLink captured at the last
   * successful check — favorites rows render covers through the
   * same-origin proxy without a per-row GetInfo fan-out.
   */
  readonly coverLink?: string;
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
  /** §7.1 step 5 — atomic move into library/<manga>/. */
  finalize(request: FinalizeRequest): FinalizeResult;
  /**
   * [library-layout] The effective folder for a title's next
   * default-layout download (layout.ts rule 2): the favorite's
   * persisted folder when computed before (never recomputed), else the
   * folder this module's own recorded rows already use, else the clean
   * title folder — suffixed when a DIFFERENT module (or an unattributed
   * on-disk folder) claims it. Persists the computed value onto the
   * favorite when one exists (computed-once seam).
   */
  resolveMangaFolder(input: {
    readonly moduleId: string;
    readonly mangaUrl: string;
    readonly segment: string;
  }): string;
  /**
   * [library-layout] Persist the effective folder onto a favorite row
   * (UPDATE-only — never creates a row; a no-op when the favorite is
   * absent or already records the value).
   */
  setFavoriteLibraryFolder(mangaKey: string, folder: string): void;
  /**
   * [library-layout] Distinct sanitized module segments with ledger
   * rows recorded under `dirAbs` (the claim check input for rule 2).
   */
  distinctModuleIdsUnderPath(dirAbs: string): string[];
  /**
   * [library-layout] One-transaction layout-migration persist: per row
   * the new path + effective folder, with fresh stat metadata
   * (bytes/mtime → verified 'downloaded') when the file was moved on
   * disk, path-only otherwise (the file was already gone — the row
   * keeps its missing posture at the new recorded location).
   */
  applyLayoutMigration(rows: readonly {
    id: number;
    path: string;
    manga: string;
    bytes?: number;
    mtimeMs?: number;
  }[]): void;
  /** Record a finalized artifact (insert-or-update by absolute path). */
  recordLibraryFile(entry: {
    moduleId: string;
    manga: string;
    fileName: string;
    path: string;
    bytes: number;
    createdAt?: number;
    /** Download-lane provenance (file-state story): the manga URL key. */
    mangaUrl?: string;
    /** Download-lane provenance (file-state story): the chapter link. */
    chapterLink?: string;
  }): LibraryFileRow;
  /** Listing rows newest-first, `beforeId` exclusive (keyset cursor). */
  listLibraryFiles(opts?: { limit?: number; beforeId?: number }): LibraryFileRow[];
  /**
   * Full ledger rows (path + provenance + verified stamps) newest-first
   * — the file-state service projection (reconcile + lazy verify).
   */
  listLibraryLedgerRows(opts?: { limit?: number; beforeId?: number }): LibraryLedgerRow[];
  /**
   * Ledger rows for ONE title: provenance-keyed rows (module + manga
   * url) plus legacy rows matching any of the sanitized segment
   * fallbacks (pre-provenance rows recorded only the layout segment).
   */
  listLibraryRowsForTitle(moduleId: string, url: string, legacySegments: readonly string[]): LibraryLedgerRow[];
  /** Every ledger row (rescan reconcile input), ascending id. */
  allLibraryLedgerRows(): LibraryLedgerRow[];
  /**
   * Persist a verification batch (lazy verify / rescan outcome): per
   * row the verdict, the stamp, and (when present on disk) fresh
   * bytes/mtime metadata. One transaction.
   */
  applyVerification(rows: readonly {
    id: number;
    at: number;
    state: 'downloaded' | 'missing';
    bytes?: number;
    mtimeMs?: number;
  }[]): void;
  /** Persist a rescan re-link: row re-points at the moved file. */
  relinkLibraryFile(id: number, path: string, bytes: number, verifiedAt: number, mtimeMs: number): void;
  /** One listing row (with its absolute path for the download route). */
  getLibraryFile(id: string): (LibraryFileRow & { readonly path: string }) | undefined;
  /**
   * Downloads parity (delete task + data): remove the artifact recorded
   * at `path` — the file on disk (when present) plus its `library_files`
   * row. Returns whether a recorded row existed and was removed.
   */
  deleteLibraryFileByPath(path: string): boolean;
  /** app_settings kv read (undefined when the key is absent). */
  getSetting(key: string): string | undefined;
  /** app_settings kv write (insert-or-replace). */
  setSetting(key: string, value: string): void;
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
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Additive favorites-parity columns: CREATE IF NOT EXISTS does not
  // extend an existing table, so each new column lands via an idempotent
  // ALTER guarded by PRAGMA table_info (old data keeps its defaults).
  const favoriteColumns = new Set(
    (db.prepare('PRAGMA table_info(favorite)').all() as Array<{ name: string }>).map(
      (column): string => column.name,
    ),
  );
  if (!favoriteColumns.has('save_to')) {
    db.exec('ALTER TABLE favorite ADD COLUMN save_to TEXT');
  }
  if (!favoriteColumns.has('enabled')) {
    db.exec('ALTER TABLE favorite ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!favoriteColumns.has('date_added')) {
    db.exec('ALTER TABLE favorite ADD COLUMN date_added INTEGER');
  }
  if (!favoriteColumns.has('cover_link')) {
    db.exec('ALTER TABLE favorite ADD COLUMN cover_link TEXT');
  }
  // [library-layout] computed-once effective folder (the saveTo seam's
  // additive-column pattern): set at the first default-layout download,
  // read forever after — never recomputed.
  if (!favoriteColumns.has('library_folder')) {
    db.exec('ALTER TABLE favorite ADD COLUMN library_folder TEXT');
  }
  // Library file-state story (additive, same guarded-ALTER pattern):
  // verified_at = the stat-verified truth stamp (lazy verify); manga_url
  // + chapter_link = the download-lane provenance that keys per-title
  // file listings to the ONE downloaded-chapters ledger truth.
  const libraryColumns = new Set(
    (db.prepare('PRAGMA table_info(library_files)').all() as Array<{ name: string }>).map(
      (column): string => column.name,
    ),
  );
  if (!libraryColumns.has('verified_at')) {
    db.exec('ALTER TABLE library_files ADD COLUMN verified_at INTEGER');
  }
  if (!libraryColumns.has('manga_url')) {
    db.exec('ALTER TABLE library_files ADD COLUMN manga_url TEXT');
  }
  if (!libraryColumns.has('chapter_link')) {
    db.exec('ALTER TABLE library_files ADD COLUMN chapter_link TEXT');
  }
  if (!libraryColumns.has('state')) {
    db.exec("ALTER TABLE library_files ADD COLUMN state TEXT");
  }
  if (!libraryColumns.has('mtime')) {
    db.exec('ALTER TABLE library_files ADD COLUMN mtime INTEGER');
  }
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
             last_updated, auto_download, new_chapter_count, downloaded_chapter_list,
             save_to, enabled, date_added, cover_link, library_folder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            downloaded_chapter_list = excluded.downloaded_chapter_list,
            save_to = excluded.save_to,
            enabled = excluded.enabled,
            date_added = excluded.date_added,
            cover_link = excluded.cover_link,
            library_folder = COALESCE(excluded.library_folder, favorite.library_folder)`,
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
        favorite.saveTo ?? null,
        favorite.enabled === false ? 0 : 1,
        favorite.dateAdded ?? null,
        favorite.coverLink ?? null,
        favorite.libraryFolder ?? null,
      );
  }

  public getFavorite(mangaKey: string): FavoriteRow | undefined {
    const row = this.options.db
      .prepare(
        `SELECT manga_key, module_id, url, title, status, current_chapter, last_check,
                last_updated, auto_download, new_chapter_count, downloaded_chapter_list,
                save_to, enabled, date_added, cover_link, library_folder
           FROM favorite WHERE manga_key = ?`,
      )
      .get(mangaKey) as FavoriteDbRow | undefined;
    return row === undefined ? undefined : toFavoriteRow(row);
  }

  public listFavorites(): FavoriteRow[] {
    const rows = this.options.db
      .prepare(
        `SELECT manga_key, module_id, url, title, status, current_chapter, last_check,
                last_updated, auto_download, new_chapter_count, downloaded_chapter_list,
                save_to, enabled, date_added, cover_link, library_folder
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

  public resolveMangaFolder(input: {
    readonly moduleId: string;
    readonly mangaUrl: string;
    readonly segment: string;
  }): string {
    const root = this.options.libraryRoot;
    const ownSegment = sanitizeFileName(input.moduleId);
    // 1. Computed-once seam: a favorite that already knows its effective
    //    folder is never re-derived (adding/deleting other favorites
    //    must never re-point it).
    const favorite = this.getFavorite(downloadedChaptersKey(input.moduleId, input.mangaUrl));
    if (favorite?.libraryFolder !== undefined && favorite.libraryFolder !== '') {
      return favorite.libraryFolder;
    }
    // 2. The ledger persistence of the folder: this module's own
    //    recorded layout rows (`<root>/<row.manga>/<row.fileName>`).
    if (root !== undefined) {
      let recorded: string | undefined;
      for (const row of this.listLibraryRowsForTitle(input.moduleId, input.mangaUrl, [input.segment])) {
        const rel = lexicalRelFromRoot(root, row.path);
        if (rel === undefined) {
          continue;
        }
        const segments = rel.split('/');
        if (segments.length === 2 && segments[0] === row.manga) {
          recorded = row.manga; // rows ascend by id — the last is newest
        }
      }
      if (recorded !== undefined) {
        if (favorite !== undefined) {
          this.setFavoriteLibraryFolder(favorite.mangaKey, recorded);
        }
        return recorded;
      }
    }
    // 3. Fresh computation: clean title folder unless a DIFFERENT module
    //    (or an unattributed on-disk folder) claims it (layout.ts rule 2).
    const clean = safeFolderComponent(input.segment);
    const dirAbs = root !== undefined ? join(root, clean) : undefined;
    const claimants = dirAbs !== undefined ? this.distinctModuleIdsUnderPath(dirAbs) : [];
    const diskClaim = dirAbs !== undefined && existsSync(dirAbs);
    const folder = isForeignClaim(claimants, ownSegment, diskClaim)
      ? suffixedMangaFolder(clean, ownSegment)
      : clean;
    if (favorite !== undefined) {
      this.setFavoriteLibraryFolder(favorite.mangaKey, folder);
    }
    return folder;
  }

  public setFavoriteLibraryFolder(mangaKey: string, folder: string): void {
    if (folder === '') {
      return;
    }
    this.options.db
      .prepare('UPDATE favorite SET library_folder = ? WHERE manga_key = ? AND (library_folder IS NULL OR library_folder != ?)')
      .run(folder, mangaKey, folder);
  }

  public distinctModuleIdsUnderPath(dirAbs: string): string[] {
    // substr equality, not LIKE — folder names legitimately contain %
    // and _ after sanitization and must never act as wildcards.
    const prefix = dirAbs.endsWith('/') ? dirAbs : `${dirAbs}/`;
    const rows = this.options.db
      .prepare('SELECT DISTINCT module_id FROM library_files WHERE substr(path, 1, ?) = ?')
      .all(prefix.length, prefix) as Array<{ readonly module_id: string }>;
    return rows.map((row): string => row.module_id);
  }

  public applyLayoutMigration(rows: readonly {
    id: number;
    path: string;
    manga: string;
    bytes?: number;
    mtimeMs?: number;
  }[]): void {
    if (rows.length === 0) {
      return;
    }
    const now = Date.now();
    const write = this.options.db.transaction((): void => {
      const moved = this.options.db.prepare(
        "UPDATE library_files SET path = ?, manga = ?, bytes = ?, verified_at = ?, state = 'downloaded', mtime = ? WHERE id = ?",
      );
      const repointed = this.options.db.prepare('UPDATE library_files SET path = ?, manga = ? WHERE id = ?');
      for (const row of rows) {
        if (row.bytes !== undefined && row.mtimeMs !== undefined) {
          moved.run(row.path, row.manga, row.bytes, now, row.mtimeMs, row.id);
        } else {
          repointed.run(row.path, row.manga, row.id);
        }
      }
    });
    write();
  }

  public recordLibraryFile(entry: {
    moduleId: string;
    manga: string;
    fileName: string;
    path: string;
    bytes: number;
    createdAt?: number;
    mangaUrl?: string;
    chapterLink?: string;
  }): LibraryFileRow {
    const now = entry.createdAt ?? Date.now();
    // A recorded artifact was just committed by finalize — it is
    // stat-verified truth on arrival (state/verified_at/mtime seeded,
    // so lazy verification starts warm rather than null).
    this.options.db
      .prepare(
        `INSERT INTO library_files (module_id, manga, file, path, bytes, created_at, manga_url, chapter_link, verified_at, state, mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'downloaded', ?)
         ON CONFLICT(path) DO UPDATE SET
           module_id = excluded.module_id,
           manga = excluded.manga,
           file = excluded.file,
           bytes = excluded.bytes,
           created_at = excluded.created_at,
           manga_url = COALESCE(excluded.manga_url, library_files.manga_url),
           chapter_link = COALESCE(excluded.chapter_link, library_files.chapter_link),
           verified_at = excluded.verified_at,
           state = excluded.state,
           mtime = excluded.mtime`,
      )
      .run(
        entry.moduleId,
        entry.manga,
        entry.fileName,
        entry.path,
        entry.bytes,
        now,
        entry.mangaUrl ?? null,
        entry.chapterLink ?? null,
        now,
        now,
      );
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

  /** The full ledger-row projection shared by every query below. */
  private ledgerRows(where: string, ...params: readonly unknown[]): LibraryLedgerRow[] {
    return (
      this.options.db
        .prepare(
          `SELECT id, module_id, manga, file, path, bytes, created_at, verified_at, manga_url, chapter_link, state, mtime
             FROM library_files ${where}`,
        )
        .all(...params) as LibraryLedgerDbRow[]
    ).map(toLibraryLedgerRow);
  }

  public listLibraryLedgerRows(opts?: { limit?: number; beforeId?: number }): LibraryLedgerRow[] {
    const limit = Math.max(1, Math.trunc(opts?.limit ?? 50));
    const beforeId = opts?.beforeId;
    return beforeId === undefined
      ? this.ledgerRows('ORDER BY id DESC LIMIT ?', limit)
      : this.ledgerRows('WHERE id < ? ORDER BY id DESC LIMIT ?', beforeId, limit);
  }

  public listLibraryRowsForTitle(
    moduleId: string,
    url: string,
    legacySegments: readonly string[],
  ): LibraryLedgerRow[] {
    // library_files.module_id stores the SANITIZED layout segment (the
    // finalize component) — match BOTH spellings so hex ids (identity
    // under sanitization) and separator-bearing ids resolve alike.
    const moduleKeys = [moduleId, sanitizeFileName(moduleId)];
    const modulePlaceholders = moduleKeys.map((): string => '?').join(', ');
    // Provenance rows first (module + manga url — the ONE ledger key);
    // legacy rows join on the module segment + any of the candidate
    // manga segments (title- or url-derived).
    const provenance = this.ledgerRows(
      `WHERE module_id IN (${modulePlaceholders}) AND manga_url = ? ORDER BY id ASC`,
      ...moduleKeys,
      url,
    );
    const segments = new Set(legacySegments.filter((segment): boolean => segment !== ''));
    if (segments.size === 0) {
      return provenance;
    }
    const placeholders = [...segments].map((): string => '?').join(', ');
    const legacy = this.ledgerRows(
      `WHERE manga_url IS NULL AND module_id IN (${modulePlaceholders}) AND manga IN (${placeholders}) ORDER BY id ASC`,
      ...moduleKeys,
      ...segments,
    );
    return [...provenance, ...legacy];
  }

  public allLibraryLedgerRows(): LibraryLedgerRow[] {
    return this.ledgerRows('ORDER BY id ASC');
  }

  public applyVerification(rows: readonly {
    id: number;
    at: number;
    state: 'downloaded' | 'missing';
    bytes?: number;
    mtimeMs?: number;
  }[]): void {
    if (rows.length === 0) {
      return;
    }
    const write = this.options.db.transaction((): void => {
      const update = this.options.db.prepare(
        'UPDATE library_files SET verified_at = ?, state = ?, bytes = COALESCE(?, bytes), mtime = COALESCE(?, mtime) WHERE id = ?',
      );
      for (const row of rows) {
        update.run(row.at, row.state, row.bytes ?? null, row.mtimeMs ?? null, row.id);
      }
    });
    write();
  }

  public relinkLibraryFile(id: number, path: string, bytes: number, verifiedAt: number, mtimeMs: number): void {
    this.options.db
      .prepare(
        "UPDATE library_files SET path = ?, bytes = ?, verified_at = ?, state = 'downloaded', mtime = ? WHERE id = ?",
      )
      .run(path, bytes, verifiedAt, mtimeMs, id);
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

  /** Downloads parity (delete task + data): file + row at `path`. */
  public deleteLibraryFileByPath(path: string): boolean {
    const row = this.options.db
      .prepare('SELECT id FROM library_files WHERE path = ?')
      .get(path) as { readonly id: number } | undefined;
    if (row === undefined) {
      return false;
    }
    // Remove the artifact when it is still on disk (a re-download may
    // have replaced it; a wiped dir is not an error). Regular files
    // only — never follow a path that mutated into something else.
    try {
      if (statSync(path).isFile()) {
        rmSync(path);
      }
    } catch {
      // Missing file (or unreachable) — the row removal still stands.
    }
    this.options.db.prepare('DELETE FROM library_files WHERE id = ?').run(row.id);
    return true;
  }

  public getSetting(key: string): string | undefined {
    const row = this.options.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { readonly value: string } | undefined;
    return row?.value;
  }

  public setSetting(key: string, value: string): void {
    this.options.db
      .prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
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

interface LibraryLedgerDbRow {
  readonly id: number;
  readonly module_id: string;
  readonly manga: string;
  readonly file: string;
  readonly path: string;
  readonly bytes: number;
  readonly created_at: number;
  readonly verified_at: number | null;
  readonly manga_url: string | null;
  readonly chapter_link: string | null;
  readonly state: string | null;
  readonly mtime: number | null;
}

function toLibraryLedgerRow(row: LibraryLedgerDbRow): LibraryLedgerRow {
  return {
    id: row.id,
    moduleId: row.module_id,
    manga: row.manga,
    fileName: row.file,
    path: row.path,
    bytes: row.bytes,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    mangaUrl: row.manga_url,
    chapterLink: row.chapter_link,
    state: row.state === 'downloaded' || row.state === 'missing' ? row.state : null,
    mtimeMs: row.mtime,
  };
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
  readonly save_to: string | null;
  readonly enabled: number | null;
  readonly date_added: number | null;
  readonly cover_link: string | null;
  readonly library_folder: string | null;
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
    ...(row.save_to !== null ? { saveTo: row.save_to } : {}),
    enabled: row.enabled !== 0,
    ...(row.date_added !== null ? { dateAdded: row.date_added } : {}),
    ...(row.cover_link !== null ? { coverLink: row.cover_link } : {}),
    ...(row.library_folder !== null ? { libraryFolder: row.library_folder } : {}),
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
