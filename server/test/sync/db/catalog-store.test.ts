import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildMatchQuery,
  CatalogFileStore,
  fileSha256,
  isValidCatalogId,
} from '../../../src/sync/db/catalog-store.js';
import { isoDateToJdn } from '../../../src/sync/db/jdn.js';
import { createCatalogDb, fixtureId, type FixtureRow } from './fixtures.js';

/**
 * Read side (§6.4–§6.6). The read-only invariant is the acceptance
 * centerpiece: catalog files are rollback-journal SQLite that must
 * NEVER gain a `-journal`/`-wal`/`-shm` sidecar or change a single byte
 * — no matter how heavy the read workload (browsing + FTS search over
 * fresh sidecars included).
 */

const ID: string = fixtureId('read-side-alpha');

const ROWS: readonly FixtureRow[] = [
  { link: '/m/one-piece', title: 'One Piece', genres: 'action,adventure,fantasy', status: 'Ongoing', summary: 'straw hat pirates voyage', numchapter: 1100, jdn: isoDateToJdn('2026-01-05') },
  { link: '/m/naruto', title: 'Naruto', genres: 'action,adventure', status: 'Completed', summary: 'ninja ninja scroll', numchapter: 700, jdn: isoDateToJdn('2025-06-01') },
  { link: '/m/bleach', title: 'Bleach', genres: 'action,supernatural', status: 'Completed', summary: 'soul reaper sword', numchapter: 686, jdn: isoDateToJdn('2026-03-10') },
  { link: '/m/berserk', title: 'Berserk', genres: 'action,dark fantasy', status: 'Ongoing', summary: 'black swordsman rage', numchapter: 364, jdn: isoDateToJdn('2026-03-10') },
  { link: '/m/doraemon', title: 'Doraemon', genres: 'comedy,children', status: 'Completed', summary: 'robot cat future gadgets', numchapter: 1345, jdn: isoDateToJdn('1999-12-31') },
];

/** Exactly the files a rollback-journal workload may leave behind. */
function sidecarFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('-journal') || f.endsWith('-wal') || f.endsWith('-shm'));
}

describe('catalog store: read-only invariant (§6.4)', () => {
  let tmp: string;
  let store: CatalogFileStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync('/tmp/opencode/store-');
    createCatalogDb(path.join(tmp, 'catalogs', `${ID}.db`), ROWS);
    store = new CatalogFileStore({ dataDir: tmp });
  });

  afterEach(() => {
    store.closeAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a heavy search workload leaves ZERO sqlite sidecars and the file byte-identical', async () => {
    const catalogsDir: string = path.join(tmp, 'catalogs');
    const shaBefore: string = fileSha256(path.join(catalogsDir, `${ID}.db`));

    // Workload: browsing + FTS searches (fresh sidecar build + pages).
    for (let page = 1; page <= 3; page += 1) {
      store.latest(ID, { page, limit: 2 });
      store.byTitle(ID, { page, limit: 2 });
    }
    for (const q of ['one', 'action', 'ninja', 'ble*', 'swordsman']) {
      store.search(ID, { query: q });
    }
    store.closeAll();
    // Re-open after close to prove fresh connections behave identically.
    const store2: CatalogFileStore = new CatalogFileStore({ dataDir: tmp });
    store2.search(ID, { query: 'pirate OR ninja' });
    store2.latest(ID, {});
    store2.closeAll();

    expect(sidecarFiles(catalogsDir)).toEqual([]);
    expect(fs.readdirSync(catalogsDir).sort()).toEqual([`${ID}.db`].sort());
    expect(fileSha256(path.join(catalogsDir, `${ID}.db`))).toBe(shaBefore);
  });

  it('read connections refuse writes (SQLITE_OPEN_READONLY)', () => {
    const db: Database.Database = new Database(path.join(tmp, 'catalogs', `${ID}.db`), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(() => db.prepare('INSERT INTO masterlist VALUES (?,?,?,?,?,?,?,?,?,?)').run('x', '', '', '', '', '', '', '', 0, 0)).toThrow(
        /readonly/,
      );
    } finally {
      db.close();
    }
  });

  it('read-only open of a missing catalog fails instead of creating it', () => {
    const ghost: string = fixtureId('never-installed');
    expect(() => store.latest(ghost)).toThrow();
    expect(fs.existsSync(path.join(tmp, 'catalogs', `${ghost}.db`))).toBe(false);
  });

  it('getMeta self-heals: receipt missing → sha derived from the file', () => {
    const meta = store.getMeta(ID);
    expect(meta).toBeDefined();
    expect(meta?.dbSha).toBe(fileSha256(path.join(tmp, 'catalogs', `${ID}.db`)));
    expect(meta?.bytes).toBe(fs.statSync(path.join(tmp, 'catalogs', `${ID}.db`)).size);

    // With a receipt: recorded values win.
    store.writeInstallReceipt(ID, 'beef'.repeat(16), '2026-11-13T00:00:00.000Z');
    const meta2 = store.getMeta(ID);
    expect(meta2?.dbSha).toBe('beef'.repeat(16));
    expect(meta2?.fetchedAt).toBe('2026-11-13T00:00:00.000Z');
    expect(meta2?.bytes).toBe(fs.statSync(path.join(tmp, 'catalogs', `${ID}.db`)).size);

    expect(store.getMeta(fixtureId('absent'))).toBeUndefined();
  });

  it('rejects ids that are not 32-hex (path safety)', () => {
    expect(isValidCatalogId(ID)).toBe(true);
    expect(isValidCatalogId('../evil')).toBe(false);
    expect(isValidCatalogId('short')).toBe(false);
    expect(() => store.latest('../evil')).toThrow(/invalid catalog id/);
  });
});

describe('catalog store: browsing (§6.6)', () => {
  let tmp: string;
  let store: CatalogFileStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync('/tmp/opencode/browse-');
    createCatalogDb(path.join(tmp, 'catalogs', `${ID}.db`), ROWS);
    store = new CatalogFileStore({ dataDir: tmp });
  });

  afterEach(() => {
    store.closeAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('latest orders by jdn DESC with deterministic tiebreaks', () => {
    const page = store.latest(ID, {});
    expect(page.entries.map((e) => e.title)).toEqual([
      'Berserk', // 2026-03-10, title tiebreak: 'Berserk' < 'Bleach' (NOCASE)
      'Bleach', // 2026-03-10
      'One Piece', // 2026-01-05
      'Naruto', // 2025-06-01
      'Doraemon', // 1999-12-31
    ]);
    expect(page.total).toBe(5);
    expect(page.entries[0]?.jdn).toBe(isoDateToJdn('2026-03-10'));
    expect(page.entries[4]?.jdn).toBe(isoDateToJdn('1999-12-31'));
  });

  it('latest paginates by page and offset cursors deterministically', () => {
    const p1 = store.latest(ID, { page: 1, limit: 2 });
    expect(p1.entries.map((e) => e.title)).toEqual(['Berserk', 'Bleach']);
    expect(p1.nextCursor).toBeDefined();
    const cursor = p1.nextCursor as string;
    const offset: number = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: number }).o;
    const p2 = store.latest(ID, { limit: 2, page: offset / 2 + 1 });
    // Direct page arithmetic lands on the same window the cursor encoded.
    expect(p2.entries.map((e) => e.title)).toEqual(['One Piece', 'Naruto']);
    const last = store.latest(ID, { page: 3, limit: 2 });
    expect(last.entries.map((e) => e.title)).toEqual(['Doraemon']);
    expect(last.nextCursor).toBeUndefined();
    // Beyond the end: empty, still total-carrying.
    const over = store.latest(ID, { page: 4, limit: 2 });
    expect(over.entries).toEqual([]);
    expect(over.total).toBe(5);
  });

  it('byTitle orders NOCASE ASC with link tiebreak', () => {
    const page = store.byTitle(ID, {});
    expect(page.entries.map((e) => e.title)).toEqual([
      'Berserk',
      'Bleach',
      'Doraemon',
      'Naruto',
      'One Piece',
    ]);
  });

  it('clamps limit to the page maximum and floors page 0/negatives', () => {
    const page = store.latest(ID, { page: 1, limit: 3 });
    expect(page.entries).toHaveLength(3);
    // limit floored to ≥1, page floored to ≥1.
    const zero = store.latest(ID, { page: 0, limit: 0 });
    expect(zero.entries).toHaveLength(1);
    expect(zero.entries[0]?.title).toBe('Berserk');
  });
});

describe('catalog store: FTS search + cursor pagination (§6.6)', () => {
  let tmp: string;
  let store: CatalogFileStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync('/tmp/opencode/fts-');
    createCatalogDb(path.join(tmp, 'catalogs', `${ID}.db`), ROWS);
    store = new CatalogFileStore({ dataDir: tmp });
  });

  afterEach(() => {
    store.closeAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('matches titles and summaries, ordered by rank then rowid', () => {
    const page = store.search(ID, { query: 'action' });
    expect(page.total).toBe(4); // one piece, naruto, bleach, berserk
    const links: string[] = page.entries.map((e) => e.link).sort();
    expect(links).toEqual(['/m/berserk', '/m/bleach', '/m/naruto', '/m/one-piece']);
  });

  it('AND-combines tokens; prefix queries via trailing *', () => {
    expect(store.search(ID, { query: 'straw voyage' }).entries.map((e) => e.title)).toEqual(['One Piece']);
    expect(store.search(ID, { query: 'straw ninja' }).entries).toEqual([]);
    const prefix = store.search(ID, { query: 'ble*' });
    expect(prefix.entries.map((e) => e.title)).toEqual(['Bleach']);
  });

  it('cursor pagination walks the full result set deterministically', () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages: number = 0;
    do {
      const page = store.search(
        ID,
        cursor === undefined ? { query: 'action', limit: 2 } : { query: 'action', limit: 2, cursor },
      );
      collected.push(...page.entries.map((e) => e.link));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(2);
    expect(collected).toHaveLength(4);
    expect([...collected].sort()).toEqual(['/m/berserk', '/m/bleach', '/m/naruto', '/m/one-piece']);
    // Determinism: the same walk again yields the same order.
    const again: string[] = [];
    let c2: string | undefined;
    do {
      const page = store.search(
        ID,
        c2 === undefined ? { query: 'action', limit: 2 } : { query: 'action', limit: 2, cursor: c2 },
      );
      again.push(...page.entries.map((e) => e.link));
      c2 = page.nextCursor;
    } while (c2 !== undefined);
    expect(again).toEqual(collected);
  });

  it('rejects a cursor issued for a different query (no silent re-paging)', () => {
    const page = store.search(ID, { query: 'action', limit: 2 });
    const cursor: string = page.nextCursor as string;
    expect(() => store.search(ID, { query: 'ninja', cursor })).toThrow(/cursor does not match/);
  });

  it('filters by exact status and genre column', () => {
    const ongoing = store.search(ID, { query: 'action', status: 'Ongoing' });
    expect(ongoing.entries.map((e) => e.title).sort()).toEqual(['Berserk', 'One Piece']);
    const fantasy = store.search(ID, { query: 'action', genre: 'fantasy' });
    // 'fantasy' matches both One Piece ('action,adventure,fantasy') and
    // Berserk ('action,dark fantasy') as an FTS column term.
    expect(fantasy.entries.map((e) => e.title).sort()).toEqual(['Berserk', 'One Piece']);
    const none = store.search(ID, { query: 'action', status: 'Hiatus' });
    expect(none.entries).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('throws on an empty query (API layer validates first)', () => {
    expect(() => store.search(ID, { query: '   ' })).toThrow(/empty search query/);
    expect(() => buildMatchQuery('')).toThrow(/empty/);
  });

  it('sanitizes the raw user query into quoted phrases', () => {
    expect(buildMatchQuery('one piece')).toBe('"one" AND "piece"');
    expect(buildMatchQuery('ble*')).toBe('"ble"*');
    expect(buildMatchQuery('say "hi"')).toBe('"say" AND """hi"""');
  });
});
