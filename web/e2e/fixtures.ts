/**
 * E2E fixtures — the ENTIRE §10 API mocked at the network edge
 * (fixture-driven; the SPA talks to the real dev server, the API is
 * interception only). Shapes mirror the generated client types.
 */
import type { Page } from '@playwright/test';
import type { ModuleSummaryT, CatalogEntryT, InfoResponseT, JobT } from '../src/api/hooks';

export const CATALOG_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
export const MODULE_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

export const entries: CatalogEntryT[] = [
  {
    link: '/manga/alpha',
    title: 'Alpha Quest',
    alttitles: '',
    authors: 'Author A',
    artists: '',
    genres: 'Action',
    status: 'Ongoing',
    summary: '',
    numChapter: 10,
    jdn: 2,
  },
  {
    link: '/manga/beta',
    title: 'Beta Trails',
    alttitles: '',
    authors: 'Author B',
    artists: '',
    genres: 'Drama',
    status: 'Complete',
    summary: '',
    numChapter: 5,
    jdn: 1,
  },
];

export const module: ModuleSummaryT = {
  id: MODULE_ID,
  name: 'FixtureSite',
  rootURL: 'https://fixtures.example',
  category: 'Fixtures',
  accountSupport: true,
  file: 'modules/FixtureSite.lua',
  enabled: true,
  options: [
    { name: 'Auto-skip pages', kind: 'checkbox', defaultValue: false },
    { name: 'Quality', kind: 'combobox', defaultValue: 1, items: ['low', 'medium', 'high'] },
  ],
  capabilities: {
    requires_subprocess: false,
    requires_browser: true,
    bypass_python_gated: false,
    events: [],
    known_broken_flags: ['cloudflare-loop'],
  },
};

export const info: InfoResponseT = {
  title: 'Alpha Quest',
  altTitles: 'Alpha Quest (Alt)',
  authors: 'Author A',
  artists: 'Artist B',
  genres: 'Action, Adventure',
  status: 'Ongoing',
  summary: 'The alpha fixture manga.',
  coverLink: '',
  url: 'https://fixtures.example/manga/alpha',
  link: '/manga/alpha',
  chapterLinks: ['/manga/alpha/ch-1', '/manga/alpha/ch-2'],
  chapterNames: ['Chapter 1: The Beginning', 'Chapter 2: The Middle'],
  numChapter: 2,
};

export const job: JobT = {
  id: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  type: 'download',
  moduleId: MODULE_ID,
  payload: { mangaTitle: 'Alpha Quest', chapterName: 'Chapter 1: The Beginning' },
  state: 'queued',
  priority: 0,
  createdAt: '2026-11-13T00:00:00Z',
  updatedAt: '2026-11-13T00:00:00Z',
};

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

// Route patterns are ANCHORED to the API root so they never match the
// SPA's own /src/api/* modules (a bare '**/api/**' glob would).
const API = (suffix: string): RegExp => new RegExp(`^https?://[^/]+/api/${suffix}`);

/**
 * Install the fixture-driven mock API for a page: every §10 route the
 * SPA can hit during the smoke run is answered from these fixtures.
 */
export function installMockApi(page: Page): void {
  // Catch-all FIRST: Playwright matches routes in reverse (registration)
  // order, so the specific fixtures below take precedence over it.
  void page.route(API(''), (route): void => {
    void route.fulfill(
      json(
        {
          error: {
            code: 'not_found',
            message: `unmocked ${route.request().method()} ${new URL(route.request().url()).pathname}`,
          },
        },
        404,
      ),
    );
  });
  void page.route(API('modules'), (route): void => {
    void route.fulfill(json({ modules: [module], count: 1 }));
  });
  void page.route(API('catalog/[^/]+/latest'), (route): void => {
    const url = new URL(route.request().url());
    const pageParam = Number(url.searchParams.get('page') ?? '1');
    if (pageParam === 1) {
      void route.fulfill(json({ entries: [entries[0]], total: 2 }));
    } else {
      void route.fulfill(json({ entries: [entries[1]], total: 2 }));
    }
  });
  void page.route(API('catalog/[^/]+/search'), (route): void => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor === null) {
      void route.fulfill(json({ entries: [entries[0]], nextCursor: 'c1', total: 2 }));
    } else {
      void route.fulfill(json({ entries: [entries[1]], total: 2 }));
    }
  });
  void page.route(API('info'), (route): void => {
    void route.fulfill(json(info));
  });
  void page.route(API('jobs\\?'), (route): void => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    if (cursor === null) {
      void route.fulfill(json({ jobs: [job], nextCursor: 'c9' }));
    } else {
      void route.fulfill(json({ jobs: [] }));
    }
  });
  void page.route(API('jobs/download'), (route): void => {
    void route.fulfill(json({ job }, 201));
  });
  void page.route(API('sync/modules'), (route): void => {
    void route.fulfill(
      json({
        ok: true,
        summary: {
          treeSha: 'deadbeefcafe',
          totalFiles: 3,
          registeredFiles: 3,
          failedFiles: 0,
          totalModules: 3,
          failures: [],
          knownBroken: {},
          eventCoverage: {},
        },
      }),
    );
  });
  void page.route(API('sync/catalog/all'), (route): void => {
    void route.fulfill(
      json({ ok: true, results: [{ id: CATALOG_ID, state: 'unchanged', dbSha: '01', bytes: 1 }] }),
    );
  });
}
