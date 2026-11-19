/**
 * [file-state] SqliteLibraryFileStateService over a REAL store + temp
 * library root: the lazy-verify staleness contract (>15 min or refresh
 * re-verifies; fresh stamps serve the cached verdict), the per-title
 * listing shape (ledger-first — imported links without rows render
 * missing), conservative rescan persistence (moved re-link, deleted
 * missing, orphan, ambiguity pair) with the persisted diff report,
 * and the library-list enrichment (missing/orphans filters).
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteLibraryStore } from '../../src/jobs/library/store.js';
import { linesToText } from '../../src/jobs/library/merge.js';
import {
  RESCAN_REPORT_KEY,
  SqliteLibraryFileStateService,
  VERIFY_STALE_MS,
} from '../../src/runtime/library-file-state.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const URL = 'https://ex.org/manga/x';

let dir = '';

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

interface Harness {
  readonly store: SqliteLibraryStore;
  readonly service: SqliteLibraryFileStateService;
  readonly root: string;
}

function open(): Harness {
  dir = join(tmpdir(), `fmd-filestate-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const root = join(dir, 'library');
  mkdirSync(root, { recursive: true });
  const raw = new Database(join(dir, 'app.db'));
  const store = new SqliteLibraryStore({ db: raw, libraryRoot: root });
  return { store, service: new SqliteLibraryFileStateService({ store, root }), root };
}

function record(h: Harness, opts: { file: string; mangaUrl?: string; chapterLink?: string; mangaSegment?: string; bytes?: number }): number {
  const abs = join(h.root, opts.file);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, Buffer.alloc(opts.bytes ?? 16, 7));
  const segments = opts.file.split('/');
  const row = h.store.recordLibraryFile({
    moduleId: MODULE,
    // [library-layout] flat convention: the folder is the FIRST (only)
    // directory segment.
    manga: opts.mangaSegment ?? segments[0] ?? 'mangam',
    fileName: segments[segments.length - 1] ?? 'ch.cbz',
    path: abs,
    bytes: opts.bytes ?? 16,
    ...(opts.mangaUrl !== undefined ? { mangaUrl: opts.mangaUrl } : {}),
    ...(opts.chapterLink !== undefined ? { chapterLink: opts.chapterLink } : {}),
  });
  return Number(row.id);
}

function backdate(h: Harness, id: number, msAgo: number): void {
  h.store.applyVerification([{ id, at: Date.now() - msAgo, state: 'downloaded' }]);
}

describe('titleFiles — lazy verify + the state contract', (): void => {
  it('downloaded: ledger row AND file at recorded path (stat-verified, stamps persisted)', (): void => {
    const h = open();
    h.store.setDownloadedChapters(MODULE, URL, linesToText(['https://ex.org/manga/x/1']));
    record(h, { file: 'mangam/ch-001.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    const result = h.service.titleFiles({ moduleId: MODULE, url: URL });
    expect(result.files).toHaveLength(1);
    const entry = result.files[0];
    expect(entry?.state).toBe('downloaded');
    expect(entry?.chapterLink).toBe('https://ex.org/manga/x/1');
    expect(entry?.path).toBe('mangam/ch-001.cbz');
    expect(entry?.absolutePath).toBe(join(h.root, 'mangam/ch-001.cbz'));
    expect(entry?.bytes).toBe(16);
    expect(entry?.mtime).toBeDefined();
    expect(entry?.verifiedAt).toBeDefined();
  });

  it('fresh verdict serves from cache (a just-deleted file stays downloaded INSIDE the tolerance window)', (): void => {
    const h = open();
    h.store.setDownloadedChapters(MODULE, URL, linesToText(['https://ex.org/manga/x/1']));
    const id = record(h, { file: 'mangam/ch-001.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    rmSync(join(h.root, 'mangam/ch-001.cbz'));
    // Freshly recorded → verified_at is now → cached verdict wins.
    const cached = h.service.titleFiles({ moduleId: MODULE, url: URL });
    expect(cached.files[0]?.state).toBe('downloaded');
    // Explicit refresh forces the re-stat → the truth flips.
    const refreshed = h.service.titleFiles({ moduleId: MODULE, url: URL, refresh: true });
    expect(refreshed.files[0]?.state).toBe('missing');
    void id;
  });

  it('stale stamps (>15 min) re-verify on open — no refresh flag needed', (): void => {
    const h = open();
    h.store.setDownloadedChapters(MODULE, URL, linesToText(['https://ex.org/manga/x/1']));
    const id = record(h, { file: 'mangam/ch-001.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    rmSync(join(h.root, 'mangam/ch-001.cbz'));
    backdate(h, id, VERIFY_STALE_MS + 60_000);
    const result = h.service.titleFiles({ moduleId: MODULE, url: URL });
    expect(result.files[0]?.state).toBe('missing');
    // The re-verified stamp persisted.
    const rows = h.store.allLibraryLedgerRows();
    expect(rows[0]?.state).toBe('missing');
    expect(rows[0]?.verifiedAt).not.toBeNull();
    expect((rows[0]?.verifiedAt ?? 0)).toBeGreaterThan(Date.now() - VERIFY_STALE_MS);
  });

  it('not_downloaded chapters stay OUT of the tracked listing (ledger-first); imported links without rows render missing', (): void => {
    const h = open();
    h.store.setDownloadedChapters(
      MODULE,
      URL,
      linesToText(['https://ex.org/manga/x/1', 'https://ex.org/manga/x/imported-only']),
    );
    record(h, { file: 'mangam/ch-001.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    const result = h.service.titleFiles({ moduleId: MODULE, url: URL });
    expect(result.files).toHaveLength(2);
    const imported = result.files.find((f) => f.chapterLink === 'https://ex.org/manga/x/imported-only');
    expect(imported?.state).toBe('missing');
    expect(imported?.fileName).toBeUndefined();
    expect(imported?.path).toBeUndefined();
  });

  it('legacy rows (no provenance) match by the sanitized manga segment from the title', (): void => {
    const h = open();
    record(h, { file: 'Alpha Quest/ch-001.cbz', mangaSegment: 'Alpha Quest' });
    const result = h.service.titleFiles({ moduleId: MODULE, url: URL, manga: 'Alpha Quest' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('Alpha Quest/ch-001.cbz');
  });

  it('orphans: untracked files under the title convention dir, dotfiles skipped', (): void => {
    const h = open();
    record(h, { file: 'mangam/ch-001.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    writeFileSync(join(h.root, 'mangam', 'untracked.cbz'), Buffer.alloc(5, 1));
    writeFileSync(join(h.root, 'mangam', '.DS_Store'), Buffer.alloc(5, 1));
    const result = h.service.titleFiles({ moduleId: MODULE, url: URL, manga: 'x' });
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]?.path).toBe('mangam/untracked.cbz');
    expect(result.orphans[0]?.bytes).toBe(5);
    expect(result.orphans[0]?.mtime).toBeDefined();
  });
});

describe('rescan — conservative reconcile + persisted report', (): void => {
  it('moved + deleted + orphan seed: re-link persists, missing stays, orphan surfaces, report round-trips', (): void => {
    const h = open();
    const movedId = record(h, { file: 'mangam/ch-moved.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    const deletedId = record(h, { file: 'mangam/ch-deleted.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/2' });
    // The moved file relocates within the root.
    mkdirSync(join(h.root, 'imported'), { recursive: true });
    renameSync(join(h.root, 'mangam/ch-moved.cbz'), join(h.root, 'imported/ch-moved.cbz'));
    // The deleted file just goes away.
    rmSync(join(h.root, 'mangam/ch-deleted.cbz'));
    // An orphan appears.
    mkdirSync(join(h.root, 'stray'), { recursive: true });
    writeFileSync(join(h.root, 'stray/orphan.cbz'), Buffer.alloc(21, 1));

    const report = h.service.rescan();

    expect(report.scope).toBe('library');
    expect(report.counts.scanned).toBe(2);
    expect(report.counts.relinked).toBe(1);
    expect(report.counts.missing).toBe(1);
    expect(report.counts.orphans).toBe(1);
    expect(report.relinked[0]).toMatchObject({ id: String(movedId), fromPath: 'mangam/ch-moved.cbz', toPath: 'imported/ch-moved.cbz' });
    expect(report.missing[0]).toMatchObject({ id: String(deletedId), path: 'mangam/ch-deleted.cbz' });
    expect(report.orphans[0]?.path).toBe('stray/orphan.cbz');
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.startedAt).toBeDefined();
    expect(report.finishedAt).toBeDefined();

    // The re-link PERSISTED: the row now points at the moved file.
    const rows = new Map(h.store.allLibraryLedgerRows().map((r) => [r.id, r]));
    expect(rows.get(movedId)?.path).toBe(join(h.root, 'imported/ch-moved.cbz'));
    expect(rows.get(movedId)?.state).toBe('downloaded');
    expect(rows.get(deletedId)?.state).toBe('missing');

    // The report persisted and re-serves.
    const again = h.service.lastRescan();
    expect(again?.counts.relinked).toBe(1);
    expect(again?.relinked[0]?.toPath).toBe('imported/ch-moved.cbz');
    // Raw persistence check (app_settings kv).
    expect(h.store.getSetting(RESCAN_REPORT_KEY)).toBeDefined();

    // After the re-link, the title listing sees the moved file.
    const files = h.service.titleFiles({ moduleId: MODULE, url: URL, refresh: true });
    expect(files.files.find((f) => f.chapterLink === 'https://ex.org/manga/x/1')?.state).toBe('downloaded');
  });

  it('ambiguity: two same-name candidates stay an orphan+missing pair, never auto-linked', (): void => {
    const h = open();
    record(h, { file: 'mangam/ch-amb.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    rmSync(join(h.root, 'mangam/ch-amb.cbz'));
    mkdirSync(join(h.root, 'one'), { recursive: true });
    mkdirSync(join(h.root, 'two'), { recursive: true });
    writeFileSync(join(h.root, 'one/ch-amb.cbz'), Buffer.alloc(3, 1));
    writeFileSync(join(h.root, 'two/ch-amb.cbz'), Buffer.alloc(3, 1));
    const report = h.service.rescan();
    expect(report.counts.relinked).toBe(0);
    expect(report.counts.missing).toBe(1);
    expect([...(report.missing[0]?.candidates ?? [])].sort()).toEqual(['one/ch-amb.cbz', 'two/ch-amb.cbz']);
    expect(report.counts.orphans).toBe(2);
  });

  it('per-title variant scopes rows and orphans to the title', (): void => {
    const h = open();
    record(h, { file: 'mangam/ch-001.cbz', mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    record(h, { file: 'otherm/ch-002.cbz', mangaUrl: 'https://ex.org/manga/y', chapterLink: 'https://ex.org/manga/y/1' });
    mkdirSync(join(h.root, 'stray'), { recursive: true });
    writeFileSync(join(h.root, 'stray/global-orphan.cbz'), Buffer.alloc(2, 1));
    const report = h.service.rescan({ moduleId: MODULE, url: URL });
    expect(report.scope).toEqual({ kind: 'title', moduleId: MODULE, url: URL });
    // The other title's row is not reconciled here.
    expect(report.counts.present).toBe(1);
    expect(report.counts.missing).toBe(0);
    // The global stray is not this title's orphan.
    expect(report.counts.orphans).toBe(0);
  });
});

describe('listWithState — Library page enrichment', (): void => {
  it('default: rows carry verified state + display path; missing filter narrows to missing rows', (): void => {
    const h = open();
    const presentId = record(h, { file: 'mangam/ch-001.cbz', mangaUrl: URL, chapterLink: 'l1' });
    const missingId = record(h, { file: 'mangam/ch-002.cbz', mangaUrl: URL, chapterLink: 'l2' });
    rmSync(join(h.root, 'mangam/ch-002.cbz'));

    const all = h.service.listWithState({ limit: 50 });
    expect(all.files).toHaveLength(2);
    const byId = new Map(all.files.map((f) => [f.id, f]));
    expect(byId.get(String(presentId))?.state).toBe('downloaded');
    expect(byId.get(String(missingId))?.state).toBe('missing');
    expect(byId.get(String(presentId))?.path).toBe('mangam/ch-001.cbz');
    expect(byId.get(String(presentId))?.absolutePath).toBe(join(h.root, 'mangam/ch-001.cbz'));

    const missing = h.service.listWithState({ limit: 50, filter: 'missing' });
    expect(missing.files.map((f) => f.id)).toEqual([String(missingId)]);
  });

  it('orphans filter serves the last rescan persisted orphan list (empty before any rescan)', (): void => {
    const h = open();
    expect(h.service.listWithState({ limit: 50, filter: 'orphans' })).toEqual({ files: [], orphans: [] });
    mkdirSync(join(h.root, 'stray'), { recursive: true });
    writeFileSync(join(h.root, 'stray/orphan.cbz'), Buffer.alloc(9, 1));
    h.service.rescan();
    const orphans = h.service.listWithState({ limit: 50, filter: 'orphans' });
    expect(orphans.files).toEqual([]);
    expect(orphans.orphans?.[0]?.path).toBe('stray/orphan.cbz');
    expect(orphans.orphans?.[0]?.bytes).toBe(9);
  });
});
