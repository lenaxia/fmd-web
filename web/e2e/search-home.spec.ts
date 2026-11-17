/**
 * E2E — search-first home + command palette (R5 web-native IA):
 * `#/browse` with no site param IS the search home — as-you-type union
 * results with Website badges, per-site facet narrowing, the
 * 'Browse sites' toggle (site-first stays the secondary mode), the
 * global '/' focus shortcut (desktop project only — the affordance is
 * desktop-only by design, R3), the Cmd/K command palette (navigate /
 * jump-to-site / recent manga / actions) opened via the VISIBLE header
 * affordance (R3: never keyboard-only), and the shared recents rows.
 *
 * Runs in BOTH projects (desktop + mobile — R3 equal first-class);
 * fully offline (fixture-driven mock API).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi, module as moduleFixture, entries } from './fixtures';

/** A clean (non-broken, enabled) registry so site views can OPEN. */
const cleanModulesBody = {
  modules: [
    {
      ...moduleFixture,
      capabilities: { ...moduleFixture.capabilities, known_broken_flags: [] },
    },
  ],
  count: 1,
};

async function installCleanModules(page: Page): Promise<void> {
  await page.route(/\/api\/modules/, (route: Route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cleanModulesBody),
    });
  });
}

/** Union search mock: one fixture hit, facets naming the site. */
async function installUnionMock(page: Page): Promise<{ searchRequests: string[] }> {
  const searchRequests: string[] = [];
  await page.route(/\/api\/search/, (route: Route): void => {
    const url = new URL(route.request().url());
    searchRequests.push(url.search);
    const q: string = url.searchParams.get('q') ?? '';
    const matched =
      q === '' || q === 'que'
        ? entries.map((entry): unknown => ({
            ...entry,
            site: MODULE_ID,
            siteName: 'FixtureSite',
          }))
        : [];
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: matched,
        facets: matched.length > 0 ? [{ siteId: MODULE_ID, siteName: 'FixtureSite', count: matched.length }] : [],
        warnings: [],
        excluded: [],
      }),
    });
  });
  return { searchRequests };
}

/** POST-counting wrappers over the installMockApi defaults. */
async function installActionSpies(page: Page): Promise<{ syncAllCount: () => number; checkCount: () => number }> {
  let syncAll = 0;
  let check = 0;
  await page.route(/\/api\/sync\/catalog\/all/, (route: Route): void => {
    if (route.request().method() === 'POST') {
      syncAll += 1;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        results: [{ id: CATALOG_ID, state: 'unchanged', dbSha: '01', bytes: 1 }],
      }),
    });
  });
  await page.route(/\/api\/favorites\/check/, (route: Route): void => {
    check += 1;
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ scope: 'all', results: [] }),
    });
  });
  return {
    syncAllCount: (): number => syncAll,
    checkCount: (): number => check,
  };
}

function seedRecents(page: Page): void {
  void page.addInitScript((): void => {
    window.localStorage.setItem(
      'fmd.recent-sites',
      JSON.stringify([{ id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5dd', name: 'RecentlyRead' }]),
    );
    window.localStorage.setItem(
      'fmd.recent-manga',
      JSON.stringify([
        {
          moduleId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
          url: 'https://fixtures.example/manga/alpha',
          title: 'Recent Manga One',
        },
      ]),
    );
  });
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await installMockApi(page);
  await page.route(/^https?:\/\/[^/]+\/api\/readyz$/, (route): Promise<void> => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, reason: 'ready' }),
    });
  });
});

test('search home is the #/browse default: input, Browse-sites toggle, category quick-chips', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/browse');

  // The home — not the picker, not a catalog-id form.
  await expect(page.getByLabel('Search all sites')).toBeVisible();
  await expect(page.getByTestId('recent-sites')).toHaveCount(0); // empty until a site is opened
  await expect(page.getByRole('heading', { name: 'Browse sites' })).toHaveCount(0);

  // Site-first stays one tap away.
  const toggle = page.getByRole('button', { name: /Browse sites/ });
  await expect(toggle).toBeVisible();

  // Empty state: category quick-chips from the module registry
  // (the single fixture module is category 'Fixtures').
  const chips = page.getByTestId('category-quick-chips');
  await expect(chips).toBeVisible();
  await expect(chips.getByRole('button', { name: 'Fixtures' })).toBeVisible();
});

test('typing yields union results with Website badges; a facet chip narrows into the site', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await installCleanModules(page);
  await installUnionMock(page);
  await page.goto('/#/browse');

  const input = page.getByLabel('Search all sites');
  await input.pressSequentially('que', { delay: 60 });

  // Union rows across installed catalogs, each badged with its Website
  // (anchored name: the row's overflow menu is 'Actions for …').
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
  await expect(page.getByTitle('Website: FixtureSite').first()).toBeVisible();

  // The URL carries q (shareable, replace-not-push while typing).
  await expect(page).toHaveURL(/#\/browse\?q=que$/);

  // Facet chip narrows into that site's browse context carrying q.
  await page.getByRole('button', { name: /FixtureSite\s*2/ }).click();
  await expect(page).toHaveURL(new RegExp(`site=${MODULE_ID}`));
  await expect(page).toHaveURL(/q=que/);
  // The site entries view opened (the fixture's known-broken flag is
  // cleared by the clean registry) — deep links still work like today.
  await expect(page.getByText('FixtureSite').first()).toBeVisible();
});

test('Browse sites toggle swaps to the site picker (site-first secondary mode)', async ({
  page,
  isMobile,
}: {
  page: Page;
  isMobile: boolean;
}): Promise<void> => {
  await page.goto('/#/browse');
  await page.getByRole('button', { name: /Browse sites/ }).click();

  // The full picker — unchanged behavior at its new address.
  await expect(page.getByRole('heading', { name: 'Browse sites' })).toBeVisible();
  await expect(page).toHaveURL(/#\/browse\?sites=1$/);
  // The home input is gone (a true view swap, not an overlay).
  await expect(page.getByLabel('Search all sites')).toHaveCount(0);
  // Mobile chrome (R3): the picker's filters collapse into the Sheet
  // behind the visible Filters button; desktop renders them inline.
  if (isMobile) {
    await page.getByRole('button', { name: 'Filters' }).click();
  }
  await expect(page.getByLabel('Search sites')).toBeVisible();
});

test("'/' focuses the search home from anywhere; Esc blurs (desktop affordance)", async ({
  page,
  isMobile,
}: {
  page: Page;
  isMobile: boolean;
}): Promise<void> => {
  test.skip(isMobile === true, 'desktop-only affordance — mobile reaches search via the visible input (R3)');

  // From ANOTHER page: '/' navigates to the search home AND focuses.
  await page.goto('/#/downloads');
  await page.keyboard.press('/');
  await expect(page).toHaveURL(/#\/browse$/);
  await expect(page.locator('#home-search')).toBeFocused();

  // Esc blurs the input.
  await page.keyboard.press('Escape');
  await expect(page.locator('#home-search')).not.toBeFocused();

  // From a ?site= deep link: '/' leaves the site context (back
  // restores it) and lands focused on the home input.
  await page.goto(`/#/browse?site=${CATALOG_ID}`);
  await page.keyboard.press('/');
  await expect(page.locator('#home-search')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`site=${CATALOG_ID}`));

  // Typing guard: '/' inside another input is a literal character (the
  // picker's own search box is a stable, always-enabled target).
  await page.goto('/#/browse?sites=1');
  const pickerSearch = page.getByLabel('Search sites');
  await pickerSearch.click();
  await page.keyboard.press('/');
  await expect(page).toHaveURL(/#\/browse\?sites=1$/);
  await expect(pickerSearch).toHaveValue('/');
});

test('Cmd/Ctrl+K opens the palette; a navigate item routes (query resets on reopen)', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/browse');

  // The VISIBLE affordance (R3 — this is the mobile path too).
  await page.getByRole('button', { name: 'Open command palette' }).click();
  const input = page.getByTestId('palette-input');
  await expect(input).toBeVisible();

  // The query is ephemeral: type, close, reopen — input is empty again.
  await input.fill('favor');
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('');

  // Navigate action.
  await page.getByTestId('palette-nav-favorites').click();
  await expect(page).toHaveURL(/#\/favorites$/);
  await expect(input).toHaveCount(0); // closed after executing
});

test('palette jump-to-site: searches the registry by name and opens the site', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await installCleanModules(page);
  await page.goto('/#/browse');
  await page.getByRole('button', { name: 'Open command palette' }).click();

  const input = page.getByTestId('palette-input');
  await input.fill('Fixture');
  const siteItem = page.getByTestId('palette-site').filter({ hasText: 'FixtureSite' });
  await expect(siteItem).toBeVisible();
  await siteItem.click();

  await expect(page).toHaveURL(new RegExp(`#/browse\\?site=${MODULE_ID}`));
  await expect(page.getByText('FixtureSite').first()).toBeVisible();
});

test('palette actions execute: Toggle theme flips, Sync all catalogs + favorites check fire (mock)', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  // Deterministic theme baseline (headless Chrome's prefers-color-scheme
  // is light — the app would otherwise start light, not dark).
  await page.addInitScript((): void => {
    window.localStorage.setItem('fmd-web-theme', 'dark');
  });
  const spies = await installActionSpies(page);
  await page.goto('/#/browse');

  // Action 1 — Toggle theme: the html class flips (dark default).
  await expect(page.locator('html')).toHaveClass(/^.*\bdark\b.*$/);
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByTestId('palette-action-toggle-theme').click();
  await expect(page.locator('html')).toHaveClass(/^.*\blight\b.*$/);

  // Action 2 — Sync all catalogs: the POST fires (mocked response).
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByTestId('palette-action-sync-all').click();
  await expect
    .poll((): number => spies.syncAllCount())
    .toBeGreaterThanOrEqual(1);

  // Action 3 — Check favorites for new chapters: the batch POST fires.
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByTestId('palette-action-check-favorites').click();
  await expect
    .poll((): number => spies.checkCount())
    .toBeGreaterThanOrEqual(1);
});

test('recents: site opens + manga opens feed the shared store; rows render, clear, and the palette consumes them', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  seedRecents(page);
  await installCleanModules(page);
  await page.goto('/#/browse');

  // Seeded rows render on the home (capped, deduped by the store).
  await expect(page.getByTestId('recent-sites').getByRole('button', { name: 'RecentlyRead' })).toBeVisible();
  await expect(page.getByTestId('recent-manga').getByRole('button', { name: 'Recent Manga One' })).toBeVisible();

  // The palette consumes the SAME store.
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await expect(page.getByTestId('palette-recent-manga').filter({ hasText: 'Recent Manga One' })).toBeVisible();
  await page.keyboard.press('Escape');

  // A recent-manga chip reopens the exact deep link.
  await page.getByTestId('recent-manga').getByRole('button', { name: 'Recent Manga One' }).click();
  await expect(page).toHaveURL(/#\/manga\?/);
  await page.goBack();

  // Clear (home owns the affordance) — the row AND the palette group
  // reflect the cleared store.
  await page.getByTestId('recent-manga').getByRole('button', { name: 'Clear recent manga' }).click();
  await expect(page.getByTestId('recent-manga')).toHaveCount(0);
  await page.getByTestId('recent-sites').getByRole('button', { name: 'Clear recent sites' }).click();
  await expect(page.getByTestId('recent-sites')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open command palette' }).click();
  await expect(page.getByTestId('palette-recent-manga')).toHaveCount(0);
});
