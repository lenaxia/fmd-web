/**
 * §6.8 live-scrape fallback — §10 route integration (offline): the
 * browse/search endpoints serve catalog-first, live directory walk
 * second, typed error otherwise; every response carries the `source`
 * discriminator; a catalog syncing mid-flight flips the module back to
 * `catalog`; /api/modules publishes the live_scrape_fallback flag.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@fmd/contract';
import { buildApp } from '../../src/api/app.js';
import { LiveScrapeCatalogStore } from '../../src/catalog/live-scrape-store.js';
import { UpdateLaneScrapeGate } from '../../src/catalog/update-lane-gate.js';
import type { DirectoryWalkPort } from '../../src/catalog/directory-walk.js';
import type { RegistrationRecord } from '../../src/engine/registry/capabilities.js';
import {
  InMemoryCatalogStore,
  catalogFixtures,
  expectEnvelope,
  makeRegistration,
} from './helpers.js';
import {
  FakeSyncService,
  InMemoryFavoriteService,
  InMemoryJobService,
  InMemoryLibraryService,
  InMemoryModuleService,
} from '../../src/api/services.js';
import { InMemoryAccountService } from '../../src/accounts/account-service.js';
import { FakeInfoService } from './helpers.js';

const CATALOG_ID = 'c'.repeat(32); // HAS an installed catalog
const LIVE_ID = 'b'.repeat(32); // catalog-less, directory-capable
const PLAIN_ID = 'a'.repeat(32); // catalog-less, NOT directory-capable

function liveEntry(link: string, title: string, extras: Partial<CatalogEntry> = {}): CatalogEntry {
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
    ...extras,
  };
}

/** Scripted walk double (§6.8-normalized entries; last outcome repeats). */
class FixtureWalker implements DirectoryWalkPort {
  calls = 0;
  constructor(private readonly outcomes: Array<CatalogEntry[] | Error>) {}
  async walk(): Promise<readonly CatalogEntry[]> {
    const next = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)];
    this.calls += 1;
    if (next instanceof Error) {
      throw next;
    }
    return next === undefined ? [] : [...next];
  }
}

function registrations(): RegistrationRecord[] {
  return [
    makeRegistration({ id: PLAIN_ID, name: 'PlainSource' }),
    makeRegistration({
      id: LIVE_ID,
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
  ];
}

interface Harness {
  readonly app: ReturnType<typeof buildApp>;
  readonly catalogs: InMemoryCatalogStore;
  readonly walker: FixtureWalker;
  readonly fallback: LiveScrapeCatalogStore;
}

function buildHarness(
  outcomes: Array<CatalogEntry[] | Error>,
  catalogIds: readonly string[] = [],
): Harness {
  const catalogs = new InMemoryCatalogStore(catalogFixtures(), catalogIds);
  const walker = new FixtureWalker(outcomes);
  const fallback = new LiveScrapeCatalogStore({
    walk: walker,
    modules: registrations,
    laneGate: new UpdateLaneScrapeGate(2),
  });
  const app = buildApp(
    {
      modules: new InMemoryModuleService(registrations()),
      catalogs,
      catalogFallback: fallback,
      info: new FakeInfoService([LIVE_ID, PLAIN_ID]),
      jobs: new InMemoryJobService(),
      library: new InMemoryLibraryService(),
      favorites: new InMemoryFavoriteService(),
      sync: new FakeSyncService(),
      accounts: new InMemoryAccountService(),
    },
    { version: '0.1.0-test' },
  );
  return { app, catalogs, walker, fallback };
}

function siteEntries(): CatalogEntry[] {
  return [
    liveEntry('/manga/Delta', 'Delta', { genres: 'Action', status: 'Ongoing', summary: 'latest story' }),
    liveEntry('/manga/Alpha', 'Alpha', { genres: 'Drama', status: 'Completed', summary: 'first story' }),
    liveEntry('/manga/Beta', 'Beta Tales', { genres: 'Action', status: 'Ongoing', summary: 'second story' }),
  ];
}

interface PageBody {
  entries: Array<{ link: string; title: string }>;
  total?: number;
  nextCursor?: string;
  source: 'catalog' | 'live';
}

describe('§6.8 fallback routing — source discriminator', (): void => {
  it('catalog present → source "catalog" (§6.6 behavior unchanged)', async (): Promise<void> => {
    const h = buildHarness([siteEntries()], [CATALOG_ID]);
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${CATALOG_ID}/latest?limit=2` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PageBody;
    expect(body.source).toBe('catalog');
    expect(body.total).toBe(5);
    expect(body.entries[0]?.title).toBe('Delta');
    expect(h.walker.calls).toBe(0);
  });

  it('catalog absent + directory-capable module → source "live" (normalized entries)', async (): Promise<void> => {
    const h = buildHarness([siteEntries()]);
    const latest = await h.app.inject({ method: 'GET', url: `/api/catalog/${LIVE_ID}/latest` });
    expect(latest.statusCode).toBe(200);
    const body = latest.json() as PageBody;
    expect(body.source).toBe('live');
    expect(body.entries.map((e) => e.link)).toEqual(['/manga/Delta', '/manga/Alpha', '/manga/Beta']);

    const byTitle = await h.app.inject({ method: 'GET', url: `/api/catalog/${LIVE_ID}/title` });
    expect((byTitle.json() as PageBody).source).toBe('live');
    expect((byTitle.json() as PageBody).entries.map((e) => e.title)).toEqual(['Alpha', 'Beta Tales', 'Delta']);

    // page params work on the live channel like the catalog channel
    const page2 = await h.app.inject({ method: 'GET', url: `/api/catalog/${LIVE_ID}/latest?page=2&limit=2` });
    expect((page2.json() as PageBody).entries.map((e) => e.link)).toEqual(['/manga/Beta']);
    // ONE walk served every request (TTL cache)
    expect(h.walker.calls).toBe(1);
  });

  it('catalog absent + NOT directory-capable → typed 404 envelope naming the gap', async (): Promise<void> => {
    const h = buildHarness([siteEntries()]);
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${PLAIN_ID}/latest` });
    expect(res.statusCode).toBe(404);
    const envelope = expectEnvelope(res.body, 'not_found');
    expect(envelope.message).toContain('live directory walk');
    // Same envelope for an id unknown to the registry entirely.
    const unknown = await h.app.inject({ method: 'GET', url: `/api/catalog/${'f'.repeat(32)}/title` });
    expect(unknown.statusCode).toBe(404);
    expectEnvelope(unknown.body, 'not_found');
  });

  it('walk failure → typed 502 envelope, never a partial page', async (): Promise<void> => {
    const h = buildHarness([
      new Error('GetNameAndLink returned net_problem on page 1'),
    ]);
    const res = await h.app.inject({ method: 'GET', url: `/api/catalog/${LIVE_ID}/latest` });
    expect(res.statusCode).toBe(502);
    expectEnvelope(res.body, 'upstream_error');
  });
});

describe('§6.8 mid-flight catalog arrival — the live→catalog switch', (): void => {
  it('catalog syncs mid-flight: next request is served from the catalog', async (): Promise<void> => {
    const h = buildHarness([siteEntries()], []);
    const before = await h.app.inject({ method: 'GET', url: `/api/catalog/${LIVE_ID}/latest` });
    expect((before.json() as PageBody).source).toBe('live');
    expect(h.walker.calls).toBe(1);

    // The §6.2–§6.3 sync lands the db + invalidates the live snapshot
    // (exactly what the assembly's syncCatalog hook does on 'updated').
    h.catalogs.install(LIVE_ID, catalogFixtures());
    h.fallback.invalidate(LIVE_ID);

    const after = await h.app.inject({ method: 'GET', url: `/api/catalog/${LIVE_ID}/latest` });
    expect(after.statusCode).toBe(200);
    const body = after.json() as PageBody;
    expect(body.source).toBe('catalog');
    expect(body.entries).toHaveLength(5);
    expect(body.total).toBe(5);
    // The catalog answers NOW — the walk snapshot never leaks after arrival.
    expect(body.entries.every((e) => e.link.startsWith('https://ex.org/'))).toBe(true);
  });
});

describe('§6.8 live search — cursor scheme identical to the catalog endpoints', (): void => {
  it('searches the live index and pages with the same opaque cursors', async (): Promise<void> => {
    const h = buildHarness([siteEntries()]);
    const first = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${LIVE_ID}/search?q=story&limit=2`,
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json() as PageBody;
    expect(page1.source).toBe('live');
    expect(page1.total).toBe(3);
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    // Same scheme as the catalog FTS store: base64url JSON {q, o}.
    const payload = JSON.parse(
      Buffer.from(page1.nextCursor as string, 'base64url').toString('utf8'),
    ) as { q: string; o: number };
    expect(payload.q).toBe('story');
    expect(payload.o).toBe(2);

    const second = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${LIVE_ID}/search?q=story&limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
    });
    const page2 = second.json() as PageBody;
    expect(page2.entries).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    // Same cached snapshot — one walk total.
    expect(h.walker.calls).toBe(1);

    // Cursor reuse against another query → 400 (same rule as §6.5).
    const rebound = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${LIVE_ID}/search?q=OTHER&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
    });
    expect(rebound.statusCode).toBe(400);
    expectEnvelope(rebound.body, 'bad_request');

    // status/genre filters over the live index.
    const filtered = await h.app.inject({
      method: 'GET',
      url: `/api/catalog/${LIVE_ID}/search?q=story&status=Completed`,
    });
    expect((filtered.json() as PageBody).entries.map((e) => e.title)).toEqual(['Alpha']);
  });
});

describe('/api/modules — live_scrape_fallback flag (§6.8)', (): void => {
  it('publishes the flag per module', async (): Promise<void> => {
    const h = buildHarness([siteEntries()]);
    const res = await h.app.inject({ method: 'GET', url: '/api/modules' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { modules: Array<{ id: string; capabilities: { live_scrape_fallback: boolean } }> };
    const byId = new Map(body.modules.map((m) => [m.id, m.capabilities.live_scrape_fallback]));
    expect(byId.get(LIVE_ID)).toBe(true);
    expect(byId.get(PLAIN_ID)).toBe(false);
  });
});
