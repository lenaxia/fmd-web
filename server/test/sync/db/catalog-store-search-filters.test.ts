/**
 * Real-SQL semantics of the FMD2 Filter-panel row filters (additive
 * search params): genres ANY→OR of LIKE / ALL→AND of LIKE, authors
 * LIKE-contains, newDays jdn window, LIKE-wildcard escaping, and
 * filter-only (no q) pages — composed by the REAL CatalogFileStore
 * over a REAL SQLite catalog file (fixtures create the db exactly like
 * FMD2-DB's pipeline). The route-level composition tests live in
 * server/test/api/catalog-search-filters.test.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogFileStore,
  escapeLikeValue,
  jdnToday,
} from '../../../src/sync/db/catalog-store.js';
import { createCatalogDb, fixtureId, type FixtureRow } from './fixtures.js';

const ID: string = fixtureId('search-filters');

const TODAY: number = jdnToday();

const ROWS: readonly FixtureRow[] = [
  { link: '/m/action-comedy', title: 'Action Comedy', authors: 'Alice Akagi', artists: 'Rin Sawayama', genres: 'Action, Comedy', status: 'Ongoing', summary: 'filter story one: two swords', numchapter: 1, jdn: TODAY - 100 },
  { link: '/m/action-only', title: 'Action Only', authors: 'Bob Bufo', artists: 'Chihaya Arata', genres: 'Action', status: 'Ongoing', summary: 'filter story two', numchapter: 2, jdn: TODAY - 3 },
  { link: '/m/comedy-drama', title: 'Comedy Drama', authors: 'Alice Kawabe', artists: 'Rin Sawayama', genres: 'Comedy, Drama', status: 'Completed', summary: 'filter story three: the swords return', numchapter: 3, jdn: TODAY - 2 },
  // 'Malice' contains 'alice' — LIKE-contains is case-insensitive.
  { link: '/m/drama-malice', title: 'Drama Malice', authors: 'Malice', artists: 'Artorias', genres: 'Action, Drama', status: 'Hiatus', summary: 'filter story four', numchapter: 4, jdn: TODAY },
  { link: '/m/wild', title: 'Wild Card', authors: 'Cara _% type', artists: 'Fifty_% Art', genres: '50% off', status: 'Ongoing', summary: 'filter story five', numchapter: 5, jdn: TODAY - 400 },
];

describe('catalog store search: FMD2 filter row filters (real SQL)', () => {
  let tmp: string;
  let store: CatalogFileStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync('/tmp/opencode/filter-');
    createCatalogDb(path.join(tmp, 'catalogs', `${ID}.db`), ROWS);
    store = new CatalogFileStore({ dataDir: tmp });
  });

  afterEach(() => {
    store.closeAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const titlesOf = (page: { entries: ReadonlyArray<{ title: string }> }): string[] =>
    page.entries.map((e) => e.title);

  it('genres ANY: OR of LIKE clauses (rbAny)', () => {
    const page = store.search(ID, {
      query: 'filter',
      genres: ['Action', 'Comedy'],
      genresMode: 'any',
      limit: 50,
    });
    // q-present pages are FTS rank-ordered — assert the SET, not the order.
    expect([...titlesOf(page)].sort()).toEqual(['Action Comedy', 'Action Only', 'Comedy Drama', 'Drama Malice']);
    expect(page.total).toBe(4);
  });

  it('genres ALL: AND of LIKE clauses (rbAll, the FMD2 default)', () => {
    const page = store.search(ID, { query: 'filter', genres: ['Action', 'Drama'], limit: 50 });
    expect(titlesOf(page)).toEqual(['Drama Malice']);
    // Composing a third genre narrows further (Action+Drama+Comedy → none).
    expect(store.search(ID, { query: 'filter', genres: ['Action', 'Drama', 'Comedy'], limit: 50 }).total).toBe(0);
  });

  it('genre LIKE matching is case-insensitive and substring-based', () => {
    const page = store.search(ID, { query: 'filter', genres: ['action'], genresMode: 'any', limit: 50 });
    // q-present pages are FTS rank-ordered — assert the SET, not the order.
    expect([...titlesOf(page)].sort()).toEqual(['Action Comedy', 'Action Only', 'Drama Malice']);
  });

  it('authors: LIKE-contains across the authors column, case-insensitive', () => {
    const page = store.search(ID, { query: 'filter', authors: 'alice', limit: 50 });
    // q-present pages are FTS rank-ordered — assert the SET, not the order.
    expect([...titlesOf(page)].sort()).toEqual(['Action Comedy', 'Comedy Drama', 'Drama Malice']);
  });

  it('mixed composition: q (FTS) + status + genres(ALL) + authors', () => {
    const page = store.search(ID, {
      query: 'story',
      status: 'Ongoing',
      genres: ['Action'],
      genresMode: 'all',
      authors: 'alice',
      limit: 50,
    });
    expect(titlesOf(page)).toEqual(['Action Comedy']);
  });

  it('newDays: strict jdn > JDN(today) - newDays boundary (FMD2 DBDataProcess:1382)', () => {
    // TODAY-100..TODAY rows: newDays=7 keeps jdn > TODAY-7 → the -3, -2, TODAY rows.
    // (q-present pages are rank-ordered — assert the SET, not the order.)
    const week = store.search(ID, { query: 'filter', newDays: 7, limit: 50 });
    expect([...titlesOf(week)].sort()).toEqual(['Action Only', 'Comedy Drama', 'Drama Malice']);
    // newDays=3 → jdn > TODAY-3 keeps -2 and TODAY (the -3 row sits ON the boundary → excluded).
    const three = store.search(ID, { query: 'filter', newDays: 3, limit: 50 });
    expect([...titlesOf(three)].sort()).toEqual(['Comedy Drama', 'Drama Malice']);
  });

  it('filter-only (no q): filtered entry table ordered jdn DESC (latest parity)', () => {
    const page = store.search(ID, { genres: ['Action'], genresMode: 'any', limit: 50 });
    expect(titlesOf(page)).toEqual(['Drama Malice', 'Action Only', 'Action Comedy']);
  });

  it('LIKE wildcards in filter values are ESCAPED (literal %/_)', () => {
    // A genre of '50% off' matches ONLY the literal row, never everything.
    const literal = store.search(ID, { genres: ['50% off'], genresMode: 'any', limit: 50 });
    expect(titlesOf(literal)).toEqual(['Wild Card']);
    // DECISIVE % escape: a bare '%' must match ONLY the literal-% row
    // (unescaped it would match EVERY row — 5, not 1).
    expect(store.search(ID, { genres: ['%'], genresMode: 'any', limit: 50 }).total).toBe(1);
    // DECISIVE _ escape: '5_%' must match NOTHING (no literal '5_%'
    // substring exists; unescaped '5'+any-char+'*' would match '50% off').
    expect(store.search(ID, { genres: ['5_%'], genresMode: 'any', limit: 50 }).total).toBe(0);
    // DECISIVE authors % probe: a bare '%' contains-matches only the
    // authors value carrying a literal '%'.
    expect(store.search(ID, { authors: '%' }).total).toBe(1);
    // The literal wildcard-carrying value round-trips as a contains match.
    expect(store.search(ID, { authors: 'Cara _% type', limit: 50 }).total).toBe(1);
    expect(escapeLikeValue('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('cursor binds the full filter state: reuse under a changed filter throws', () => {
    const first = store.search(ID, { query: 'filter', genres: ['Action'], genresMode: 'any', limit: 2 });
    expect(first.nextCursor).toBeDefined();
    const cursor = first.nextCursor as string;
    // Same filters walk.
    expect(() => store.search(ID, { query: 'filter', genres: ['Action'], genresMode: 'any', limit: 2, cursor })).not.toThrow();
    // Mode flip, set change, added authors, added newDays — all rejected.
    expect(() => store.search(ID, { query: 'filter', genres: ['Action'], genresMode: 'all', limit: 2, cursor })).toThrow(/cursor/);
    expect(() => store.search(ID, { query: 'filter', genres: ['Comedy'], genresMode: 'any', limit: 2, cursor })).toThrow(/cursor/);
    expect(() => store.search(ID, { query: 'filter', genres: ['Action'], genresMode: 'any', authors: 'alice', limit: 2, cursor })).toThrow(/cursor/);
    expect(() => store.search(ID, { query: 'filter', genres: ['Action'], genresMode: 'any', newDays: 5, limit: 2, cursor })).toThrow(/cursor/);
  });

  it('legacy single-genre FTS phrase filter still composes with the new row filters', () => {
    const page = store.search(ID, { query: 'filter', genre: 'drama', genres: ['Comedy'], genresMode: 'any', limit: 50 });
    // FTS genre 'drama' (token) ∩ row LIKE 'Comedy' → Comedy Drama.
    expect(titlesOf(page)).toEqual(['Comedy Drama']);
  });
});

describe('catalog store search: genre excludes (!/- custom genres, audit (b)2) — real SQL composition matrix', () => {
  let tmp: string;
  let store: CatalogFileStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync('/tmp/opencode/filter-excl-');
    createCatalogDb(path.join(tmp, 'catalogs', `${ID}.db`), ROWS);
    store = new CatalogFileStore({ dataDir: tmp });
  });

  afterEach(() => {
    store.closeAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const titlesOf = (page: { entries: ReadonlyArray<{ title: string }> }): string[] =>
    page.entries.map((e) => e.title);

  // The documented composition matrix (composeRowFilters doc):
  //   includes join by genresMode; excludes AND among themselves and
  //   AND onto the include block; exclude wins on collision.

  it('exclude-only [X]: NOT LIKE X with no include clause (filter-only page)', () => {
    // No row carries Ecchi → nothing excluded.
    expect(store.search(ID, { genresExclude: ['Ecchi'], limit: 50 }).total).toBe(5);
    // Comedy excludes the two Comedy rows (contains semantics);
    // filter-only pages order jdn DESC (Wild Card is the oldest row).
    const page = store.search(ID, { genresExclude: ['Comedy'], limit: 50 });
    expect(titlesOf(page)).toEqual(['Drama Malice', 'Action Only', 'Wild Card']);
  });

  it('includes ANY [A,B] + exclude [C]: (A OR B) AND NOT C', () => {
    const page = store.search(ID, {
      genres: ['Action', 'Comedy'],
      genresMode: 'any',
      genresExclude: ['Drama'],
      limit: 50,
    });
    // Action/Comedy rows: Action Comedy, Action Only, Comedy Drama, Drama
    // Malice; NOT Drama drops Comedy Drama + Drama Malice (jdn DESC).
    expect(titlesOf(page)).toEqual(['Action Only', 'Action Comedy']);
  });

  it('includes ALL [A,B] + excludes [C,D]: (A AND B) AND NOT C AND NOT D', () => {
    const page = store.search(ID, {
      genres: ['Action', 'Drama'],
      genresMode: 'all',
      genresExclude: ['Comedy', 'Ecchi'],
      limit: 50,
    });
    // Action AND Drama → Drama Malice only; neither exclude touches it.
    expect(titlesOf(page)).toEqual(['Drama Malice']);
    expect(page.total).toBe(1);
  });

  it('excludes AND among themselves: [C,D] drops rows containing EITHER', () => {
    const page = store.search(ID, { genresExclude: ['Comedy', 'Drama'], limit: 50 });
    expect(titlesOf(page)).toEqual(['Action Only', 'Wild Card']);
  });

  it('REGRESSION (audit (b)2): collision X in both lists → exclude WINS (X drops from includes)', () => {
    // The V1 inverted parser fed `!X` into the INCLUDE list (inverted
    // semantics). Correct semantics: X is dropped from the includes —
    // the query is the NOT-LIKE exclude alone, never an X-including
    // row (no row containing Comedy may match).
    const page = store.search(ID, {
      genres: ['Comedy'],
      genresMode: 'any',
      genresExclude: ['Comedy'],
      limit: 50,
    });
    expect(page.total).toBe(3);
    expect(titlesOf(page)).toEqual(['Drama Malice', 'Action Only', 'Wild Card']);
    // DECISIVE inverted-include regression: with the OLD parser the
    // exclude landed in the INCLUDE list — matching ONLY Comedy rows.
    expect(page.entries.some((e): boolean => e.genres.includes('Comedy'))).toBe(false);
  });

  it('NOT LIKE is contains-based (a substring genre exclude drops token matches)', () => {
    // 'med' contains-matches 'Comedy' — FMD2 LIKE semantics, not tokens.
    const page = store.search(ID, { genresExclude: ['med'], limit: 50 });
    expect(titlesOf(page)).toEqual(['Drama Malice', 'Action Only', 'Wild Card']);
  });

  it('LIKE wildcards in excludes are ESCAPED (a bare % excludes ONLY the literal row)', () => {
    const page = store.search(ID, { genresExclude: ['%'], limit: 50 });
    expect(titlesOf(page)).toEqual([
      'Drama Malice',
      'Comedy Drama',
      'Action Only',
      'Action Comedy',
    ]);
    expect(page.total).toBe(4);
  });

  it('composes with q (FTS) and newDays like any other row filter', () => {
    const page = store.search(ID, { query: 'filter', genresExclude: ['Comedy'], newDays: 7, limit: 50 });
    // filter-FTS rows minus Comedy rows, jdn > TODAY-7 → Action Only + Drama Malice.
    expect([...titlesOf(page)].sort()).toEqual(['Action Only', 'Drama Malice']);
  });

  it('cursor binds the exclude list: reuse under a changed exclude set throws', () => {
    const first = store.search(ID, { genres: ['Action'], genresMode: 'any', genresExclude: ['Comedy'], limit: 1 });
    expect(first.nextCursor).toBeDefined();
    const cursor = first.nextCursor as string;
    // Same filters walk.
    expect(() =>
      store.search(ID, { genres: ['Action'], genresMode: 'any', genresExclude: ['Comedy'], limit: 1, cursor }),
    ).not.toThrow();
    // Changed exclude set / added exclude / dropped excludes — rejected.
    expect(() =>
      store.search(ID, { genres: ['Action'], genresMode: 'any', genresExclude: ['Drama'], limit: 1, cursor }),
    ).toThrow(/cursor/);
    expect(() =>
      store.search(ID, { genres: ['Action'], genresMode: 'any', genresExclude: ['Comedy', 'Drama'], limit: 1, cursor }),
    ).toThrow(/cursor/);
    expect(() =>
      store.search(ID, { genres: ['Action'], genresMode: 'any', limit: 1, cursor }),
    ).toThrow(/cursor/);
  });
});

describe('catalog store search: artists + summary row filters (FMD2 edFilterArtists/edFilterSummary) — real SQL', () => {
  let tmp: string;
  let store: CatalogFileStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync('/tmp/opencode/filter-as-');
    createCatalogDb(path.join(tmp, 'catalogs', `${ID}.db`), ROWS);
    store = new CatalogFileStore({ dataDir: tmp });
  });

  afterEach(() => {
    store.closeAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const titlesOf = (page: { entries: ReadonlyArray<{ title: string }> }): string[] =>
    page.entries.map((e) => e.title);

  it('artists: LIKE-contains across the artists column, case-insensitive', () => {
    const page = store.search(ID, { query: 'filter', artists: 'rin', limit: 50 });
    expect([...titlesOf(page)].sort()).toEqual(['Action Comedy', 'Comedy Drama']);
    expect(page.total).toBe(2);
  });

  it('summary: LIKE-contains across the summary column', () => {
    const page = store.search(ID, { query: 'filter', summary: 'swords', limit: 50 });
    expect([...titlesOf(page)].sort()).toEqual(['Action Comedy', 'Comedy Drama']);
    expect(page.total).toBe(2);
  });

  it('artists + summary + authors compose as ANDed LIKE clauses', () => {
    // 'alice' (rows 1,3,4) ∩ artists 'rin' (rows 1,3) ∩ summary 'return'
    // (row 3 only) — the narrowing proves the clauses AND together.
    const page = store.search(ID, { query: 'filter', authors: 'alice', artists: 'rin', summary: 'return', limit: 50 });
    expect(titlesOf(page)).toEqual(['Comedy Drama']);
  });

  it('filter-only (no q): artists filter orders jdn DESC (latest parity)', () => {
    const page = store.search(ID, { artists: 'rin', limit: 50 });
    expect(titlesOf(page)).toEqual(['Comedy Drama', 'Action Comedy']);
  });

  it('LIKE wildcards in artists/summary values are ESCAPED (literal %/_)', () => {
    // DECISIVE artists % probe: a bare '%' matches ONLY the literal-% row.
    expect(store.search(ID, { artists: '%' }).total).toBe(1);
    expect(store.search(ID, { artists: 'Fifty_% Art', limit: 50 }).total).toBe(1);
    // No literal '5_%' substring exists in any summary → escaped probe matches nothing.
    expect(store.search(ID, { summary: '5_%' }).total).toBe(0);
  });

  it('cursor binds artists + summary: reuse under a changed value throws', () => {
    const first = store.search(ID, { query: 'filter', artists: 'rin', limit: 1 });
    expect(first.nextCursor).toBeDefined();
    const cursor = first.nextCursor as string;
    // Same filters walk.
    expect(() => store.search(ID, { query: 'filter', artists: 'rin', limit: 1, cursor })).not.toThrow();
    // Changed artists, added summary — rejected.
    expect(() => store.search(ID, { query: 'filter', artists: 'chihaya', limit: 1, cursor })).toThrow(/cursor/);
    expect(() => store.search(ID, { query: 'filter', artists: 'rin', summary: 'swords', limit: 1, cursor })).toThrow(/cursor/);
  });
});
