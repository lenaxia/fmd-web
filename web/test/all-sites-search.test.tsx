/**
 * All-sites union search UI (FMD2 cbSearchFromAllSites parity):
 * the All-sites toggle routes site-browse ⇄ the union view
 * (#/browse?allsites=1), the union view renders merged rows with a
 * Website badge each (frmMain.pas:5170 parity), per-site facet chips,
 * typed warning chips for failed catalogs, no-catalog chips for
 * excluded sites, and row clicks deep-link into the source site's
 * manga context.
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowsePage } from '../src/pages/BrowsePage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { CATALOG_ID, entryFixture, moduleFixture } from './fixtures';

autoCleanup();

const SITE_A = 'a'.repeat(32);
const SITE_B = 'b'.repeat(32);
const SITE_C = 'c'.repeat(32); // enabled, NO catalog
const SITE_D = 'd'.repeat(32); // installed but its search fails

const modulesRoute: MockRoute = {
  method: 'GET',
  match: (url): boolean => url.pathname === '/api/modules',
  respond: (): { body: object } => ({
    body: {
      modules: [
        moduleFixture({ id: SITE_A, name: 'SiteA Manga' }),
        moduleFixture({ id: SITE_B, name: 'SiteB Manga' }),
        moduleFixture({ id: SITE_C, name: 'SiteC NoCatalog', catalogInstalled: false }),
        moduleFixture({ id: SITE_D, name: 'SiteD Manga' }),
      ],
      count: 4,
    },
  }),
};

const latestRoute: MockRoute = {
  method: 'GET',
  match: (url): boolean => /^\/api\/catalog\/[0-9a-f]{32}\/(latest|search)$/.test(url.pathname),
  respond: (): { body: object } => ({
    body: { entries: [entryFixture('/a/one', 'SiteA Local Row')], total: 1, source: 'catalog' },
  }),
};

/** GET /api/search double: two sites answer, one fails, one excluded. */
function searchRoute(requests: string[]): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/search',
    respond: (url): { body: object } => {
      requests.push(url.search);
      return {
        body: {
          entries: [
            { ...entryFixture('/a/union', 'Union Alpha'), site: SITE_A, siteName: 'SiteA Manga' },
            { ...entryFixture('/b/union', 'Union Beta'), site: SITE_B, siteName: 'SiteB Manga' },
          ],
          facets: [
            { siteId: SITE_A, siteName: 'SiteA Manga', count: 1 },
            { siteId: SITE_B, siteName: 'SiteB Manga', count: 2 },
          ],
          warnings: [
            { siteId: SITE_D, siteName: 'SiteD Manga', error: 'file is not a database' },
          ],
          excluded: [{ siteId: SITE_C, siteName: 'SiteC NoCatalog', reason: 'no-catalog' }],
        },
      };
    },
  };
}

describe('All-sites union search UI', () => {
  it('the All-sites toggle in the site search bar switches to the union view (carrying the query)', async () => {
    const requests: string[] = [];
    const { fetch } = mockFetch([modulesRoute, latestRoute, searchRoute(requests)]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { site: SITE_A, q: 'union' } }} />, {
      fetch,
      hash: `#/browse?site=${SITE_A}&q=union`,
    });
    const user = userEvent.setup();
    await waitFor((): void => {
      expect(screen.getByRole('button', { name: /^SiteA Local Row/ })).toBeVisible();
    });

    await user.click(screen.getByRole('checkbox', { name: /All sites/ }));
    await waitFor((): void => {
      expect(globalThis.location.hash).toBe(`#/browse?allsites=1&q=union`);
    });

    // The union fired: merged rows from BOTH sites, each badged with
    // its Website (FMD2 hint :5170 parity).
    await waitFor((): void => {
      expect(screen.getByRole('button', { name: /^Union Alpha/ })).toBeVisible();
      expect(screen.getByRole('button', { name: /^Union Beta/ })).toBeVisible();
    });
    expect(screen.getByTitle('Website: SiteA Manga')).toBeVisible();
    expect(screen.getByTitle('Website: SiteB Manga')).toBeVisible();
    expect(requests.some((s) => s.includes('q=union'))).toBe(true);
  });

  it('the union view surfaces facet chips, the failed-site warning chip and the no-catalog excluded chip', async () => {
    const { fetch } = mockFetch([modulesRoute, searchRoute([])]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { allsites: '1', q: 'union' } }} />, {
      fetch,
      hash: '#/browse?allsites=1&q=union',
    });

    await waitFor((): void => {
      expect(screen.getByRole('button', { name: /^Union Alpha/ })).toBeVisible();
    });
    // Facet chips: per-site counts (site NAME — never the hex id).
    expect(screen.getByRole('button', { name: /^SiteA Manga\s*1/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /^SiteB Manga\s*2/ })).toBeVisible();
    // Typed partial failure: the broken site is NAMED, never silent.
    expect(screen.getByText('SiteD Manga didn’t answer')).toBeVisible();
    // Installed-only semantics explained in the UI.
    expect(screen.getByText(/SiteC NoCatalog: no catalog installed/)).toBeVisible();
  });

  it('a row click deep-links into the source site\'s manga context (unchanged link shape)', async () => {
    const { fetch } = mockFetch([modulesRoute, searchRoute([])]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { allsites: '1', q: 'union' } }} />, {
      fetch,
      hash: '#/browse?allsites=1&q=union',
    });
    const user = userEvent.setup();
    await waitFor((): void => {
      expect(screen.getByRole('button', { name: /^Union Beta/ })).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: /^Union Beta/ }));
    const hash = globalThis.location.hash;
    expect(hash).toContain('#/manga?');
    expect(hash).toContain(`module=${SITE_B}`);
    expect(hash).toContain(`catalog=${SITE_B}`);
    expect(hash).toContain('url=');
  });

  it('a facet chip click routes into that site\'s browse context carrying the query', async () => {
    const { fetch } = mockFetch([modulesRoute, searchRoute([])]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { allsites: '1', q: 'union' } }} />, {
      fetch,
      hash: '#/browse?allsites=1&q=union',
    });
    const user = userEvent.setup();
    await waitFor((): void => {
      expect(screen.getByRole('button', { name: /^SiteB Manga\s*2/ })).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: /^SiteB Manga\s*2/ }));
    await waitFor((): void => {
      expect(globalThis.location.hash).toBe(`#/browse?site=${SITE_B}&q=union`);
    });
  });

  it('toggling All sites off returns to the site picker; typing replaces the URL shareably', async () => {
    const requests: string[] = [];
    const { fetch } = mockFetch([modulesRoute, searchRoute(requests)]);
    renderWithProviders(<BrowsePage route={{ name: 'browse', query: { allsites: '1', q: 'un' } }} />, {
      fetch,
      hash: '#/browse?allsites=1&q=un',
    });
    const user = userEvent.setup();

    // Typing edits q via REPLACE (no history spam) — the URL carries
    // the live query text.
    const input = screen.getByLabelText('Search');
    await user.type(input, 'ion');
    await waitFor((): void => {
      expect(globalThis.location.hash).toBe('#/browse?allsites=1&q=union');
    });

    // Toggle off → back to the picker (no allsites flag).
    await user.click(screen.getByRole('checkbox', { name: /All sites/ }));
    await waitFor((): void => {
      expect(globalThis.location.hash).toBe('#/browse');
    });
    void CATALOG_ID;
  });
});
