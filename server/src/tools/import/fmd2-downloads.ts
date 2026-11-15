import Database from 'better-sqlite3';
import { hasChapter } from '../../jobs/library/merge.js';

/**
 * fmd2-downloads — the FMD2 `downloadedchapters.db` → downloaded_chapters
 * import (D4, one-shot migration). The source schema is FMD2's
 * `TDownloadedChaptersDB` (DownloadedChaptersDB.pas:44-50):
 *   CREATE TABLE "downloadedchapters" (
 *     "id" VARCHAR(3000) NOT NULL PRIMARY KEY,
 *     "chapters" TEXT)
 * where `id = LowerCase(ModuleID+Link)` (:55, :78) — the EXACT §9
 * `downloaded_chapters.id` key (`downloadedChaptersKey('', id)` = id,
 * FMD2 keys are already lowercase) and `chapters` the merged case-
 * insensitive list text.
 *
 * Idempotency: each row lands through the store's SetChapters semantics
 * (merge-or-insert, DownloadedChaptersDB.pas:62-90) — a re-run merges
 * the same lines (dupIgnore) and the row count never grows.
 */

/** Import format failure — the CLI reports it and exits nonzero. */
export class ImportSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportSourceError';
  }
}

/** One source row (id already LowerCase(ModuleID+Link)). */
export interface DownloadedSourceRow {
  readonly key: string;
  readonly chapters: string;
}

/** Read the FMD2 downloadedchapters.db (read-only, must exist). */
export function readFmd2DownloadedDb(path: string): DownloadedSourceRow[] {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (err: unknown) {
    throw new ImportSourceError(
      `cannot open downloadedchapters.db at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const table = (
      db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'downloadedchapters'`,
      ).all() as { name: string }[]
    ).at(0);
    if (table === undefined) {
      throw new ImportSourceError(`${path} has no "downloadedchapters" table (not an FMD2 downloadedchapters.db?)`);
    }
    const rows = db
      .prepare(`SELECT "id" AS id, "chapters" AS chapters FROM "downloadedchapters"`)
      .all() as { id: unknown; chapters: unknown }[];
    const out: DownloadedSourceRow[] = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id === '') {
        continue; // a keyless row cannot map onto the §9 key — skipped
      }
      out.push({ key: row.id.toLowerCase(), chapters: typeof row.chapters === 'string' ? row.chapters : '' });
    }
    return out;
  } finally {
    db.close();
  }
}

/** The import write seam — `SqliteLibraryStore.setDownloadedChapters`
 * satisfies it structurally (the CLI passes `('', key)`; the store
 * recomputes `LowerCase('' + key)` = the identical FMD2 key). */
export interface DownloadImportTarget {
  setDownloadedChapters(moduleId: string, link: string, chapters: string): void;
  getDownloadedChapters(moduleId: string, link: string): string;
}

export interface ImportDownloadsSummary {
  /** Rows in the source db. */
  readonly total: number;
  /** Rows written (merge-or-insert). */
  readonly imported: number;
  /** Rows whose chapter list already contained every line (no-op merge). */
  readonly unchanged: number;
}

/**
 * Import source rows through the target's SetChapters semantics. An empty
 * `chapters` text mirrors FMD2's SetChapters('') no-op (:65). Idempotent:
 * re-running imports the same rows — every merge is a dupIgnore union, so
 * row counts and lists stay stable (the `unchanged` count captures that).
 */
export function importFmd2Downloads(
  rows: readonly DownloadedSourceRow[],
  target: DownloadImportTarget,
): ImportDownloadsSummary {
  let imported = 0;
  let unchanged = 0;
  for (const row of rows) {
    const stored = target.getDownloadedChapters('', row.key);
    if (row.chapters === '') {
      unchanged += 1; // SetChapters('') exits — nothing to write (:65)
      continue;
    }
    // Already fully present? then the merge changes nothing (re-run).
    const lines = row.chapters.length > 0;
    const allPresent = lines && everyLinePresent(stored, row.chapters);
    target.setDownloadedChapters('', row.key, row.chapters);
    if (allPresent) {
      unchanged += 1;
    } else {
      imported += 1;
    }
  }
  return { total: rows.length, imported, unchanged };
}

/** Every source line already stored (case-insensitive, dupIgnore union). */
function everyLinePresent(stored: string, chapters: string): boolean {
  for (const line of chapters.split(/\r\n|\r|\n/)) {
    if (line === '') {
      continue;
    }
    if (!hasChapter(stored, line)) {
      return false;
    }
  }
  return true;
}
