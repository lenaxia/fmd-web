import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { ApiError } from '../api/errors.js';
import { isUnderRoot, rootAnchor } from '../fs-walk.js';
import type { LibraryFileRecord, LibraryPage, LibraryService } from '../api/services.js';
import type { SqliteLibraryStore } from '../jobs/library/store.js';
import { splitTextLines } from '../jobs/library/merge.js';

/**
 * The §10 LibraryService port over `library_files` (§9): newest-first
 * keyset pages (id cursor), the download-route path resolution, and the
 * job lane's `recordLibraryFile` write-through. Routes never touch the
 * fs — this adapter is the one fs boundary.
 *
 * [file-state guardrail] `resolveFile` clamps: the recorded path must
 * realpath UNDER the library root (symlink escapes are a typed 403 —
 * never an arbitrary-file server) and must not be a dotfile (the
 * finalizer never writes one; a tampered row is refused, not served).
 */
export class SqliteLibraryService implements LibraryService {
  /**
   * The root's realpath anchor, resolved LAZILY: a fresh deployment
   * boots before any finalize creates `<dataDir>/library` — the
   * constructor must never throw on a not-yet-existing root (the
   * finalizer owns its creation). Re-resolved per use so a root
   * created (or removed) later in the process lifetime is honored.
   */
  private anchor(): string | undefined {
    if (this.root === undefined) {
      return undefined;
    }
    try {
      return rootAnchor(this.root);
    } catch {
      return undefined;
    }
  }

  public constructor(
    private readonly store: SqliteLibraryStore,
    private readonly root?: string,
  ) {}

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
    if (row === undefined) {
      return undefined;
    }
    // Guardrail: dotfiles are never served (the walker skips them too).
    if (basename(row.path).startsWith('.')) {
      return undefined;
    }
    // Existence first (follows symlinks): missing/non-file → the route's
    // 404/410 path, never a clamp verdict about a gone file.
    let st;
    try {
      st = statSync(row.path);
    } catch {
      return undefined;
    }
    if (!st.isFile()) {
      return undefined;
    }
    // Guardrail: realpath clamp — a recorded path resolving OUTSIDE the
    // library root (tampered row, relocated symlink) is a typed 403,
    // never a stream. A missing/unresolvable ROOT clamps everything
    // out silently (no root → no servable library files).
    const anchor = this.anchor();
    if (anchor !== undefined && !isUnderRoot(anchor, row.path)) {
      throw new ApiError(403, 'path_outside_library_root', 'library file path resolves outside the downloads root');
    }
    return row.path;
  }

  /** The §9 ledger read behind /api/info's embedded `downloaded` set. */
  downloadedChapters(moduleId: string, url: string): string[] {
    const text = this.store.getDownloadedChapters(moduleId, url);
    return text === '' ? [] : splitTextLines(text);
  }

  /** [UX-AUDIT L-2] delete-one-artifact (file + row) — the store's
   * deleteLibraryFileByPath already owns the unlink safety guard. */
  remove(id: string): boolean {
    const row = this.store.getLibraryFile(id);
    if (row === undefined) {
      return false;
    }
    return this.store.deleteLibraryFileByPath(row.path);
  }
}
