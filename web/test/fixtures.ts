/**
 * Shared §10 fixtures for web tests — every field mirrors the
 * GENERATED schema types (components/operations of openapi.d.ts), so
 * a snapshot drift that changes these shapes fails `tsc` here too.
 */
import type { ModuleSummaryT, CatalogEntryT, InfoResponseT, JobT } from '../src/api/hooks';

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
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      events: [],
      known_broken_flags: [],
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

export function infoFixture(): InfoResponseT {
  return {
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
