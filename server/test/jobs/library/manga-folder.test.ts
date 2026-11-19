/**
 * [library-layout] resolveMangaFolder — the effective-folder seam over
 * the real store: first writer takes the clean name, a different module
 * suffixes, the computed value PERSISTS on the favorite row (the saveTo
 * additive-column seam) and is never recomputed, own ledger rows heal a
 * favorite that predates the column, and an unattributed on-disk folder
 * claims the clean name conservatively.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteLibraryStore } from '../../../src/jobs/library/store.js';
import { downloadedChaptersKey } from '../../../src/jobs/library/merge.js';

const MODULE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MODULE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const URL_A = 'https://ex.org/manga/naruto';
const URL_B = 'https://other.org/series/naruto';

let dir = '';

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function open(): { store: SqliteLibraryStore; root: string } {
  dir = join(tmpdir(), `fmd-folder-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const root = join(dir, 'library');
  mkdirSync(root, { recursive: true });
  const raw = new Database(join(dir, 'app.db'));
  return { store: new SqliteLibraryStore({ db: raw, libraryRoot: root }), root };
}

function favorite(store: SqliteLibraryStore, moduleId: string, url: string, title: string): string {
  const key = downloadedChaptersKey(moduleId, url);
  store.upsertFavorite({ mangaKey: key, moduleId, url, title });
  return key;
}

describe('resolveMangaFolder — rule 2 + the computed-once seam', (): void => {
  it('first download of a title resolves the CLEAN folder and persists it on the favorite', (): void => {
    const { store } = open();
    const key = favorite(store, MODULE_A, URL_A, 'Naruto');
    expect(
      store.resolveMangaFolder({ moduleId: MODULE_A, mangaUrl: URL_A, segment: 'Naruto' }),
    ).toBe('Naruto');
    expect(store.getFavorite(key)?.libraryFolder).toBe('Naruto');
  });

  it('a DIFFERENT module claiming the same title resolves the SUFFIXED folder', (): void => {
    const { store, root } = open();
    const keyA = favorite(store, MODULE_A, URL_A, 'Naruto');
    const keyB = favorite(store, MODULE_B, URL_B, 'Naruto');
    // Module A's first download: resolve → finalize → record (the lane
    // sequence — the recorded row is what claims the clean folder).
    expect(store.resolveMangaFolder({ moduleId: MODULE_A, mangaUrl: URL_A, segment: 'Naruto' })).toBe('Naruto');
    mkdirSync(join(root, 'Naruto'), { recursive: true });
    writeFileSync(join(root, 'Naruto', 'ch-001.cbz'), Buffer.alloc(8, 1));
    store.recordLibraryFile({
      moduleId: MODULE_A,
      manga: 'Naruto',
      fileName: 'ch-001.cbz',
      path: join(root, 'Naruto', 'ch-001.cbz'),
      bytes: 8,
      mangaUrl: URL_A,
      chapterLink: `${URL_A}/1`,
    });
    expect(store.resolveMangaFolder({ moduleId: MODULE_B, mangaUrl: URL_B, segment: 'Naruto' })).toBe(
      `Naruto [${MODULE_B}]`,
    );
    expect(store.getFavorite(keyA)?.libraryFolder).toBe('Naruto');
    expect(store.getFavorite(keyB)?.libraryFolder).toBe(`Naruto [${MODULE_B}]`);
  });

  it('NEVER RECOMPUTED: the persisted folder survives the other favorite going away entirely', (): void => {
    const { store, root } = open();
    const keyA = favorite(store, MODULE_A, URL_A, 'Naruto');
    const keyB = favorite(store, MODULE_B, URL_B, 'Naruto');
    // A's first download claims the clean folder (favorite + row)…
    store.resolveMangaFolder({ moduleId: MODULE_A, mangaUrl: URL_A, segment: 'Naruto' });
    mkdirSync(join(root, 'Naruto'), { recursive: true });
    writeFileSync(join(root, 'Naruto', 'ch-001.cbz'), Buffer.alloc(8, 1));
    store.recordLibraryFile({
      moduleId: MODULE_A,
      manga: 'Naruto',
      fileName: 'ch-001.cbz',
      path: join(root, 'Naruto', 'ch-001.cbz'),
      bytes: 8,
      mangaUrl: URL_A,
      chapterLink: `${URL_A}/1`,
    });
    // …B's first download suffixes (computed once, persisted on B).
    expect(store.resolveMangaFolder({ moduleId: MODULE_B, mangaUrl: URL_B, segment: 'Naruto' })).toBe(
      `Naruto [${MODULE_B}]`,
    );
    // The clean-name favorite AND its rows+files vanish (delete(+data)).
    store.deleteFavorite(keyA);
    store.deleteLibraryFileByPath(join(root, 'Naruto', 'ch-001.cbz'));
    rmSync(join(root, 'Naruto'), { recursive: true, force: true });
    // …and module B's persisted folder is untouched: no re-point, ever.
    expect(store.resolveMangaFolder({ moduleId: MODULE_B, mangaUrl: URL_B, segment: 'Naruto' })).toBe(
      `Naruto [${MODULE_B}]`,
    );
    expect(store.getFavorite(keyB)?.libraryFolder).toBe(`Naruto [${MODULE_B}]`);
  });

  it('the ledger claim works without any favorite (direct downloads): same module clean, other module suffix', (): void => {
    const { store, root } = open();
    // Module A's chapter already recorded on the flat layout.
    mkdirSync(join(root, 'Naruto'), { recursive: true });
    writeFileSync(join(root, 'Naruto', 'ch-001.cbz'), Buffer.alloc(8, 1));
    store.recordLibraryFile({
      moduleId: MODULE_A,
      manga: 'Naruto',
      fileName: 'ch-001.cbz',
      path: join(root, 'Naruto', 'ch-001.cbz'),
      bytes: 8,
      mangaUrl: URL_A,
      chapterLink: `${URL_A}/1`,
    });
    expect(store.resolveMangaFolder({ moduleId: MODULE_A, mangaUrl: URL_A, segment: 'Naruto' })).toBe('Naruto');
    // Same module, different url spelling (folder identity via disk/ledger) — clean.
    expect(store.resolveMangaFolder({ moduleId: MODULE_A, mangaUrl: `${URL_A}?lang=en`, segment: 'Naruto' })).toBe('Naruto');
    expect(store.resolveMangaFolder({ moduleId: MODULE_B, mangaUrl: URL_B, segment: 'Naruto' })).toBe(
      `Naruto [${MODULE_B}]`,
    );
  });

  it('own ledger rows HEAL a favorite that predates the column (migration-era favorites)', (): void => {
    const { store, root } = open();
    const key = favorite(store, MODULE_B, URL_B, 'Naruto');
    // Module B's rows already live under the suffixed folder (the
    // migration put them there); the favorite column is still NULL.
    const folder = `Naruto [${MODULE_B}]`;
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'ch-001.cbz'), Buffer.alloc(8, 1));
    store.recordLibraryFile({
      moduleId: MODULE_B,
      manga: folder,
      fileName: 'ch-001.cbz',
      path: join(root, folder, 'ch-001.cbz'),
      bytes: 8,
      mangaUrl: URL_B,
      chapterLink: `${URL_B}/1`,
    });
    expect(store.resolveMangaFolder({ moduleId: MODULE_B, mangaUrl: URL_B, segment: 'Naruto' })).toBe(folder);
    expect(store.getFavorite(key)?.libraryFolder).toBe(folder);
  });

  it('an unattributed on-disk folder (no ledger rows) claims the clean name conservatively', (): void => {
    const { store, root } = open();
    mkdirSync(join(root, 'Naruto'), { recursive: true });
    writeFileSync(join(root, 'Naruto', 'manual.cbz'), Buffer.alloc(2, 1));
    expect(store.resolveMangaFolder({ moduleId: MODULE_A, mangaUrl: URL_A, segment: 'Naruto' })).toBe(
      `Naruto [${MODULE_A}]`,
    );
  });

  it('saveTo-only favorites never gain a library folder through the seam (resolution is default-layout only)', (): void => {
    const { store } = open();
    const key = downloadedChaptersKey(MODULE_A, URL_A);
    store.upsertFavorite({ mangaKey: key, moduleId: MODULE_A, url: URL_A, title: 'Naruto', saveTo: 'custom' });
    // The lane never calls resolveMangaFolder for a saveTo download;
    // the column stays absent (nothing else writes it).
    expect(store.getFavorite(key)?.libraryFolder).toBeUndefined();
  });

  it('a favorite re-created after deletion recomputes from the surviving ledger truth', (): void => {
    const { store } = open();
    const keyA = favorite(store, MODULE_A, URL_A, 'Naruto');
    store.resolveMangaFolder({ moduleId: MODULE_A, mangaUrl: URL_A, segment: 'Naruto' });
    store.deleteFavorite(keyA);
    // Re-added favorite: module A's own claims are gone; the clean name
    // is unclaimed again → clean (nothing was re-pointed — no rows
    // existed to move).
    const again = favorite(store, MODULE_A, URL_A, 'Naruto');
    expect(store.resolveMangaFolder({ moduleId: MODULE_A, mangaUrl: URL_A, segment: 'Naruto' })).toBe('Naruto');
    expect(store.getFavorite(again)?.libraryFolder).toBe('Naruto');
  });

  it('distinctModuleIdsUnderPath returns the recorded claimants under exactly that folder', (): void => {
    const { store, root } = open();
    for (const [module, manga, file] of [
      [MODULE_A, 'Naruto', 'a.cbz'],
      [MODULE_A, 'Naruto', 'b.cbz'],
      [MODULE_B, 'Naruto Extras', 'c.cbz'],
    ] as const) {
      const abs = join(root, manga, file);
      mkdirSync(join(root, manga), { recursive: true });
      writeFileSync(abs, Buffer.alloc(4, 1));
      store.recordLibraryFile({ moduleId: module, manga, fileName: file, path: abs, bytes: 4 });
    }
    expect(store.distinctModuleIdsUnderPath(join(root, 'Naruto'))).toEqual([MODULE_A]);
    expect(store.distinctModuleIdsUnderPath(join(root, 'Naruto Extras'))).toEqual([MODULE_B]);
    expect(store.distinctModuleIdsUnderPath(join(root, 'Missing'))).toEqual([]);
  });
});
