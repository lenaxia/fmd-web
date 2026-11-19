/**
 * [file-state] API integration over the REAL sqlite services + a temp
 * library root: the title-files/rescan routes (mounted only with the
 * seam), library filter enrichment, the metadata-only guarantee, and
 * the download-route realpath clamp (symlink escape → typed 403).
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteLibraryStore } from '../../src/jobs/library/store.js';
import { SqliteLibraryService } from '../../src/runtime/library-service.js';
import { SqliteLibraryFileStateService } from '../../src/runtime/library-file-state.js';
import { linesToText } from '../../src/jobs/library/merge.js';
import { buildHarness, expectEnvelope, MODULE_A_ID, type Harness } from './helpers.js';

const URL = 'https://ex.org/manga/x';

let dir = '';

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

interface RealHarness {
  readonly h: Harness;
  readonly store: SqliteLibraryStore;
  readonly root: string;
}

function openReal(): RealHarness {
  dir = join(tmpdir(), `fmd-filestate-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const root = join(dir, 'library');
  mkdirSync(root, { recursive: true });
  const raw = new Database(join(dir, 'app.db'));
  const store = new SqliteLibraryStore({ db: raw, libraryRoot: root });
  const h = buildHarness({
    library: new SqliteLibraryService(store, root),
    fileState: new SqliteLibraryFileStateService({ store, root }),
  });
  return { h, store, root };
}

function seed(r: RealHarness, rel: string, opts?: { mangaUrl?: string; chapterLink?: string }): number {
  const abs = join(r.root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, Buffer.alloc(12, 3));
  const segments = rel.split('/');
  const row = r.store.recordLibraryFile({
    moduleId: MODULE_A_ID,
    manga: segments[1] ?? 'mangam',
    fileName: segments[segments.length - 1] ?? 'ch.cbz',
    path: abs,
    bytes: 12,
    ...(opts?.mangaUrl !== undefined ? { mangaUrl: opts.mangaUrl } : {}),
    ...(opts?.chapterLink !== undefined ? { chapterLink: opts.chapterLink } : {}),
  });
  return Number(row.id);
}

describe('GET /api/library/title-files', (): void => {
  it('serves the per-title Files shape: verified states, display paths, orphans — metadata only', async (): Promise<void> => {
    const r = openReal();
    r.store.setDownloadedChapters(MODULE_A_ID, URL, linesToText(['https://ex.org/manga/x/1']));
    seed(r, `${MODULE_A_ID}/mangam/ch-001.cbz`, { mangaUrl: URL, chapterLink: 'https://ex.org/manga/x/1' });
    const res = await r.h.app.inject({ method: 'GET', url: `/api/library/title-files?moduleId=${MODULE_A_ID}&url=${encodeURIComponent(URL)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      files: Array<{ state: string; path?: string; bytes?: number; mtime?: string; verifiedAt?: string }>;
      orphans: unknown[];
      verifiedAt: string;
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.state).toBe('downloaded');
    expect(body.files[0]?.path).toBe(`${MODULE_A_ID}/mangam/ch-001.cbz`);
    expect(body.files[0]?.bytes).toBe(12);
    expect(body.files[0]?.mtime).toBeDefined();
    expect(body.files[0]?.verifiedAt).toBeDefined();
    expect(body.verifiedAt).toBeDefined();
    // METADATA ONLY: the payload carries no content/download field —
    // the only byte-serving route stays /api/library/:id/file.
    expect(Object.keys(body.files[0] ?? {}).sort()).not.toContain('content');
  });

  it('404s when the seam is not mounted (default harness keeps the pre-shape)', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/library/title-files?moduleId=${MODULE_A_ID}&url=${encodeURIComponent(URL)}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST/GET /api/library/rescan', (): void => {
  it('moved + deleted + orphan seed: re-link, missing, orphans; the report persists and re-serves', async (): Promise<void> => {
    const r = openReal();
    const moved = seed(r, `${MODULE_A_ID}/mangam/ch-moved.cbz`);
    seed(r, `${MODULE_A_ID}/mangam/ch-deleted.cbz`);
    rmSync(join(r.root, MODULE_A_ID, 'mangam', 'ch-deleted.cbz'));
    mkdirSync(join(r.root, 'imported'), { recursive: true });
    rmSync(join(r.root, MODULE_A_ID, 'mangam', 'ch-moved.cbz'));
    writeFileSync(join(r.root, 'imported', 'ch-moved.cbz'), Buffer.alloc(12, 3));
    mkdirSync(join(r.root, 'stray'), { recursive: true });
    writeFileSync(join(r.root, 'stray', 'orphan.cbz'), Buffer.alloc(4, 1));

    const post = await r.h.app.inject({ method: 'POST', url: '/api/library/rescan' });
    expect(post.statusCode).toBe(200);
    const { report } = post.json() as {
      report: {
        counts: Record<string, number>;
        relinked: Array<{ id: string; fromPath: string; toPath: string }>;
        missing: Array<{ id: string; path: string }>;
        orphans: Array<{ path: string }>;
        scope: string;
      };
    };
    expect(report.scope).toBe('library');
    expect(report.counts.relinked).toBe(1);
    expect(report.relinked[0]?.id).toBe(String(moved));
    expect(report.relinked[0]?.toPath).toBe('imported/ch-moved.cbz');
    expect(report.missing[0]?.path).toBe(`${MODULE_A_ID}/mangam/ch-deleted.cbz`);
    expect(report.orphans.map((o) => o.path)).toEqual(['stray/orphan.cbz']);

    const last = await r.h.app.inject({ method: 'GET', url: '/api/library/rescan' });
    expect(last.statusCode).toBe(200);
    const lastBody = last.json() as { report: { counts: Record<string, number> } | null };
    expect(lastBody.report?.counts?.relinked).toBe(1);

    // 404 route not mounted without the seam
    const h = buildHarness();
    expect((await h.app.inject({ method: 'POST', url: '/api/library/rescan' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/library/rescan' })).statusCode).toBe(404);
  });
});

describe('GET /api/library filters + state enrichment', (): void => {
  it('rows carry verified state; filter=missing narrows; filter=orphans serves the persisted report', async (): Promise<void> => {
    const r = openReal();
    seed(r, `${MODULE_A_ID}/mangam/ch-001.cbz`, { mangaUrl: URL, chapterLink: 'l1' });
    seed(r, `${MODULE_A_ID}/mangam/ch-002.cbz`, { mangaUrl: URL, chapterLink: 'l2' });
    rmSync(join(r.root, MODULE_A_ID, 'mangam', 'ch-002.cbz'));

    const all = await r.h.app.inject({ method: 'GET', url: '/api/library?limit=50' });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as { files: Array<{ state?: string; verifiedAt?: string | null; path?: string; fileName?: string }> };
    expect(allBody.files).toHaveLength(2);
    const states = new Map(allBody.files.map((f) => [f.fileName ?? '', f.state]));
    expect(states.get('ch-001.cbz')).toBe('downloaded');
    expect(states.get('ch-002.cbz')).toBe('missing');
    expect(allBody.files.every((f) => typeof f.verifiedAt === 'string')).toBe(true);

    const missing = await r.h.app.inject({ method: 'GET', url: '/api/library?filter=missing' });
    const missingBody = missing.json() as { files: Array<{ fileName?: string; state?: string }> };
    expect(missingBody.files.map((f) => f.fileName)).toEqual(['ch-002.cbz']);

    const orphansEmpty = await r.h.app.inject({ method: 'GET', url: '/api/library?filter=orphans' });
    expect((orphansEmpty.json() as { orphans: unknown[] }).orphans).toEqual([]);

    mkdirSync(join(r.root, 'stray'), { recursive: true });
    writeFileSync(join(r.root, 'stray', 'orphan.cbz'), Buffer.alloc(7, 1));
    await r.h.app.inject({ method: 'POST', url: '/api/library/rescan' });
    const orphans = await r.h.app.inject({ method: 'GET', url: '/api/library?filter=orphans' });
    const orphansBody = orphans.json() as { files: unknown[]; orphans: Array<{ path: string; bytes: number }> };
    expect(orphansBody.files).toEqual([]);
    expect(orphansBody.orphans[0]?.path).toBe('stray/orphan.cbz');
    expect(orphansBody.orphans[0]?.bytes).toBe(7);
  });

  it('filter= without the file-state seam is a typed 400, never silently ignored', async (): Promise<void> => {
    const h = buildHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/library?filter=missing' });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.json(), 'bad_request');
  });
});

describe('GET /api/library/:id/file — realpath clamp', (): void => {
  it('a recorded path escaping the root via symlink is a typed 403, never streamed', async (): Promise<void> => {
    const r = openReal();
    // An OUTSIDE file + an in-root row whose path is a symlink to it.
    const outsideDir = join(dir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'secret.cbz');
    writeFileSync(outsideFile, Buffer.alloc(6, 9));
    const linkPath = join(r.root, MODULE_A_ID, 'mangam', 'linked.cbz');
    mkdirSync(join(r.root, MODULE_A_ID, 'mangam'), { recursive: true });
    symlinkSync(outsideFile, linkPath);
    const row = r.store.recordLibraryFile({
      moduleId: MODULE_A_ID,
      manga: 'mangam',
      fileName: 'linked.cbz',
      path: linkPath,
      bytes: 6,
    });
    const res = await r.h.app.inject({ method: 'GET', url: `/api/library/${String(row.id)}/file` });
    expect(res.statusCode).toBe(403);
    expectEnvelope(res.json(), 'path_outside_library_root');
    expect(res.body).not.toContain('secret');
  });

  it('an in-root symlinked file still streams (the clamp admits in-root targets)', async (): Promise<void> => {
    const r = openReal();
    const target = join(r.root, MODULE_A_ID, 'mangam', 'real.cbz');
    mkdirSync(join(r.root, MODULE_A_ID, 'mangam'), { recursive: true });
    writeFileSync(target, Buffer.alloc(6, 9));
    const linkPath = join(r.root, MODULE_A_ID, 'mangam', 'alias.cbz');
    symlinkSync(target, linkPath);
    const row = r.store.recordLibraryFile({
      moduleId: MODULE_A_ID,
      manga: 'mangam',
      fileName: 'alias.cbz',
      path: linkPath,
      bytes: 6,
    });
    const res = await r.h.app.inject({ method: 'GET', url: `/api/library/${String(row.id)}/file` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(6);
  });
});
