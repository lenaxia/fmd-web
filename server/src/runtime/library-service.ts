import { existsSync } from 'node:fs';
import { ApiError } from '../api/errors.js';
import type { LibraryFileRecord, LibraryPage, LibraryService } from '../api/services.js';
import type { SqliteLibraryStore } from '../jobs/library/store.js';
import { splitTextLines } from '../jobs/library/merge.js';

/**
 * The §10 LibraryService port over `library_files` (§9): newest-first
 * keyset pages (id cursor), the download-route path resolution, and the
 * job lane's `recordLibraryFile` write-through. Routes never touch the
 * fs — this adapter is the one fs boundary.
 */
export class SqliteLibraryService implements LibraryService {
  constructor(private readonly store: SqliteLibraryStore) {}

  list(opts: { cursor?: string; limit: number }): LibraryPage {
    let beforeId: number | undefined;
    if (opts.cursor !== undefined) {
      const raw = Number.parseInt(Buffer.from(opts.cursor, 'base64url').toString('utf8'), 10);
      if (!Number.isInteger(raw) || raw < 0) {
        throw new ApiError(400, 'bad_request', 'invalid library cursor');
      }
      beforeId = raw;
    }
    const rows = this.store.listLibraryFiles({ limit: opts.limit, ...(beforeId !== undefined ? { beforeId } : {}) });
    const files: LibraryFileRecord[] = rows.map((row): LibraryFileRecord => ({
      id: row.id,
      moduleId: row.moduleId,
      manga: row.manga,
      fileName: row.fileName,
      bytes: row.bytes,
      createdAt: row.createdAt,
    }));
    if (rows.length === opts.limit && rows.length > 0) {
      const last = rows[rows.length - 1];
      if (last !== undefined && this.store.listLibraryFiles({ limit: 1, beforeId: Number(last.id) }).length > 0) {
        return { files, nextCursor: Buffer.from(last.id, 'utf8').toString('base64url') };
      }
    }
    return { files };
  }

  get(id: string): LibraryFileRecord | undefined {
    const row = this.store.getLibraryFile(id);
    return row === undefined
      ? undefined
      : {
          id: row.id,
          moduleId: row.moduleId,
          manga: row.manga,
          fileName: row.fileName,
          bytes: row.bytes,
          createdAt: row.createdAt,
        };
  }

  resolveFile(id: string): string | undefined {
    const row = this.store.getLibraryFile(id);
    if (row === undefined || !existsSync(row.path)) {
      return undefined;
    }
    return row.path;
  }

  /** The §9 ledger read behind /api/info's embedded `downloaded` set. */
  downloadedChapters(moduleId: string, url: string): string[] {
    const text = this.store.getDownloadedChapters(moduleId, url);
    return text === '' ? [] : splitTextLines(text);
  }
}
