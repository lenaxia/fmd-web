/**
 * GET /api/catalog/:id/search — FMD2 Filter-panel params (additive):
 * authors LIKE, genres[] multi with genresMode any|all, newDays jdn
 * window; q optional when a filter is set. Route-level composition is
 * asserted against the in-memory double (SQL ANY/ALL semantics vs the
 * REAL store live in sync/db/catalog-store-search-filters.test.ts);
 * a spy on the store seam proves the PARSED params the route hands
 * down (incl. the genresMode default and both genres wire forms).
 */
import { describe, expect, it } from 'vitest';
import type { CatalogEntry, CatalogSearchQuery } from '@fmd/contract';
import { jdnToday } from '../../src/sync/db/catalog-store.js';
import { buildHarness, expectEnvelope, UNKNOWN_CATALOG_ID, inMemoryCatalogs } from './helpers.js';

/** Filter fixtures: overlapping genres/authors/status for ANY/ALL proofs. */
function filterFixtures(): CatalogEntry[] {
  return [
    { link: '/f/1', title: 'Action Comedy', alttitles: '', authors: 'Alice Akagi', artists: '', genres: 'Action, Comedy', status: 'Ongoing', summary: 'filter story', numChapter: 1, jdn: 45000 },
    { link: '/f/2', title: 'Action Only', alttitles: '', authors: 'Bob Bufo', artists: '', genres: 'Action', status: 'Ongoing', summary: 'filter story', numChapter: 2, jdn: 45001 },
    { link: '/f/3', title: 'Comedy Drama', alttitles: '', authors: 'Alice Kawabe', artists: '', genres: 'Comedy, Drama', status: 'Completed', summary: 'filter story', numChapter: 3, jdn: 45002 },
    // 'Malice' contains 'alice' — LIKE-contains is case-insensitive.
    { link: '/f/4', title: 'Drama Malice', alttitles: '', authors: 'Malice', artists: '', genres: 'Action, Drama', status: 'Hiatus', summary: 'filter story', numChapter: 4, jdn: 45003 },
  ];
}

function newWindowFixtures(): CatalogEntry[] {
  const today: number = jdnToday();
  return [
    { link: '/n/1', title: 'Fresh Today', alttitles: '', authors: 'A', artists: '', genres: 'Action', status: 'Ongoing', summary: 'new story', numChapter: 1, jdn: today },
    { link: '/n/2', title: 'Stale Month', alttitles: '', authors: 'B', artists: '', genres: 'Action', status: 'Ongoing', summary: 'new story', numChapter: 2, jdn: today - 30 },
  ];
}

/** Harness with the filter fixtures installed under a fresh catalog id. */
function filterHarness(entries: CatalogEntry[] = filterFixtures()) {
  const h = buildHarness();
  inMemoryCatalogs(h).install(UNKNOWN_CATALOG_ID, entries);
  return h;
}

function titles(body: unknown): string[] {
  return (body as { entries: Array<{ title: string }> }).entries.map((e) => e.title);
}

describe('GET /api/catalog/:id/search — FMD2 filter params (additive)', (): void => {
  it('genres[] ANY (rbAny): OR of matches', async (): Promise<void> => {
    const h = filterHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=Action&genres=Comedy&genresMode=any`,
    });
    expect(res.statusCode).toBe(200);
    expect(titles(res.json())).toEqual(['Action Comedy', 'Action Only', 'Comedy Drama', 'Drama Malice']);
  });

  it('genres[] ALL (rbAll, the FMD2 default): AND of matches', async (): Promise<void> => {
    const h = filterHarness();
    const both = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=Action&genres=Comedy&genresMode=all`,
    });
    expect(both.statusCode).toBe(200);
    expect(titles(both.json())).toEqual(['Action Comedy']);

    // genresMode omitted → 'all' (FMD2 rbAll is the checked default).
    const omitted = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=Action&genres=Comedy`,
    });
    expect(omitted.statusCode).toBe(200);
    expect(titles(omitted.json())).toEqual(['Action Comedy']);
  });

  it('genres accepts ONE comma-separated param (FMD2 custom-genres form)', async (): Promise<void> => {
    const h = filterHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=Action,Comedy&genresMode=any`,
    });
    expect(res.statusCode).toBe(200);
    expect(titles(res.json())).toHaveLength(4);
  });

  it('authors: LIKE-contains, case-insensitive', async (): Promise<void> => {
    const h = filterHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&authors=alice`,
    });
    expect(res.statusCode).toBe(200);
    // Alice Akagi, Alice Kawabe and Malice (contains 'alice').
    expect(titles(res.json())).toEqual(['Action Comedy', 'Comedy Drama', 'Drama Malice']);
  });

  it('mixed composition: q + status + genres(ALL) + authors', async (): Promise<void> => {
    const h = filterHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&status=Ongoing&genres=Action&authors=alice&genresMode=all`,
    });
    expect(res.statusCode).toBe(200);
    expect(titles(res.json())).toEqual(['Action Comedy']);
  });

  it('newDays: only-new jdn window (jdn > JDN(today) - newDays)', async (): Promise<void> => {
    const h = filterHarness(newWindowFixtures());
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=new&newDays=7`,
    });
    expect(res.statusCode).toBe(200);
    expect(titles(res.json())).toEqual(['Fresh Today']);
  });

  it('q is OPTIONAL when a filter is set (FMD2 Filter panel parity)', async (): Promise<void> => {
    const h = filterHarness();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?genres=Comedy&genresMode=any`,
    });
    expect(res.statusCode).toBe(200);
    expect(titles(res.json())).toEqual(['Action Comedy', 'Comedy Drama']);
  });

  it('no q AND no filter is a validation error', async (): Promise<void> => {
    const h = filterHarness();
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search` });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'validation_error');
  });

  it('cursor binds the FULL filter state: reuse under another filter is a 400', async (): Promise<void> => {
    const h = filterHarness();
    const first = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=Action&genres=Drama&genresMode=any&limit=2`,
    });
    const cursor: string | undefined = (first.json() as { nextCursor?: string }).nextCursor;
    expect(cursor).toBeDefined();

    // Same filters → walks.
    const same = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=Action&genres=Drama&genresMode=any&limit=2&cursor=${encodeURIComponent(cursor as string)}`,
    });
    expect(same.statusCode).toBe(200);

    // Any filter change (authors, newDays, status, mode flip, genre-set
    // change) → rejected, never silently re-paged.
    const rebind = (url: string): Promise<void> =>
      h.app.inject({ method: 'GET', url }).then((res): void => {
        expect(res.statusCode, url).toBe(400);
        expectEnvelope(res.body, 'bad_request');
      });
    const base = `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&limit=2&cursor=${encodeURIComponent(cursor as string)}`;
    await rebind(`${base}&genres=Action&genres=Drama&genresMode=any&authors=alice`);
    await rebind(`${base}&genres=Action&genres=Drama&genresMode=any&newDays=7`);
    await rebind(`${base}&genres=Action&genres=Drama&genresMode=any&status=Ongoing`);
    await rebind(`${base}&genres=Action&genres=Drama&genresMode=all`);
    await rebind(`${base}&genres=Action&genresMode=any`);
  });

  it('validation: bad genresMode/newDays values are 400 envelopes; empty genres ≡ absent', async (): Promise<void> => {
    const h = filterHarness();
    for (const suffix of ['&genresMode=banana', '&newDays=0', '&newDays=366', '&newDays=abc']) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter${suffix}`,
      });
      expect(res.statusCode, suffix).toBe(400);
      expectEnvelope(res.body, 'validation_error');
    }
    // An empty genres value normalizes to NO genre filter (FMD2: empty
    // custom-genres text adds nothing) — the query still succeeds.
    const empty = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=`,
    });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { total: number }).total).toBe(4);
  });

  it('composition proof: the route hands the store PARSED params (defaults incl.)', async (): Promise<void> => {
    const h = filterHarness();
    const seen: CatalogSearchQuery[] = [];
    const original = h.catalogs.search.bind(h.catalogs);
    h.catalogs.search = (id, query): ReturnType<typeof original> => {
      seen.push(structuredClone(query));
      return original(id, query);
    };

    await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=Action,Comedy&authors=alice&newDays=7`,
    });
    await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${UNKNOWN_CATALOG_ID}/search?q=filter&genres=Action&genres=Comedy&genresMode=any`,
    });

    expect(seen).toHaveLength(2);
    // Comma form → array; genresMode default 'all' (FMD2 rbAll).
    expect(seen[0]).toMatchObject({
      query: 'filter',
      genres: ['Action', 'Comedy'],
      genresMode: 'all',
      authors: 'alice',
      newDays: 7,
    });
    // Repeated-param form → the same array; explicit mode passes through.
    expect(seen[1]).toMatchObject({
      query: 'filter',
      genres: ['Action', 'Comedy'],
      genresMode: 'any',
    });
  });
});
