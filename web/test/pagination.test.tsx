// @vitest-environment jsdom
/**
 * Browse pagination component tests — CURSOR HANDLING: page-mode
 * (latest) requests `page=1,2,…`; search mode sends the server's
 * opaque `nextCursor` back verbatim and stops when it is absent.
 */
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowsePage } from '../src/pages/BrowsePage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { CATALOG_ID, entryFixture } from './fixtures';
import { parseHash } from '../src/router';

autoCleanup();

/** Site-first browse: the registry must resolve before entries open. */
const modulesRoute: MockRoute = {
  method: 'GET',
  match: (url): boolean => url.pathname === '/api/modules',
  respond: (): { body: object } => ({ body: { modules: [], count: 0 } }),
};

/**
 * R5 arrival: renderWithProviders mounts the app shell's
 * JobsActivityProvider, whose activity query fires one
 * /api/jobs?…states=queued,running request per render. These
 * assertions cover PAGE-level fetching — the shell feed is not the
 * page under test, so it is filtered out of the exact lists.
 */
const pageRequests = (requests: readonly { method: string; path: string }[]): { method: string; path: string }[] =>
  requests.filter((r): boolean => !r.path.startsWith('/api/jobs?'));

function latestRoute(page: number, bodies: { status?: number; body: object }): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean =>
      /^\/api\/catalog\/[0-9a-f]{32}\/latest$/.test(url.pathname) &&
      url.searchParams.get('page') === String(page),
    respond: (): { status?: number; body: object } => bodies,
  };
}

const routes: MockRoute[] = [
  modulesRoute,
  latestRoute(1, {
    body: {
      entries: [entryFixture('/a', 'Alpha'), entryFixture('/b', 'Beta')],
      total: 3,
    },
  }),
  latestRoute(2, {
    body: {
      entries: [entryFixture('/c', 'Gamma')],
      total: 3,
    },
  }),
  {
    method: 'GET',
    match: (url): boolean =>
      /^\/api\/catalog\/[0-9a-f]{32}\/search$/.test(url.pathname),
    respond: (url): { status?: number; body: object } => {
      const cursor = url.searchParams.get('cursor');
      if (cursor === null) {
        return { body: { entries: [entryFixture('/s1', 'Search One')], nextCursor: 'c1' } };
      }
      if (cursor === 'c1') {
        return { body: { entries: [entryFixture('/s2', 'Search Two')] } };
      }
      return { status: 404, body: { error: { code: 'bad_request', message: 'bad cursor' } } };
    },
  },
];

describe('BrowsePage pagination', (): void => {
  it('latest mode walks page numbers and appends entries', async (): Promise<void> => {
    const { fetch, requests } = mockFetch(routes);
    renderWithProviders(<BrowsePage route={parseHash(`#/browse?catalog=${CATALOG_ID}`)} />, { fetch, hash: `#/browse?catalog=${CATALOG_ID}` });

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Gamma')).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 3 entries/)).toBeInTheDocument();

    const latestCalls = requests.filter((r): boolean => r.path.startsWith('/api/catalog/') && r.path.includes('/latest'));
    expect(latestCalls.map((r): string => r.path)).toEqual([
      `/api/catalog/${CATALOG_ID}/latest?page=1&limit=20`,
      `/api/catalog/${CATALOG_ID}/latest?page=2&limit=20`,
    ]);
    // exhausted → no more Load more button
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('live search: debounced q hits /search and walks the opaque cursor', async (): Promise<void> => {
    const { fetch, requests } = mockFetch(routes);
    renderWithProviders(<BrowsePage route={parseHash(`#/browse?catalog=${CATALOG_ID}`)} />, { fetch, hash: `#/browse?catalog=${CATALOG_ID}` });
    await screen.findByText('Alpha');

    // As-you-type: the debounced fetch fires with q=fix (250ms < 1s).
    await userEvent.type(screen.getByLabelText('Search'), 'fix');

    expect(await screen.findByText('Search One', {}, { timeout: 3000 })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Search Two')).toBeInTheDocument();
    // cursor exhausted (no nextCursor in page 2) → button gone
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    const searchCalls = requests.filter((r): boolean => r.path.includes('/search'));
    expect(searchCalls.map((r): string => r.path)).toEqual([
      `/api/catalog/${CATALOG_ID}/search?q=fix&limit=20&genresMode=all`,
      `/api/catalog/${CATALOG_ID}/search?q=fix&limit=20&genresMode=all&cursor=c1`,
    ]);
  });

  it('bare browse renders the SEARCH home; ?sites=1 renders the site picker (search-first IA)', async (): Promise<void> => {
    // The default #/browse is the search-first home (R5): union search
    // over every installed catalog — NOT the picker.
    const { fetch: homeFetch, requests: homeRequests } = mockFetch([modulesRoute]);
    renderWithProviders(<BrowsePage route={parseHash('#/browse')} />, {
      fetch: homeFetch,
      hash: '#/browse',
    });
    expect(await screen.findByLabelText('Search all sites')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Browse sites/ })).toBeInTheDocument();
    expect(pageRequests(homeRequests).map((r): string => r.path)).toEqual(['/api/modules']);
  });

  it('?sites=1 renders the site picker (hex-ID empty state deleted with CatalogIdForm)', async (): Promise<void> => {
    const { fetch, requests } = mockFetch([modulesRoute]);
    renderWithProviders(<BrowsePage route={parseHash('#/browse?sites=1')} />, {
      fetch,
      hash: '#/browse?sites=1',
    });
    expect(await screen.findByText('Browse sites')).toBeInTheDocument();
    expect(screen.getByLabelText('Search sites')).toBeInTheDocument();
    // The hex-ID form contract is gone: no catalog-id input; the only
    // 'Open' button is open-by-URL ([parity-sweep] M14), never the old
    // catalog-id form.
    expect(screen.queryByLabelText('Catalog id')).toBeNull();
    const openButtons = screen.getAllByRole('button', { name: 'Open' });
    expect(openButtons).toHaveLength(1);
    const openButton: HTMLElement | undefined = openButtons.at(0);
    expect(openButton).toBeDefined();
    expect(openButton?.closest('[data-testid="open-by-url"]')).not.toBeNull();
    // The picker fetches the module registry (not catalog entries).
    expect(pageRequests(requests).map((r): string => r.path)).toEqual(['/api/modules']);
  });

  it('badges the serving channel: muted source badge when the page came from the site', async (): Promise<void> => {
    const { fetch } = mockFetch([
      modulesRoute,
      latestRoute(1, { body: { entries: [entryFixture('/live', 'LiveEntry')], source: 'live' } }),
    ]);
    renderWithProviders(<BrowsePage route={parseHash(`#/browse?catalog=${CATALOG_ID}`)} />, { fetch, hash: `#/browse?catalog=${CATALOG_ID}` });
    expect(await screen.findByRole('list')).toBeInTheDocument();
    expect(screen.getByTitle('List fetched live from the site')).toHaveTextContent('from site');
  });

  it('badges prebuilt pages with the muted "from catalog" source badge', async (): Promise<void> => {
    const { fetch } = mockFetch([
      modulesRoute,
      latestRoute(1, { body: { entries: [entryFixture('/cat', 'CatEntry')], source: 'catalog' } }),
    ]);
    renderWithProviders(<BrowsePage route={parseHash(`#/browse?catalog=${CATALOG_ID}`)} />, { fetch, hash: `#/browse?catalog=${CATALOG_ID}` });
    expect(await screen.findByRole('list')).toBeInTheDocument();
    expect(screen.getByTitle('Prebuilt list from FMD2-DB')).toHaveTextContent('from catalog');
  });

  it('entry rows navigate to the manga detail route', async (): Promise<void> => {
    const { fetch } = mockFetch([
      modulesRoute,
      latestRoute(1, { body: { entries: [entryFixture('/a', 'Alpha')] } }),
    ]);
    renderWithProviders(<BrowsePage route={parseHash(`#/browse?catalog=${CATALOG_ID}`)} />, { fetch, hash: `#/browse?catalog=${CATALOG_ID}` });
    const list = await screen.findByRole('list');
    const row = within(list).getByRole('button', { name: /^Alpha/ });
    expect(row).toBeInTheDocument();
    await userEvent.click(row);
    expect(globalThis.location.hash).toBe(
      `#/manga?catalog=${CATALOG_ID}&module=${CATALOG_ID}&url=%2Fa&title=Alpha`,
    );
  });
});
