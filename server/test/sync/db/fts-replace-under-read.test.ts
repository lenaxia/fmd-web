import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CatalogFileStore } from '../../../src/sync/db/catalog-store.js';
import { isoDateToJdn } from '../../../src/sync/db/jdn.js';
import { createCatalogDb, fixtureId, sha256, type FixtureRow } from './fixtures.js';

/**
 * FTS sidecar double-buffering (§6.5): the sidecar is keyed by the
 * catalog `db_sha`; replacement builds a COMPLETE sidecar at a temp
 * path and renames it over the active one. A reader that opened the
 * previous sidecar keeps its (old) inode and finishes with
 * deterministic results while the replacement lands underneath.
 */
const ID: string = fixtureId('fts-double-buffer');

const V1: readonly FixtureRow[] = [
  { link: '/m/alpha', title: 'Alpha Prime', summary: 'first generation content', jdn: isoDateToJdn('2025-01-01') },
  { link: '/m/beta', title: 'Beta Squad', summary: 'first generation content two', jdn: isoDateToJdn('2025-02-01') },
  { link: '/m/gamma', title: 'Gamma Ray', summary: 'first generation content three', jdn: isoDateToJdn('2025-03-01') },
];

const V2: readonly FixtureRow[] = [
  { link: '/m/delta', title: 'Delta Force', summary: 'second generation content', jdn: isoDateToJdn('2026-05-01') },
  { link: '/m/epsilon', title: 'Echo Base', summary: 'second generation content two', jdn: isoDateToJdn('2026-06-01') },
];

function install(dataDir: string, rows: readonly FixtureRow[]): string {
  const file: string = path.join(dataDir, 'catalogs', `${ID}.db`);
  createCatalogDb(file, rows);
  return sha256(file);
}

/** Run the same cursor walk on a raw sidecar handle (external reader). */
function walkSidecar(file: string, limit: number): string[] {
  const db: Database.Database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const out: string[] = [];
    let offset: number = 0;
    for (;;) {
      const rows: { link: string }[] = db
        .prepare(
          `SELECT e.link AS link FROM search_index s JOIN entry e ON e.rowid = s.rowid
           WHERE search_index MATCH ? ORDER BY rank, e.rowid LIMIT ? OFFSET ?`,
        )
        .all('content', limit, offset) as { link: string }[];
      if (rows.length === 0) {
        return out;
      }
      out.push(...rows.map((r) => r.link));
      offset += limit;
    }
  } finally {
    db.close();
  }
}

describe('FTS sidecar double-buffer (§6.5)', () => {
  let tmp: string;
  let store: CatalogFileStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync('/tmp/opencode/ftsbuf-');
    install(tmp, V1);
    store = new CatalogFileStore({ dataDir: tmp });
  });

  afterEach(() => {
    store.closeAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('replace-under-read: the reader on the old sidecar stays deterministic', () => {
    // 1) Build sidecar v1 and snapshot what an external reader sees.
    store.search(ID, { query: 'content' });
    const ftsFile: string = path.join(tmp, 'fts', `${ID}.db`);
    expect(store.sidecarSha(ID)).toBe(sha256(path.join(tmp, 'catalogs', `${ID}.db`)));
    const oldResults: string[] = walkSidecar(ftsFile, 2);
    expect(oldResults).toHaveLength(3);
    expect([...oldResults].sort()).toEqual(['/m/alpha', '/m/beta', '/m/gamma']);

    // 2) Replace the catalog under the pipeline (new db_sha). The
    //    reader's connection above is closed; open a PERSISTENT one
    //    that stays open across the whole replacement.
    const reader: Database.Database = new Database(ftsFile, { readonly: true, fileMustExist: true });
    try {
      const firstPage: { link: string }[] = reader
        .prepare(
          `SELECT e.link AS link FROM search_index s JOIN entry e ON e.rowid = s.rowid
           WHERE search_index MATCH ? ORDER BY rank, e.rowid LIMIT ? OFFSET ?`,
        )
        .all('content', 2, 0) as { link: string }[];
      expect(firstPage.map((r) => r.link)).toEqual(oldResults.slice(0, 2));

      install(tmp, V2);
      // Store notices the db_sha change and double-buffer-replaces the
      // sidecar (temp build + atomic rename) while `reader` holds the
      // previous buffer.
      const newPage = store.search(ID, { query: 'content' });
      expect(newPage.entries.map((e) => e.link).sort()).toEqual(['/m/delta', '/m/epsilon']);
      expect(store.sidecarSha(ID)).toBe(sha256(path.join(tmp, 'catalogs', `${ID}.db`)));

      // 3) The old-buffer reader FINISHES its walk mid-replacement era:
      //    its view is still exactly the v1 content — no partial mix.
      let offset: number = 0;
      const walked: string[] = [];
      for (;;) {
        const rows: { link: string }[] = reader
          .prepare(
            `SELECT e.link AS link FROM search_index s JOIN entry e ON e.rowid = s.rowid
             WHERE search_index MATCH ? ORDER BY rank, e.rowid LIMIT ? OFFSET ?`,
          )
          .all('content', 2, offset) as { link: string }[];
        if (rows.length === 0) {
          break;
        }
        walked.push(...rows.map((r) => r.link));
        offset += 2;
      }
      expect(walked).toEqual(oldResults);
    } finally {
      reader.close();
    }

    // 4) Post-replacement searches (fresh opens) see only v2.
    expect(store.search(ID, { query: 'generation second' }).total).toBe(2);
    expect(store.search(ID, { query: 'gamma' }).total).toBe(0);
    // The fts dir holds exactly the active sidecar — no build leftovers.
    expect(fs.readdirSync(path.join(tmp, 'fts')).filter((f) => f.endsWith('.db'))).toEqual([`${ID}.db`]);
  });

  it('same db_sha → sidecar reused, not rebuilt', () => {
    store.search(ID, { query: 'content' });
    const ftsFile: string = path.join(tmp, 'fts', `${ID}.db`);
    const inodeBefore: number = fs.statSync(ftsFile).ino;
    // A second search on the same catalog must NOT touch the file.
    store.search(ID, { query: 'content' });
    store.latest(ID);
    expect(fs.statSync(ftsFile).ino).toBe(inodeBefore);
  });

  it('db_sha change invalidates: tampered content rebuilds the sidecar', () => {
    store.search(ID, { query: 'content' });
    // Directly swap the catalog file (simulating an out-of-band install).
    install(tmp, V2);
    const page = store.search(ID, { query: 'content' });
    expect(page.total).toBe(2);
    expect(store.sidecarSha(ID)).toBe(sha256(path.join(tmp, 'catalogs', `${ID}.db`)));
  });

  it('missing sidecar file → built on demand', () => {
    expect(store.sidecarSha(ID)).toBe('');
    const page = store.search(ID, { query: 'alpha' });
    expect(page.entries.map((e) => e.title)).toEqual(['Alpha Prime']);
    expect(store.sidecarSha(ID)).not.toBe('');
  });
});
