/**
 * Shared §10 fixtures for web tests — every field mirrors the
 * GENERATED schema types (components/operations of openapi.d.ts), so
 * a snapshot drift that changes these shapes fails `tsc` here too.
 */
import type { ModuleSummaryT, CatalogEntryT, InfoResponseT, JobT, FavoriteT } from '../src/api/hooks';

export const CATALOG_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
export const MODULE_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

export function moduleFixture(overrides?: Partial<ModuleSummaryT>): ModuleSummaryT {
  return {
    id: MODULE_ID,
    name: 'FixtureSite',
    rootURL: 'https://fixtures.example',
    category: 'Fixture',
    accountSupport: false,
    file: 'modules/FixtureSite.lua',
    enabled: true,
    options: [],
    proxy: null,
    catalogInstalled: true,
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: [],
      known_broken_flags: [],
      live_scrape_fallback: false,
    },
    ...overrides,
  };
}

export function entryFixture(link: string, title: string, overrides?: Partial<CatalogEntryT>): CatalogEntryT {
  return {
    link,
    title,
    alttitles: '',
    authors: 'Author A',
    artists: '',
    genres: 'Action',
    status: 'Ongoing',
    summary: '',
    numChapter: 12,
    jdn: 1,
    ...overrides,
  };
}

export function infoFixture(overrides?: Partial<InfoResponseT>): InfoResponseT {
  return {
    moduleId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    title: 'Fixture Manga',
    altTitles: 'Fixtue Manhua',
    authors: 'Author A',
    artists: 'Artist B',
    genres: 'Action, Comedy',
    status: 'Ongoing',
    summary: 'A fixture summary.',
    coverLink: 'https://fixtures.example/cover.jpg',
    url: 'https://fixtures.example/manga/fixture',
    link: '/manga/fixture',
    chapterLinks: ['/manga/fixture/ch-1', '/manga/fixture/ch-2', '/manga/fixture/ch-3'],
    chapterNames: ['Chapter 1', 'Chapter 2', 'Chapter 3'],
    numChapter: 3,
    downloaded: ['/manga/fixture/ch-1'],
    ...overrides,
  };
}

export function jobFixture(id: string, overrides?: Partial<JobT>): JobT {
  return {
    id,
    type: 'download',
    moduleId: MODULE_ID,
    payload: { mangaTitle: 'Fixture Manga', chapterName: 'Chapter 1' },
    state: 'queued',
    priority: 0,
    createdAt: '2026-11-13T00:00:00Z',
    updatedAt: '2026-11-13T00:00:00Z',
    ...overrides,
  };
}

/** One §7.2 favorite row (the favorites page fixture). */
export function favoriteFixture(overrides: Partial<FavoriteT> = {}): FavoriteT {
  return {
    id: 'a'.repeat(32) + 'https://ex.org/manga/fav',
    moduleId: 'a'.repeat(32),
    url: 'https://ex.org/manga/fav',
    title: 'Fixture Favorite',
    status: 'Ongoing',
    currentChapter: 12,
    newChapterCount: 0,
    autoDownload: false,
    lastCheck: '2026-01-01T00:00:00Z',
    lastUpdated: null,
    saveTo: null,
    enabled: true,
    dateAdded: '2026-01-01T00:00:00Z',
    coverLink: null,
    ...overrides,
  };
}
