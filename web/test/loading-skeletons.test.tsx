// @vitest-environment jsdom
/**
 * Loading skeletons (UX-AUDIT H-1/B-3/M-6): while the primary data
 * fetch is in flight, SearchHome / Site browse / Manga detail render
 * structure-mirroring skeleton rows inside a role=status region — and
 * REPLACE them with content when the fetch lands (no pop-in discipline:
 * the skeleton occupies the loaded layout's metrics).
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { BrowsePage } from '../src/pages/BrowsePage';
import { MangaPage } from '../src/pages/MangaPage';
import { SearchHomePage } from '../src/pages/SearchHomePage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { CATALOG_ID, entryFixture, infoFixture, moduleFixture } from './fixtures';

autoCleanup();

const modulesRoute: MockRoute = {
  method: 'GET',
  match: (url): boolean => url.pathname === '/api/modules',
  respond: (): { body: object } => ({
    body: { modules: [moduleFixture({ id: CATALOG_ID, name: 'FixtureSite' })], count: 1 },
  }),
};

const favoritesRoute: MockRoute = {
  method: 'GET',
  match: (url): boolean => url.pathname === '/api/favorites',
  respond: (): { body: object } => ({ body: { favorites: [] } }),
};

/** A route whose responses HANG until release() resolves them all. */
function gateRoute(method: string, pathname: string): {
  route: MockRoute;
  release: (body: object) => Promise<void>;
} {
  const pending: Array<(out: { body: object }) => void> = [];
  return {
    route: {
      method,
      match: (url): boolean => url.pathname === pathname,
      respond: (): Promise<{ body: object }> =>
        new Promise<{ body: object }>((resolve): void => {
          pending.push(resolve);
        }),
    },
    release: (body: object): Promise<void> =>
      new Promise<void>((resolve): void => {
        for (const resolver of pending.splice(0)) {
          resolver({ body });
        }
        resolve();
      }),
  };
}

describe('loading skeletons (UX-AUDIT H-1/B-3/M-6)', (): void => {
  it('SearchHome: skeleton rows while the union search runs, replaced by results', async (): Promise<void> => {
    const search = gateRoute('GET', '/api/search');
    const { fetch } = mockFetch([modulesRoute, search.route]);
    renderWithProviders(<SearchHomePage route={{ name: 'browse', query: { q: 'alpha' } }} />, {
      fetch,
      hash: '#/browse?q=alpha',
    });

    // Pending: 5 skeleton rows in a polite status region (H-1).
    const skeleton = await screen.findByTestId('search-skeleton');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton.getAttribute('role')).toBe('status');
    expect(skeleton.querySelectorAll('.flex.min-h-row')).toHaveLength(5);

    await search.release({
      entries: [
        { ...entryFixture('/a/one', 'Union Alpha'), site: CATALOG_ID, siteName: 'FixtureSite' },
      ],
      facets: [{ siteId: CATALOG_ID, siteName: 'FixtureSite', count: 1 }],
      warnings: [],
      excluded: [],
    });

    // Loaded: content replaces the skeleton (no dead region left).
    await waitFor((): void => {
      expect(screen.getByText('Union Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('search-skeleton')).not.toBeInTheDocument();
  });

  it('Site browse: skeleton rows while the catalog fetches, replaced by entries', async (): Promise<void> => {
    const catalog = gateRoute('GET', `/api/catalog/${CATALOG_ID}/latest`);
    const { fetch } = mockFetch([modulesRoute, catalog.route]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { site: CATALOG_ID } }} />, {
      fetch,
      hash: `#/browse?site=${CATALOG_ID}`,
    });

    const skeleton = await screen.findByTestId('catalog-skeleton');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton.getAttribute('role')).toBe('status');
    expect(skeleton.querySelectorAll('.flex.min-h-row')).toHaveLength(5);

    await catalog.release({
      entries: [entryFixture('/a/one', 'Skeleton Row One')],
      total: 1,
      source: 'catalog',
    });

    await waitFor((): void => {
      expect(screen.getByText('Skeleton Row One')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('catalog-skeleton')).not.toBeInTheDocument();
  });

  it('Manga detail: skeleton card while live info loads, replaced by the loaded card', async (): Promise<void> => {
    const info = gateRoute('POST', '/api/info');
    const { fetch } = mockFetch([info.route, favoritesRoute]);
    renderWithProviders(
      <MangaPage
        route={{ name: 'manga', query: { module: CATALOG_ID, url: 'https://ex.org/manga/x' } }}
      />,
      { fetch, hash: `#/manga?module=${CATALOG_ID}&url=${encodeURIComponent('https://ex.org/manga/x')}` },
    );

    // Pending: the cover+metadata structure preview (M-6) + the
    // screen-reader status line.
    const skeleton = await screen.findByTestId('manga-skeleton');
    expect(skeleton).toBeInTheDocument();
    expect(screen.getByText('Fetching live info…')).toBeInTheDocument();

    await searchReleaseInfo(info, CATALOG_ID);

    await waitFor((): void => {
      expect(screen.getByRole('heading', { name: 'Fixture Manga' })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('manga-skeleton')).not.toBeInTheDocument();
  });
});

/** The manga page fires /api/info twice (live info + downloaded set):
 * the gate resolves every hanging call with the same body. */
function searchReleaseInfo(
  gate: { release: (body: object) => Promise<void> },
  moduleId: string,
): Promise<void> {
  return gate.release(infoFixture({ moduleId }));
}
