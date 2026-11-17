// @vitest-environment jsdom
/**
 * Browse entries view as a pure function of the URL-synced filter
 * state (tsk-savvy-jockey-ambles): as-you-type live search REPLACES
 * the URL (no history spam) and fetches debounced with the composed
 * filter params; discrete filter applications PUSH (chips/panel);
 * the count/mode label carries FMD2 lbMode parity.
 *
 * Renders seed the LIVE hash (renderWithProviders { hash }) — useRoute
 * parses globalThis.location.hash on mount, so jsdom must start on the
 * URL under test (production always mounts on a real hash).
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowsePage } from '../src/pages/BrowsePage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { CATALOG_ID, entryFixture } from './fixtures';
import { parseHash } from '../src/router';

autoCleanup();

const SITE_HASH = `#/browse?site=${CATALOG_ID}`;

const modulesRoute: MockRoute = {
  method: 'GET',
  match: (url): boolean => url.pathname === '/api/modules',
  respond: (): { body: object } => ({ body: { modules: [], count: 0 } }),
};

const latestRoute: MockRoute = {
  method: 'GET',
  match: (url): boolean => /^\/api\/catalog\/[0-9a-f]{32}\/latest$/.test(url.pathname),
  respond: (): { body: object } => ({
    body: { entries: [entryFixture('/l1', 'Latest One'), entryFixture('/l2', 'Latest Two')], total: 2 },
  }),
};

/** Search double: filters by q/status/genres server-side semantics. */
const searchRoute: MockRoute = {
  method: 'GET',
  match: (url): boolean => /^\/api\/catalog\/[0-9a-f]{32}\/search$/.test(url.pathname),
  respond: (url): { body: object } => {
    const q: string = url.searchParams.get('q') ?? '';
    const status: string = url.searchParams.get('status') ?? '';
    const genres: string[] = url.searchParams.getAll('genres');
    const genresMode: string = url.searchParams.get('genresMode') ?? 'all';
    const authors: string = url.searchParams.get('authors') ?? '';
    const all = [
      entryFixture('/s1', 'Alpha Action', { status: 'Ongoing', genres: 'Action, Comedy', authors: 'Aka' }),
      entryFixture('/s2', 'Beta Drama', { status: 'Completed', genres: 'Drama', authors: 'Ao' }),
      entryFixture('/s3', 'Gamma Mix', { status: 'Ongoing', genres: 'Action, Drama', authors: 'Aka' }),
    ];
    const filtered = all.filter((e) => {
      if (q !== '' && !e.title.toLowerCase().includes(q.toLowerCase())) return false;
      if (status !== '' && e.status !== status) return false;
      if (authors !== '' && !(e.authors ?? '').toLowerCase().includes(authors.toLowerCase())) return false;
      if (genres.length > 0) {
        const hits = genres.map((g) => (e.genres ?? '').includes(g));
        if (!(genresMode === 'any' ? hits.some(Boolean) : hits.every(Boolean))) return false;
      }
      return true;
    });
    return { body: { entries: filtered, total: filtered.length } };
  },
};

const routes: MockRoute[] = [modulesRoute, latestRoute, searchRoute];

function hash(): string {
  // decodeURIComponent: routeToHash percent-encodes list separators
  // (',' → %2C) — assertions read the decoded form.
  return decodeURIComponent(globalThis.location.hash);
}

describe('BrowsePage live search + URL sync', (): void => {
  it('latest view renders and the mode label shows All-style count (lbMode parity)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes);
    renderWithProviders(<BrowsePage route={parseHash(SITE_HASH)} />, { fetch, hash: SITE_HASH });
    expect(await screen.findByText('Latest One')).toBeInTheDocument();
    // lbMode parity: the SearchBar status line names the current mode
    // (anchored with the count so the 'Latest' TAB never collides).
    expect(screen.getByText(/^Latest \(\d+\)$/)).toBeInTheDocument();
  });

  it('typing updates the URL (REPLACE) and fires ONE debounced search for the final text', async (): Promise<void> => {
    const { fetch, requests } = mockFetch(routes);
    renderWithProviders(<BrowsePage route={parseHash(SITE_HASH)} />, { fetch, hash: SITE_HASH });
    await screen.findByText('Latest One');

    const input = screen.getByLabelText('Search');
    await userEvent.type(input, 'al');
    await userEvent.type(input, 'pha');

    // URL stays current while typing (q param present)…
    await waitFor((): void => {
      expect(hash()).toContain('q=alpha');
    });
    // …and the debounced search lands with the final text only.
    expect(await screen.findByText('Alpha Action')).toBeInTheDocument();

    const searchCalls = requests.filter((r): boolean => r.path.includes('/search'));
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);
    expect(searchCalls.every((r): boolean => r.path.includes('q=alpha'))).toBe(true);
    expect(searchCalls.some((r): boolean => r.path.includes('q=a') && !r.path.includes('alpha'))).toBe(false);
  });

  it('applying a genre filter PUSHES the URL and searches with genres+mode (ALL default)', async (): Promise<void> => {
    const { fetch, requests } = mockFetch(routes);
    renderWithProviders(<BrowsePage route={parseHash(SITE_HASH)} />, { fetch, hash: SITE_HASH });
    await screen.findByText('Latest One');

    await userEvent.click(screen.getByRole('button', { name: /Filters/ }));
    // One URL hop per click: wait for the async hashchange round-trip
    // (and re-query) between clicks — under a loaded parallel run the
    // re-render can land mid-click and detach the checkbox node.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Action' }));
    await waitFor((): void => {
      expect(hash()).toContain('genres=Action');
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Drama' }));

    // URL pushed with genres + implicit mode=all; chip row reflects it.
    await waitFor((): void => {
      expect(hash()).toContain('genres=Action,Drama');
    });
    expect(await screen.findByText(/All of: Action, Drama/)).toBeInTheDocument();

    // ALL semantics: only Gamma Mix carries both Action and Drama.
    expect(await screen.findByText('Gamma Mix')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Action')).not.toBeInTheDocument();

    const call = requests.find((r): boolean => r.path.includes('genres=Action') && r.path.includes('genres=Drama'));
    expect(call).toBeDefined();
    expect(call?.path).toContain('genresMode=all');

    // Removing the chip is another discrete push (back/forward correct).
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter: All of: Action, Drama' }));
    await waitFor((): void => {
      expect(hash()).not.toContain('genres=');
    });
    expect(await screen.findByText('Latest One')).toBeInTheDocument();
  });

  it('status + authors + ANY mode compose into the search request', async (): Promise<void> => {
    const { fetch, requests } = mockFetch(routes);
    renderWithProviders(<BrowsePage route={parseHash(SITE_HASH)} />, { fetch, hash: SITE_HASH });
    await screen.findByText('Latest One');

    await userEvent.click(screen.getByRole('button', { name: /Filters/ }));
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'Ongoing');
    await userEvent.type(screen.getByLabelText('Authors'), 'aka');

    await waitFor((): void => {
      expect(hash()).toContain('status=Ongoing');
    });
    expect(hash()).toContain('authors=aka');

    // ANY of [Action, Drama] + Ongoing + author contains 'aka' → Alpha Action & Gamma Mix.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Action' }));
    await waitFor((): void => {
      expect(hash()).toContain('genres=Action');
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Drama' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Any of' }));

    await waitFor((): void => {
      expect(hash()).toContain('mode=any');
    });
    expect(await screen.findByText('Alpha Action')).toBeInTheDocument();
    expect(screen.getByText('Gamma Mix')).toBeInTheDocument();
    expect(screen.queryByText('Beta Drama')).not.toBeInTheDocument();

    const call = requests.find((r): boolean => r.path.includes('mode=any') || r.path.includes('genresMode=any'));
    expect(call?.path).toContain('status=Ongoing');
    expect(call?.path).toContain('authors=aka');
  });

  it('a shared URL with filters deep-links straight into the filtered results', async (): Promise<void> => {
    const { fetch } = mockFetch(routes);
    const deepLink = `#/browse?site=${CATALOG_ID}&q=&genres=Drama&mode=any`;
    renderWithProviders(<BrowsePage route={parseHash(deepLink)} />, { fetch, hash: deepLink });
    expect(await screen.findByText('Beta Drama')).toBeInTheDocument();
    expect(screen.getByText('Gamma Mix')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Action')).not.toBeInTheDocument();
    expect(screen.getByText(/Any of: Drama/)).toBeInTheDocument();
  });

  it('reset clears every filter param (push)', async (): Promise<void> => {
    const { fetch } = mockFetch(routes);
    const seeded = `#/browse?site=${CATALOG_ID}&q=al&status=Ongoing`;
    renderWithProviders(<BrowsePage route={parseHash(seeded)} />, { fetch, hash: seeded });
    await screen.findByText('Alpha Action');

    await userEvent.click(screen.getByRole('button', { name: /Filters/ }));
    await userEvent.click(screen.getByRole('button', { name: /Reset filters/ }));

    await waitFor((): void => {
      expect(hash()).not.toContain('q=');
    });
    expect(hash()).not.toContain('status=');
    expect(await screen.findByText('Latest One')).toBeInTheDocument();
  });
});
