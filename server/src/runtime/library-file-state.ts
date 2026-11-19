/**
 * Library file-state service (library file-state story, owner-approved
 * design): the server-storage truth window for a web-only deployment.
 *
 * STATE CONTRACT (per chapter file):
 *   downloaded    — downloaded-chapters ledger entry AND its file
 *                   exists at the recorded path (stat-verified);
 *   missing       — ledger entry, file not at the recorded path
 *                   (moved-out and deleted are deliberately
 *                   indistinguishable — until a rescan re-links);
 *   not_downloaded — no ledger entry (chapter-side derivation; the
 *                   web merges this from the live chapter list);
 *   orphan        — file under the library root with no ledger row
 *                   (rescan truth; per-title listings scope it to the
 *                   title's convention directory).
 *
 * Every tracked row carries a verified_at stamp + its recorded
 * absolute path; the displayed path is root-relative (clamped —
 * out-of-root paths are never displayed).
 *
 * Guardrails: metadata only (NO file bytes — nothing here streams
 * content); every walked/displayed path is realpath-clamped to the
 * library root; hidden dotfiles are skipped (which also prunes the
 * finalizer's `.tmp-` litter).
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../api/errors.js';
import { sanitizeFileName, urlSegment } from '../jobs/library/filenames.js';
import { splitTextLines } from '../jobs/library/merge.js';
import { reconcileLibrary, type LibraryLedgerRow } from '../jobs/library/reconcile.js';
import type { SqliteLibraryStore } from '../jobs/library/store.js';
import {
  displayFromRoot,
  lexicalRelFromRoot,
  rootAnchor,
  walkTree,
  type WalkedFile,
} from '../fs-walk.js';

/** Lazy-verify staleness window (feature ruling): >15 min re-verifies. */
export const VERIFY_STALE_MS = 15 * 60 * 1000;

/** app_settings key holding the last persisted rescan diff report. */
export const RESCAN_REPORT_KEY = 'library.rescan.last';

/** Cap for filter=missing listing scans (worst-case bound; single
 * operator libraries stay far below — documented, not silent). */
const MISSING_SCAN_CAP = 5000;

export type TrackedFileState = 'downloaded' | 'missing';

export interface TitleFileEntry {
  readonly id?: string;
  readonly chapterLink?: string;
  readonly fileName?: string;
  readonly path?: string;
  readonly absolutePath?: string;
  readonly bytes?: number;
  readonly mtime?: string;
  readonly state: TrackedFileState;
  readonly verifiedAt?: string;
}

export interface OrphanFileEntry {
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: number;
  readonly mtime: string;
}

export interface TitleFilesResult {
  readonly moduleId: string;
  readonly url: string;
  readonly verifiedAt: string;
  readonly files: readonly TitleFileEntry[];
  readonly orphans: readonly OrphanFileEntry[];
}

export interface RescanRelinkEntry {
  readonly id: string;
  readonly fromPath: string;
  readonly toPath: string;
}

export interface RescanMissingEntry {
  readonly id: string;
  readonly manga: string;
  readonly fileName: string;
  readonly path?: string;
  readonly candidates: readonly string[];
}

export interface RescanReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly scope: 'library' | { readonly kind: 'title'; readonly moduleId: string; readonly url: string };
  readonly counts: {
    readonly scanned: number;
    readonly present: number;
    readonly relinked: number;
    readonly missing: number;
    readonly orphans: number;
    readonly outsideRoot: number;
  };
  readonly relinked: readonly RescanRelinkEntry[];
  readonly missing: readonly RescanMissingEntry[];
  readonly orphans: readonly OrphanFileEntry[];
}

export interface LibraryStateFileEntry {
  readonly id: string;
  readonly moduleId: string;
  readonly manga: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly state: TrackedFileState;
  readonly verifiedAt: string | null;
  readonly path?: string;
  readonly absolutePath?: string;
  readonly mtime?: string;
}

export interface LibraryStatePage {
  readonly files: readonly LibraryStateFileEntry[];
  readonly nextCursor?: string;
  readonly orphans?: readonly OrphanFileEntry[];
}

export interface LibraryFileStateOptions {
  readonly store: SqliteLibraryStore;
  /** Absolute library root (the downloads root — §7.1 layout). */
  readonly root: string;
}

function toIso(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined ? undefined : new Date(ms).toISOString();
}

function orphanEntry(file: WalkedFile): OrphanFileEntry {
  return {
    path: file.relPath,
    absolutePath: file.absPath,
    bytes: file.bytes,
    mtime: new Date(file.mtimeMs).toISOString(),
  };
}

/**
 * The fs-truth adapter over `library_files` + the downloaded-chapters
 * ledger (ONE ledger truth — this service reads both, writes only
 * verification stamps, re-links, and the persisted rescan report).
 */
export class SqliteLibraryFileStateService {
  private readonly store: SqliteLibraryStore;
  private readonly root: string;

  public constructor(options: LibraryFileStateOptions) {
    this.store = options.store;
    this.root = options.root;
  }

  /**
   * The root's realpath anchor, resolved lazily + tolerantly: a fresh
   * deployment boots before any finalize creates the library root —
   * display clamps simply degrade (undefined) until it exists.
   */
  private anchor(): string | undefined {
    try {
      return rootAnchor(this.root);
    } catch {
      return undefined;
    }
  }

  /**
   * Per-title file listing (manga detail 'Files' section + library
   * drill-in): ledger rows for the title, lazy-verified (stale >
   * 15 min or `refresh` re-stats), plus the downloaded-chapter links
   * without rows (missing — imported ledger truth) and the orphans
   * under the title's convention directory (scoped walk, cheap).
   */
  public titleFiles(opts: {
    moduleId: string;
    url: string;
    manga?: string;
    refresh?: boolean;
  }): TitleFilesResult {
    const now = Date.now();
    const rows = this.rowsForTitle(opts.moduleId, opts.url, opts.manga);
    const verified = this.verifyRows(rows, now, opts.refresh === true);

    const files: TitleFileEntry[] = [];
    const seenRowIds = new Set<number>();
    const byChapter = new Map<string, LibraryLedgerRow & { verdict: Verified }>();
    for (const item of verified) {
      if (item.chapterLink !== null) {
        byChapter.set(item.chapterLink, item);
      }
    }
    // Ledger-first walk (the ONE ledger truth): every downloaded
    // chapter link renders, row or no row.
    const links = splitTextLines(this.store.getDownloadedChapters(opts.moduleId, opts.url));
    for (const link of links) {
      const matched = byChapter.get(link);
      if (matched !== undefined) {
        seenRowIds.add(matched.id);
        files.push(this.toTitleEntry(matched));
        continue;
      }
      files.push({ chapterLink: link, state: 'missing' });
    }
    // Rows outside the ledger link set (legacy or ledger-cleared):
    // still tracked files — listed with their own state.
    for (const item of verified) {
      if (!seenRowIds.has(item.id)) {
        files.push(this.toTitleEntry(item));
      }
    }

    return {
      moduleId: opts.moduleId,
      url: opts.url,
      verifiedAt: new Date(now).toISOString(),
      files,
      orphans: this.titleOrphans(rows, opts.moduleId, opts.manga, opts.url),
    };
  }

  /**
   * 'Rescan library' (global) and the per-title variant: walk the root
   * through the shared walker seam, reconcile ledger vs disk, persist
   * confident re-links + verification stamps, and return (persisting)
   * the diff report. Ambiguous matches stay missing+orphan pairs.
   */
  public rescan(opts?: { moduleId?: string; url?: string; manga?: string }): RescanReport {
    const started = Date.now();
    const titleScoped =
      opts?.moduleId !== undefined && opts.url !== undefined
        ? { moduleId: opts.moduleId, url: opts.url }
        : undefined;
    const disk = walkTree(this.root, { skipDotfiles: true, followSymlinkedFiles: true });
    const rows = titleScoped === undefined
      ? this.store.allLibraryLedgerRows()
      : this.rowsForTitle(titleScoped.moduleId, titleScoped.url, opts?.manga);
    const result = reconcileLibrary({ root: this.root, rows, disk });

    const now = Date.now();
    const relinkPersist = this.store.relinkLibraryFile.bind(this.store);
    for (const relink of result.relinked) {
      relinkPersist(relink.id, relink.toAbsPath, relink.bytes, now, relink.mtimeMs);
    }
    this.store.applyVerification(
      result.present.map((present): {
        id: number;
        at: number;
        state: 'downloaded';
        bytes: number;
        mtimeMs: number;
      } => ({
        id: present.id,
        at: now,
        state: 'downloaded',
        bytes: present.bytes,
        mtimeMs: present.mtimeMs,
      })),
    );
    const missingStamps = [
      ...result.missing.map((missing): { id: number; at: number; state: 'missing' } => ({
        id: missing.id,
        at: now,
        state: 'missing',
      })),
    ];
    this.store.applyVerification(missingStamps);

    const orphanScope = titleScoped === undefined
      ? result.orphans
      : (() => {
          const dirs = this.titleConventionDirs(
            rows,
            titleScoped.moduleId,
            opts?.manga,
            titleScoped.url,
          );
          return result.orphans.filter((file): boolean =>
            dirs.some((dir): boolean => file.relPath === dir || file.relPath.startsWith(`${dir}/`)),
          );
        })();
    const report: RescanReport = {
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(now).toISOString(),
      durationMs: now - started,
      scope: titleScoped === undefined
        ? 'library'
        : { kind: 'title', moduleId: titleScoped.moduleId, url: titleScoped.url },
      counts: {
        scanned: disk.length,
        present: result.present.length,
        relinked: result.relinked.length,
        missing: result.missing.length,
        orphans: orphanScope.length,
        outsideRoot: result.outsideRoot,
      },
      relinked: result.relinked.map((relink): RescanRelinkEntry => ({
        id: String(relink.id),
        fromPath: relink.fromPath,
        toPath: relink.toPath,
      })),
      missing: result.missing.map((missing): RescanMissingEntry => ({
        id: String(missing.id),
        manga: missing.manga,
        fileName: missing.fileName,
        ...(missing.path !== undefined ? { path: missing.path } : {}),
        candidates: missing.candidates,
      })),
      orphans: orphanScope.map((file): OrphanFileEntry => orphanEntry(file)),
    };
    this.store.setSetting(RESCAN_REPORT_KEY, JSON.stringify(report));
    return report;
  }

  /** The persisted diff report of the last rescan (undefined = none). */
  public lastRescan(): RescanReport | undefined {
    const raw = this.store.getSetting(RESCAN_REPORT_KEY);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as RescanReport;
    } catch {
      return undefined;
    }
  }

  /**
   * Enriched library listing (Library page): page rows with verified
   * state + display path; `filter=missing` scans newest-first for
   * missing rows; `filter=orphans` serves the last rescan's persisted
   * orphan list (orphans are rescan truth, never a live walk per
   * listing).
   */
  public listWithState(opts: {
    cursor?: string;
    limit: number;
    filter?: 'all' | 'missing' | 'orphans';
  }): LibraryStatePage {
    if (opts.filter === 'orphans') {
      const report = this.lastRescan();
      return { files: [], orphans: report?.orphans ?? [] };
    }
    let beforeId: number | undefined;
    if (opts.cursor !== undefined) {
      const raw = Number.parseInt(Buffer.from(opts.cursor, 'base64url').toString('utf8'), 10);
      if (!Number.isInteger(raw) || raw < 0) {
        throw new ApiError(400, 'bad_request', 'invalid library cursor');
      }
      beforeId = raw;
    }
    if (opts.filter === 'missing') {
      return this.listMissing(opts.limit, beforeId);
    }
    const rows = this.store.listLibraryLedgerRows({ limit: opts.limit, ...(beforeId !== undefined ? { beforeId } : {}) });
    const now = Date.now();
    // Page-bounded stat: the listing reflects verified truth; the
    // persisted stamp refresh respects the staleness window (write
    // discipline — reads stay cheap).
    const entries = rows.map((row): { row: LibraryLedgerRow; verdict: Verified } => ({
      row,
      verdict: this.statVerdict(row.path),
    }));
    this.store.applyVerification(
      entries
        .filter(({ row }): boolean => this.isStale(row, now))
        .map(({ row, verdict }): { id: number; at: number; state: TrackedFileState; bytes?: number; mtimeMs?: number } => ({
          id: row.id,
          at: now,
          state: verdict.state,
          ...(verdict.state === 'downloaded' ? { bytes: verdict.bytes, mtimeMs: verdict.mtimeMs } : {}),
        })),
    );
    return { files: entries.map(({ row, verdict }): LibraryStateFileEntry => this.toStateEntry(row, verdict)) };
  }

  private listMissing(limit: number, beforeId: number | undefined): LibraryStatePage {
    const now = Date.now();
    const entries: Array<{ row: LibraryLedgerRow; verdict: Verified }> = [];
    let cursor = beforeId;
    let scanned = 0;
    let lastId: number | undefined;
    while (entries.length <= limit && scanned < MISSING_SCAN_CAP) {
      const page = this.store.listLibraryLedgerRows({ limit: 100, ...(cursor !== undefined ? { beforeId: cursor } : {}) });
      if (page.length === 0) {
        break;
      }
      for (const row of page) {
        scanned += 1;
        lastId = row.id;
        cursor = row.id;
        const verdict = this.statVerdict(row.path);
        if (verdict.state === 'missing') {
          entries.push({ row, verdict });
          if (entries.length > limit) {
            break;
          }
        }
      }
    }
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    this.store.applyVerification(
      page.map(({ row, verdict }): { id: number; at: number; state: TrackedFileState } => ({
        id: row.id,
        at: now,
        state: verdict.state,
      })),
    );
    return {
      files: page.map(({ row, verdict }): LibraryStateFileEntry => this.toStateEntry(row, verdict)),
      ...(hasMore && lastId !== undefined
        ? { nextCursor: Buffer.from(String(lastId), 'utf8').toString('base64url') }
        : {}),
    };
  }

  /** Rows for one title: provenance join + legacy segment fallback. */
  private rowsForTitle(moduleId: string, url: string, manga?: string): LibraryLedgerRow[] {
    const legacy: string[] = [];
    if (manga !== undefined && manga !== '') {
      legacy.push(urlSegment(manga, 'manga'));
    }
    legacy.push(urlSegment(url, 'manga'));
    return this.store.listLibraryRowsForTitle(moduleId, url, [...new Set(legacy)]);
  }

  /** Distinct convention directories for a title (from its rows + the
   * predicted segment when no rows exist yet). */
  private titleConventionDirs(
    rows: readonly LibraryLedgerRow[],
    moduleId: string,
    manga: string | undefined,
    url: string,
  ): string[] {
    const dirs = new Set<string>();
    for (const row of rows) {
      dirs.add(`${row.moduleId}/${row.manga}`);
    }
    dirs.add(`${sanitizeFileName(moduleId)}/${urlSegment(manga ?? url, 'manga')}`);
    return [...dirs];
  }

  /**
   * Scoped orphan walk of the title's convention directory(ies): files
   * no ledger row claims (claimed = ANY row recording into the dir —
   * cross-title saveTo rows never false-orphan). Dotfiles skipped;
   * symlink escapes skipped (walker guardrails).
   */
  private titleOrphans(
    rows: readonly LibraryLedgerRow[],
    moduleId: string,
    manga: string | undefined,
    url: string,
  ): OrphanFileEntry[] {
    const dirs = this.titleConventionDirs(rows, moduleId, manga, url);
    if (dirs.length === 0) {
      return [];
    }
    const claimed = new Set<string>();
    for (const row of this.store.allLibraryLedgerRows()) {
      const rel = lexicalRelFromRoot(this.root, row.path);
      if (rel !== undefined) {
        claimed.add(rel);
      }
    }
    const orphans: OrphanFileEntry[] = [];
    for (const dir of dirs) {
      const walked = walkTree(join(this.root, dir), { skipDotfiles: true, followSymlinkedFiles: true });
      for (const file of walked) {
        const rel = `${dir}/${file.relPath}`;
        if (!claimed.has(rel)) {
          orphans.push({ ...orphanEntry(file), path: rel });
        }
      }
    }
    return orphans;
  }

  /**
   * Lazy verify (feature 1): stat rows whose verdict is stale (>15 min
   * or never) or always when `refresh`; persist the fresh stamps; keep
   * the cached verdict for fresh rows (the staleness tolerance the
   * design rules in — no fs.watch).
   */
  private verifyRows(rows: readonly LibraryLedgerRow[], now: number, refresh: boolean): Array<LibraryLedgerRow & { verdict: Verified }> {
    const out: Array<LibraryLedgerRow & { verdict: Verified }> = [];
    const stamps: Array<{ id: number; at: number; state: TrackedFileState; bytes?: number; mtimeMs?: number }> = [];
    for (const row of rows) {
      const stale = this.isStale(row, now);
      if (refresh || stale) {
        const verdict = this.statVerdict(row.path);
        out.push({ ...row, verdict });
        stamps.push({
          id: row.id,
          at: now,
          state: verdict.state,
          ...(verdict.state === 'downloaded' ? { bytes: verdict.bytes, mtimeMs: verdict.mtimeMs } : {}),
        });
      } else {
        // Cached verdict (fresh): the recorded pair (state + stamps).
        const state: TrackedFileState = row.state ?? 'missing';
        out.push({
          ...row,
          verdict:
            state === 'downloaded'
              ? { state, bytes: row.bytes, mtimeMs: row.mtimeMs ?? 0 }
              : { state, bytes: 0, mtimeMs: 0 },
        });
      }
    }
    this.store.applyVerification(stamps);
    return out;
  }

  private isStale(row: LibraryLedgerRow, now: number): boolean {
    return row.verifiedAt === null || now - row.verifiedAt > VERIFY_STALE_MS;
  }

  private statVerdict(path: string): Verified {
    try {
      const st = statSync(path); // follows symlinks — a symlinked file
      // resolves to its target's truth; the DISPLAY clamp stays at the
      // walk/serve layer.
      if (st.isFile()) {
        return { state: 'downloaded', bytes: st.size, mtimeMs: st.mtimeMs };
      }
      return { state: 'missing', bytes: 0, mtimeMs: 0 };
    } catch {
      return { state: 'missing', bytes: 0, mtimeMs: 0 };
    }
  }

  private toTitleEntry(item: LibraryLedgerRow & { verdict: Verified }): TitleFileEntry {
    const rootReal = this.anchor();
    const display = rootReal !== undefined ? displayFromRoot(rootReal, this.root, item.path) : undefined;
    return {
      id: String(item.id),
      ...(item.chapterLink !== null ? { chapterLink: item.chapterLink } : {}),
      ...(item.fileName !== '' ? { fileName: item.fileName } : {}),
      ...(display !== undefined ? { path: display, absolutePath: item.path } : {}),
      ...(item.verdict.state === 'downloaded' ? this.downloadedMeta(item.verdict) : {}),
      state: item.verdict.state,
      ...(item.verifiedAt !== null ? { verifiedAt: new Date(item.verifiedAt).toISOString() } : {}),
    };
  }

  /** Downloaded-file metadata spread (exactOptionalPropertyTypes-safe). */
  private downloadedMeta(verdict: Verified): { bytes: number; mtime?: string } {
    const mtime = toIso(verdict.mtimeMs);
    return { bytes: verdict.bytes, ...(mtime !== undefined ? { mtime } : {}) };
  }

  private toStateEntry(row: LibraryLedgerRow, verdict: Verified): LibraryStateFileEntry {
    const rootReal = this.anchor();
    const display = rootReal !== undefined ? displayFromRoot(rootReal, this.root, row.path) : undefined;
    const mtime = verdict.state === 'downloaded' ? toIso(verdict.mtimeMs) : undefined;
    return {
      id: String(row.id),
      moduleId: row.moduleId,
      manga: row.manga,
      fileName: row.fileName,
      bytes: verdict.state === 'downloaded' ? verdict.bytes : row.bytes,
      createdAt: new Date(row.createdAt).toISOString(),
      state: verdict.state,
      verifiedAt: toIso(row.verifiedAt) ?? null,
      ...(display !== undefined ? { path: display, absolutePath: row.path } : {}),
      ...(mtime !== undefined ? { mtime } : {}),
    };
  }
}

interface Verified {
  readonly state: TrackedFileState;
  readonly bytes: number;
  readonly mtimeMs: number;
}
