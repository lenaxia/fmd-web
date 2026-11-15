/**
 * §6.8 live-scrape fallback store — unit tests (offline): TTL cache +
 * single-flight, catalog-arrival invalidation, cursor stability within
 * the TTL window, the LIKE search index, the update-lane gate
 * interplay, and the §5.8 normalization of scraped directory pairs.
 */
import { describe, expect, it } from 'vitest';
import {
  CatalogFallbackError,
  type CatalogEntry,
  type CatalogPage,
} from '@fmd/contract';
import { LiveScrapeCatalogStore, DEFAULT_LIVE_SCRAPE_TTL_MS } from '../../src/catalog/live-scrape-store.js';
import { normalizeDirectoryEntries } from '../../src/catalog/directory-walk.js';
import { UpdateLaneScrapeGate } from '../../src/catalog/update-lane-gate.js';
import { makeRegistration } from '../api/helpers.js';
import type { DirectoryWalkPort } from '../../src/catalog/directory-walk.js';

const MODULE_ID = 'b'.repeat(32);
const OTHER_ID = 'd'.repeat(32);
const THIRD_ID = '7'.repeat(32);

function entry(link: string, title: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    link,
    title,
    alttitles: '',
    authors: '',
    artists: '',
    genres: '',
    status: '',
    summary: '',
    numChapter: 0,
    jdn: 0,
    ...overrides,
  };
}

function siteFixture(): CatalogEntry[] {
  // Walk order = the site's newest-first directory order.
  return [
    entry('/manga/Delta', 'Delta', { genres: 'Action', status: 'Ongoing', summary: 'latest story' }),
    entry('/manga/Alpha', 'Alpha', { genres: 'Drama', status: 'Completed', summary: 'first story' }),
    entry('/manga/Beta', 'Beta Tales', { genres: 'Action', status: 'Ongoing', summary: 'second story' }),
    entry('/manga/Gamma', 'gamma', { genres: 'Comedy', status: 'Hiatus', summary: 'fourth story' }),
    entry('/manga/Epsilon', 'Epsilon', { genres: 'Action', status: 'Ongoing', summary: 'fifth story' }),
  ];
}

/** Bounded event-loop poll (1 ms quantum, deterministic). */
async function untilGate(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error('gate condition not met');
}

/** Scripted walk double: one queued outcome per call (last repeats). */
class FixtureWalker implements DirectoryWalkPort {
  calls = 0;
  readonly modules: string[] = [];

  constructor(private readonly outcomes: Array<CatalogEntry[] | Error>) {}

  async walk(moduleId: string): Promise<readonly CatalogEntry[]> {
    this.calls += 1;
    this.modules.push(moduleId);
    const next = this.outcomes[Math.min(this.calls - 1, this.outcomes.length - 1)];
    if (next instanceof Error) {
      throw next;
    }
    return next === undefined ? [] : [...next];
  }
}

interface StoreFixture {
  readonly store: LiveScrapeCatalogStore;
  readonly walker: FixtureWalker;
  readonly gate: UpdateLaneScrapeGate;
  clock: { nowMs: number };
}

function makeStore(outcomes: Array<CatalogEntry[] | Error>, ttlMs = DEFAULT_LIVE_SCRAPE_TTL_MS): StoreFixture {
  const walker = new FixtureWalker(outcomes);
  const gate = new UpdateLaneScrapeGate(2);
  const clockState = { nowMs: 1_000_000 };
  const store = new LiveScrapeCatalogStore({
    walk: walker,
    modules: (): readonly ReturnType<typeof makeRegistration>[] => [
      makeRegistration({
        id: MODULE_ID,
        name: 'LiveSource',
        capabilities: {
          requires_subprocess: false,
          requires_browser: false,
          bypass_python_gated: false,
          requires_imagepuzzle: false,
          requires_mangafoxwatermark: false,
          events: ['OnGetDirectoryPageNumber', 'OnGetNameAndLink', 'OnGetInfo'],
          known_broken_flags: [],
          live_scrape_fallback: true,
        },
      }),
      makeRegistration({ id: OTHER_ID, name: 'CatalogOnly' }),
    ],
    laneGate: gate,
    ttlMs,
    clock: { now: (): number => clockState.nowMs },
  });
  return { store, walker, gate, clock: clockState };
}

describe('LiveScrapeCatalogStore — TTL cache (§6.8)', (): void => {
  it('one walk per TTL window: cache hits never re-walk', async (): Promise<void> => {
    const fx = makeStore([siteFixture()]);
    const page1: CatalogPage = await fx.store.latest(MODULE_ID, { page: 1, limit: 2 });
    expect(page1.entries.map((e) => e.link)).toEqual(['/manga/Delta', '/manga/Alpha']);
    expect(page1.total).toBe(5);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await fx.store.latest(MODULE_ID, { page: 2, limit: 2 });
    expect(page2.entries.map((e) => e.link)).toEqual(['/manga/Beta', '/manga/Gamma']);
    expect(fx.walker.calls).toBe(1);
  });

  it('TTL expiry re-walks; entries refresh', async (): Promise<void> => {
    const fx = makeStore([siteFixture(), [entry('/manga/Fresh', 'Fresh')]]);
    await fx.store.latest(MODULE_ID);
    fx.clock.nowMs += DEFAULT_LIVE_SCRAPE_TTL_MS + 1;
    const page = await fx.store.latest(MODULE_ID);
    expect(page.entries.map((e) => e.title)).toEqual(['Fresh']);
    expect(page.total).toBe(1);
    expect(fx.walker.calls).toBe(2);
  });

  it('concurrent cold requests share ONE walk (single-flight)', async (): Promise<void> => {
    const fx = makeStore([siteFixture()]);
    const [a, b, c] = await Promise.all([
      fx.store.latest(MODULE_ID),
      fx.store.byTitle(MODULE_ID),
      fx.store.search(MODULE_ID, { query: 'story' }),
    ]);
    expect(fx.walker.calls).toBe(1);
    expect(a.entries).toHaveLength(5);
    expect(b.entries.map((e) => e.title)).toEqual(['Alpha', 'Beta Tales', 'Delta', 'Epsilon', 'gamma']);
    expect(c.total).toBe(5);
  });

  it('invalidate drops the snapshot: the next request re-walks', async (): Promise<void> => {
    const fx = makeStore([siteFixture(), siteFixture()]);
    await fx.store.latest(MODULE_ID);
    fx.store.invalidate(MODULE_ID);
    await fx.store.byTitle(MODULE_ID);
    expect(fx.walker.calls).toBe(2);
  });
});

describe('LiveScrapeCatalogStore — cursor stability (§6.8)', (): void => {
  it('search cursors stay stable across refreshes WITHIN the TTL (same snapshot)', async (): Promise<void> => {
    const fx = makeStore([siteFixture()]);
    const page1 = await fx.store.search(MODULE_ID, { query: 'story', limit: 2 });
    expect(page1.nextCursor).toBeDefined();
    fx.clock.nowMs += DEFAULT_LIVE_SCRAPE_TTL_MS - 1; // still within TTL
    expect(page1.nextCursor).toBeDefined();
    const page2 = await fx.store.search(MODULE_ID, {
      query: 'story',
      limit: 2,
      ...(page1.nextCursor !== undefined ? { cursor: page1.nextCursor } : {}),
    });
    // Walk ran ONCE: the cursor decodes against the SAME cached snapshot.
    expect(fx.walker.calls).toBe(1);
    expect(page2.entries.map((e) => e.title)).toEqual(['Delta', 'Epsilon']);
    expect(page2.nextCursor).toBeDefined();
    const page3 = await fx.store.search(MODULE_ID, {
      query: 'story',
      limit: 2,
      ...(page2.nextCursor !== undefined ? { cursor: page2.nextCursor } : {}),
    });
    expect(page3.entries.map((e) => e.title)).toEqual(['gamma']);
    expect(page3.nextCursor).toBeUndefined();
    expect(fx.walker.calls).toBe(1);
  });

  it('search cursors are query-bound and scheme-identical to the catalog store', async (): Promise<void> => {
    const fx = makeStore([siteFixture()]);
    const page1 = await fx.store.search(MODULE_ID, { query: 'story', limit: 2, status: 'Ongoing', genre: 'Action' });
    const payload = JSON.parse(
      Buffer.from(page1.nextCursor as string, 'base64url').toString('utf8'),
    ) as { q: string; o: number; g?: string; s?: string };
    // base64url JSON offset cursor, bound to query + filters (same scheme
    // family as the FTS store's {q, o, g?}).
    expect(payload.q).toBe('story');
    expect(payload.o).toBe(2);
    expect(payload.g).toBe('Action');
    expect(payload.s).toBe('Ongoing');

    const rebound = fx.store.search(MODULE_ID, { query: 'OTHER', cursor: page1.nextCursor ?? '' });
    await expect(rebound).rejects.toThrow(/cursor/);
    const regenre = fx.store.search(MODULE_ID, { query: 'story', genre: 'Drama', cursor: page1.nextCursor ?? '' });
    await expect(regenre).rejects.toThrow(/cursor/);
    const malformed = fx.store.search(MODULE_ID, { query: 'story', cursor: '!!not-a-cursor' });
    await expect(malformed).rejects.toThrow(/cursor/);
  });

  it('browse pages carry the catalog endpoints offset cursor scheme', async (): Promise<void> => {
    const fx = makeStore([siteFixture()]);
    const page1 = await fx.store.latest(MODULE_ID, { page: 1, limit: 3 });
    const payload = JSON.parse(
      Buffer.from(page1.nextCursor as string, 'base64url').toString('utf8'),
    ) as { o: number };
    expect(payload.o).toBe(3);
  });
});

describe('LiveScrapeCatalogStore — LIKE search index (§6.8)', (): void => {
  it('q terms ANDed over title/alttitles/summary; status exact; genre substring', async (): Promise<void> => {
    const fx = makeStore([siteFixture()]);
    const byTerm = await fx.store.search(MODULE_ID, { query: 'story' });
    expect(byTerm.total).toBe(5);
    const terms = await fx.store.search(MODULE_ID, { query: 'second story' });
    expect(terms.entries.map((e) => e.title)).toEqual(['Beta Tales']);
    // ASCII-fold NOCASE LIKE ('gamma' matches 'Gamma' — stored lowercase title here)
    const folded = await fx.store.search(MODULE_ID, { query: 'GAMMA' });
    expect(folded.entries.map((e) => e.title)).toEqual(['gamma']);
    const statusFiltered = await fx.store.search(MODULE_ID, { query: 'story', status: 'Ongoing' });
    expect(statusFiltered.total).toBe(3);
    const genreFiltered = await fx.store.search(MODULE_ID, { query: 'story', genre: 'action' });
    expect(genreFiltered.total).toBe(3);
    const both = await fx.store.search(MODULE_ID, { query: 'story', status: 'Completed', genre: 'Drama' });
    expect(both.entries.map((e) => e.title)).toEqual(['Alpha']);
  });
});

describe('LiveScrapeCatalogStore — typed failures + lane gate (§6.8/§4)', (): void => {
  it('a failed walk rejects typed and does NOT poison the cache', async (): Promise<void> => {
    const fx = makeStore([
      new CatalogFallbackError('walk_failed', 'GetNameAndLink returned net_problem on page 1'),
      siteFixture(),
    ]);
    await expect(fx.store.latest(MODULE_ID)).rejects.toMatchObject({
      name: 'CatalogFallbackError',
      kind: 'walk_failed',
    });
    // next request walks again and succeeds (cache untouched by the failure)
    const page = await fx.store.latest(MODULE_ID);
    expect(page.entries).toHaveLength(5);
    expect(fx.walker.calls).toBe(2);
  });

  it('supports() gates on the §6.8 capability, not catalog presence', (): void => {
    const fx = makeStore([siteFixture()]);
    expect(fx.store.supports(MODULE_ID)).toBe(true);
    expect(fx.store.supports(OTHER_ID)).toBe(false);
    expect(fx.store.supports('f'.repeat(32))).toBe(false);
  });

  it('scrape slots bound concurrency; close() fails queued waiters typed', async (): Promise<void> => {
    const gate = new UpdateLaneScrapeGate(1);
    let releaseSlot: (() => void) | undefined;
    const walker: DirectoryWalkPort = {
      walk: (moduleId: string): Promise<readonly CatalogEntry[]> => {
        void moduleId;
        return new Promise<readonly CatalogEntry[]>((resolve) => {
          releaseSlot = (): void => {
            resolve([entry('/manga/x', 'X')]);
          };
        });
      },
    };
    const clockState = { nowMs: 0 };
    const store = new LiveScrapeCatalogStore({
      walk: walker,
      modules: (): readonly ReturnType<typeof makeRegistration>[] => [
        makeRegistration({ id: MODULE_ID, name: 'LiveSource' }),
        makeRegistration({ id: OTHER_ID, name: 'LiveSourceOther' }),
        makeRegistration({ id: THIRD_ID, name: 'LiveSourceThird' }),
      ],
      laneGate: gate,
      clock: { now: (): number => clockState.nowMs },
    });

    const first = store.latest(MODULE_ID);
    await untilGate((): boolean => gate.active === 1);

    // A DIFFERENT module (the same id would single-flight-join the
    // in-flight walk instead of queueing on the gate).
    const second = store.latest(OTHER_ID);
    await untilGate((): boolean => gate.queued === 1);

    releaseSlot?.();
    await untilGate((): boolean => gate.active === 1); // slot handed to walk 2
    expect(await first).toBeDefined();
    releaseSlot?.(); // releaseSlot re-bound to walk 2's resolver
    expect(await second).toBeDefined();
    expect(gate.active).toBe(0);
    expect(gate.queued).toBe(0);
    expect(gate.active).toBe(0);
    expect(gate.queued).toBe(0);

    gate.close();
    // A COLD module must acquire from the closed gate → typed lane_closed
    // (a warm cache hit would never touch the gate at all).
    await expect(store.search(THIRD_ID, { query: 'x' })).rejects.toMatchObject({
      name: 'CatalogFallbackError',
      kind: 'lane_closed',
    });
  });
});

describe('§5.8 normalization of scraped directory pairs (normalizeDirectoryEntries)', (): void => {
  it('strips hosts, trims titles, decodes entities; drops link-less entries', (): void => {
    const normalized = normalizeDirectoryEntries([
      { title: '  Alpha Manga  ', link: 'https://site.example/manga/Alpha_Manga/' },
      { title: 'Beta &amp; Tales', link: 'https://site.example/manga/Beta%20Tales' },
      { title: 'Relative Path', link: '/manga/relative' },
      { title: 'No Link', link: '' },
      { title: 'Beta\n Gamma', link: 'https://site.example/manga/multiline' },
    ]);
    // §5.8 pipeline output — NOT raw module output:
    expect(normalized.map((e) => e.link)).toEqual([
      '/manga/Alpha_Manga/', // removeHostFromURL (uData.pas:111-113 path)
      '/manga/Beta%20Tales',
      '/manga/relative', // host-relative links pass through
      '/manga/multiline',
      // 'No Link' dropped (RemoveHostFromURLsPair :983 parity)
    ]);
    expect(normalized.map((e) => e.title)).toEqual([
      'Alpha Manga', // trim chain (uData.pas:115-127)
      'Beta & Tales', // CommonStringFilter &amp; decode
      'Relative Path',
      'Beta Gamma', // break removed (stringFilter \\n → removeStringBreaks)
    ]);
    // Directory snapshots carry no chapter/jdn data (§6.8 fields unknown).
    for (const entryRow of normalized) {
      expect(entryRow.numChapter).toBe(0);
      expect(entryRow.jdn).toBe(0);
      expect(entryRow.status).toBe('');
    }
  });
});
