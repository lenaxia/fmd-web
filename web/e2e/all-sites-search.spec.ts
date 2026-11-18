/**
 * E2E — all-sites union search (FMD2 cbSearchFromAllSites parity):
 * with TWO installed mock catalogs (plus one failing site and one
 * catalog-less site), the All-sites toggle switches the search bar
 * into union mode; the union returns MERGED rows from both catalogs,
 * each badged with its Website; per-site facet chips, the failed-site
 * warning chip and the no-catalog excluded chip render; a row click
 * routes into the source site's manga context. Fully offline
 * (fixture-driven mock API).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi, module as moduleFixture, entries } from './fixtures';

/** Second installed site + a catalog-less site + a failing site. */
const SITE_B_ID = 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const SITE_C_ID = 'c1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // catalog-less (excluded chip)
const SITE_D_ID = 'd1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // installed, search fails (warning chip)

const modulesBody = {
  modules: [
    { ...moduleFixture, id: MODULE_ID, name: 'FixtureSite' },
    { ...moduleFixture, id: SITE_B_ID, name: 'BetaSite' },
    { ...moduleFixture, id: SITE_C_ID, name: 'GammaNoCatalog', catalogInstalled: false },
    { ...moduleFixture, id: SITE_D_ID, name: 'DeltaBroken' },
  ],
  count: 4,
};

const unionBody = (q: string): object => ({
  entries: [
    {
      ...entries[0],
      title: q !== '' ? `Alpha Quest` : 'Alpha Quest',
      site: MODULE_ID,
      siteName: 'FixtureSite',
    },
    { ...entries[1], title: 'Beta Trails', site: SITE_B_ID, siteName: 'BetaSite' },
    {
      link: '/manga/beta-extra',
      title: 'Beta Extra',
      alttitles: '',
      authors: 'Author B',
      artists: '',
      genres: 'Drama',
      status: 'Complete',
      summary: '',
      numChapter: 3,
      jdn: 3,
      site: SITE_B_ID,
      siteName: 'BetaSite',
    },
  ],
  facets: [
    { siteId: MODULE_ID, siteName: 'FixtureSite', count: 1 },
    { siteId: SITE_B_ID, siteName: 'BetaSite', count: 2 },
  ],
  warnings: [{ siteId: SITE_D_ID, siteName: 'DeltaBroken', error: 'file is not a database' }],
  excluded: [{ siteId: SITE_C_ID, siteName: 'GammaNoCatalog', reason: 'no-catalog' }],
});

/** Layered OVER installMockApi (later routes win): /api/modules with
 * the multi-site fixture set + GET /api/search. */
async function installUnionMock(page: Page): Promise<{ searchRequests: string[] }> {
  const searchRequests: string[] = [];
  await page.route(/\/api\/modules/, (route: Route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(modulesBody),
    });
  });
  await page.route(/\/api\/search/, (route: Route): void => {
    const url = new URL(route.request().url());
    searchRequests.push(url.search);
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(unionBody(url.searchParams.get('q') ?? '')),
    });
  });
  return { searchRequests };
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await installMockApi(page);
});

test('all-sites toggle: union over two installed catalogs — merged rows, Website badges, chips, site-context routing', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  const { searchRequests } = await installUnionMock(page);
  await page.goto(`/#/browse?site=${CATALOG_ID}`);
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();

  // Toggle "All sites" in the search bar → union view (URL carries the
  // mode; FMD2 cbSearchFromAllSites parity). click, not check(): the
  // toggle navigates immediately, detaching the control before check()
  // could re-assert its state.
  await page.getByRole('checkbox', { name: /All sites/ }).click();
  await expect(page).toHaveURL(/allsites=1/);
  // Deterministic gate BEFORE typing: the union view must be MOUNTED,
  // not just the URL updated — the hash mutation and React's re-render
  // are decoupled (navigate's notification is same-tick, but the
  // assertion pins the contract). The site view carries an
  // identically-named searchbox whose typing would navigate BACK to
  // site-scoped mode.
  await expect(page.getByRole('region', { name: 'All-sites search' })).toBeVisible();

  // Type a query — merged results from BOTH installed catalogs, each
  // row badged with its Website.
  await page.getByRole('searchbox', { name: 'Search' }).fill('quest');
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Beta Trails/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Beta Extra/ })).toBeVisible();
  // Two rows come from BetaSite — both carry its badge (count, not
  // strict single-element visibility).
  await expect(page.getByTitle('Website: FixtureSite')).toBeVisible();
  expect(await page.getByTitle('Website: BetaSite').count()).toBeGreaterThanOrEqual(2);

  // The union request fired against /api/search with the typed q.
  await expect
    .poll((): number => searchRequests.filter((s) => s.includes('q=quest')).length)
    .toBeGreaterThanOrEqual(1);

  // Facet chips: per-site counts (site names, never hex ids).
  await expect(page.getByRole('button', { name: /FixtureSite\s*1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /BetaSite\s*2/ })).toBeVisible();

  // Typed partial failure + installed-only semantics, surfaced as chips.
  await expect(page.getByText('DeltaBroken didn’t answer')).toBeVisible();
  await expect(page.getByText(/GammaNoCatalog: no catalog installed/)).toBeVisible();

  // Routing: a BetaSite row click deep-links into THAT site's context
  // (manga link shape unchanged).
  await page.getByRole('button', { name: /^Beta Trails/ }).click();
  await expect(page).toHaveURL(/#\/manga\?/);
  await expect(page).toHaveURL(new RegExp(`module=${SITE_B_ID}`));

  // Facet chip routes into the site's browse context carrying the query.
  await page.goBack();
  await page.getByRole('button', { name: /BetaSite\s*2/ }).click();
  await expect(page).toHaveURL(new RegExp(`site=${SITE_B_ID}`));
  await expect(page).toHaveURL(/q=quest/);
});
