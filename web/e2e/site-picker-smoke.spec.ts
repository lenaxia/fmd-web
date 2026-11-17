/**
 * Playwright e2e — SITE-FIRST BROWSE (FMD2 cbSelectManga parity):
 * picker by NAME with the category facet chips (?cats= URL-synced,
 * single/multi/All + persistence) → auto-provision (mock FMD2-DB
 * catalog, WS-driven progress) → entries → manga deep-link; cancel;
 * the UNIFIED browsing model — a catalog-less directory-capable site
 * opens via the automatic live fallback with ONE progress experience
 * and the muted 'from site' badge, with NO mode vocabulary
 * ('live browse'/'scrape') anywhere in the DOM; known-broken rows
 * disabled with reason; hex module ids NEVER rendered (they ride the
 * URL only). Fully offline: loopback + intercepted routes/sockets.
 */
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { installMockApi, module, type ModuleSummaryT } from './fixtures';

const INSTALLED_ID = '1'.repeat(32);
const FRESH_ID = '2'.repeat(32);
const BROKEN_ID = '3'.repeat(32);
const NOCATALOG_ID = '4'.repeat(32);
const SPANISH_ID = '5'.repeat(32);

const HEX32 = /[0-9a-f]{32}/;

function site(overrides: Partial<ModuleSummaryT> & { id: string; name: string }): ModuleSummaryT {
  return {
    ...module,
    options: [],
    capabilities: { ...module.capabilities, known_broken_flags: [], requires_browser: false, live_scrape_fallback: false },
    catalogInstalled: true,
    ...overrides,
  };
}

/** The picker registry: installed, fresh (provisionable, live-capable),
 * known-broken, a 404-catalog site (live-capable), and a Spanish site
 * (the language facet). */
function pickerModules(freshInstalled: boolean): ModuleSummaryT[] {
  return [
    site({ id: INSTALLED_ID, name: 'MangaRock', category: 'Manga', catalogInstalled: true }),
    site({
      id: FRESH_ID,
      name: 'ManhuaFresh',
      category: 'Manhua',
      catalogInstalled: freshInstalled,
      capabilities: { ...module.capabilities, known_broken_flags: [], requires_browser: false, live_scrape_fallback: true },
    }),
    site({
      id: BROKEN_ID,
      name: 'BrokenScan',
      category: 'Manga',
      catalogInstalled: true,
      capabilities: { ...module.capabilities, known_broken_flags: ['cloudflare-loop'], requires_browser: false, live_scrape_fallback: false },
    }),
    site({
      id: NOCATALOG_ID,
      name: 'NoCatalogSite',
      category: 'Manga',
      catalogInstalled: false,
      capabilities: { ...module.capabilities, known_broken_flags: [], requires_browser: false, live_scrape_fallback: true },
    }),
    site({ id: SPANISH_ID, name: 'SitioLibre', category: 'Spanish', catalogInstalled: true }),
  ];
}

interface PickerMock {
  /** WebSocketRoute holder — the test pushes sync frames through it. */
  ws: { current?: WebSocketRoute };
  freshInstalled(): boolean;
  syncCalls(): number;
}

async function installPickerMockApi(
  page: Page,
  opts?: { readonly hangSync?: boolean; readonly syncBody?: unknown },
): Promise<PickerMock> {
  await installMockApi(page); // base §10 mocks (catalog pages, info, jobs, …)

  const state = { freshInstalled: false, syncCalls: 0 };
  const ws: { current?: WebSocketRoute } = {};

  await page.route(/^https?:\/\/[^/]+\/api\/modules$/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ modules: pickerModules(state.freshInstalled), count: 5 }),
    });
  });

  await page.route(new RegExp(`^https?://[^/]+/api/sync/catalog/(${FRESH_ID}|${NOCATALOG_ID})$`), (route): void => {
    state.syncCalls += 1;
    if (opts?.hangSync === true) {
      return; // never fulfills — the cancel test ends the UX client-side
    }
    const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    if (id === NOCATALOG_ID) {
      // A small delay keeps the (transient) preparing status
      // deterministically observable before the 404 outcome lands and
      // the automatic fallback opens the entries.
      setTimeout((): void => {
        void route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            result: { id, state: 'failed', error: 'no-catalog: FMD2-DB has no catalog archive for this site (HTTP 404)' },
          }),
        });
      }, 300);
      return;
    }
    if (opts?.syncBody !== undefined) {
      void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.syncBody) });
      return;
    }
    state.freshInstalled = true;
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result: { id, state: 'updated', dbSha: 'ff'.repeat(32), bytes: 2048 } }),
    });
  });

  // Catalog entries for the provisionable/404 sites (the live channel
  // serves the 404 site — source discriminator carried).
  for (const id of [FRESH_ID, NOCATALOG_ID]) {
    await page.route(new RegExp(`^https?://[^/]+/api/catalog/${id}/latest`), (route): void => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
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
          ],
          total: 1,
          source: id === NOCATALOG_ID ? 'live' : 'catalog',
        }),
      });
    });
  }

  await page.routeWebSocket(/^ws:\/\/[^/]+\/ws$/, (route): void => {
    ws.current = route;
    route.onMessage((): void => {
      // hello → stream the provision phases; the terminal frame is
      // pushed by the test at the right moment.
      route.send(
        JSON.stringify({ type: 'sync', id: '1', sync: { jobId: `catalog-sync:${FRESH_ID}`, moduleId: FRESH_ID, phase: 'checking' } }),
      );
      route.send(
        JSON.stringify({ type: 'sync', id: '2', sync: { jobId: `catalog-sync:${FRESH_ID}`, moduleId: FRESH_ID, phase: 'downloading', percent: 40 } }),
      );
    });
  });

  return {
    ws,
    freshInstalled: (): boolean => state.freshInstalled,
    syncCalls: (): number => state.syncCalls,
  };
}

function pushSyncFrame(ws: { current?: WebSocketRoute }, frame: unknown): void {
  ws.current?.send(JSON.stringify(frame));
}

/** The mode-vocabulary contract: 'live browse'/'scrape' never appear in
 * the rendered UI, and no control is named after a mode. */
async function expectNoModeVocabulary(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/live[ -]browse/i);
  expect(bodyText).not.toMatch(/scrape/i);
  const liveButtons = await page.getByRole('button', { name: /live/i }).count();
  expect(liveButtons).toBe(0);
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await page.route(/^https?:\/\/[^/]+\/api\/readyz$/, (route): void => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true }) });
  });
});

test('picker: sites by NAME, category groups, chips; broken disabled; hex IDs never rendered', async ({ page }: { page: Page }): Promise<void> => {
  await installPickerMockApi(page);
  await page.goto('/#/browse?sites=1');

  await expect(page.getByRole('heading', { name: 'Browse sites' })).toBeVisible();
  await expect(page.getByRole('button', { name: /MangaRock/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /ManhuaFresh/ })).toBeVisible();

  // Category grouping headers with counts.
  await expect(page.locator('.site-category', { hasText: 'Manga' })).toBeVisible();
  await expect(page.locator('.site-category', { hasText: 'Manhua' })).toBeVisible();

  // Readiness chips (unified browsing: no mode vocabulary on chips).
  await expect(page.getByText('ready').first()).toBeVisible();
  await expect(page.getByText('needs setup').first()).toBeVisible();

  // Known-broken row disabled with its reason.
  const broken = page.getByRole('button', { name: /BrokenScan/ });
  await expect(broken).toBeDisabled();
  await expect(broken).toHaveAttribute('title', /cloudflare-loop/);

  // Search narrows the list.
  await page.getByLabel('Search sites').fill('Manhua');
  await expect(page.getByRole('button', { name: /ManhuaFresh/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /MangaRock/ })).toHaveCount(0);

  // THE hex-ID contract: the id rides data attributes/URL, never text.
  await page.getByLabel('Search sites').fill('');
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(HEX32);

  // THE mode-vocabulary contract holds on the picker too.
  await expectNoModeVocabulary(page);
});

test('category facet chips: single / multi / All filter the list and sync ?cats= (persist across reload)', async ({ page }: { page: Page }): Promise<void> => {
  await installPickerMockApi(page);
  await page.goto('/#/browse?sites=1');

  const chips = page.getByRole('group', { name: 'Filter sites by category' });
  await expect(chips).toBeVisible();
  // Counts: Manga 3 (installed, broken, no-catalog), Manhua 1, Spanish 1.
  await expect(chips.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.getByRole('button', { name: /Manga 3/ })).toBeVisible();
  await expect(chips.getByRole('button', { name: /Manhua 1/ })).toBeVisible();
  await expect(chips.getByRole('button', { name: /Spanish 1/ })).toBeVisible();

  // SINGLE: Spanish only — the Manga/Manhua rows and headers vanish.
  await chips.getByRole('button', { name: /Spanish/ }).click();
  await expect(page.getByRole('button', { name: /SitioLibre/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /MangaRock/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /ManhuaFresh/ })).toHaveCount(0);
  await expect(page.locator('.site-category', { hasText: 'Spanish' })).toBeVisible();
  await expect(page.locator('.site-category', { hasText: 'Manga' })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/browse\?sites=1&cats=Spanish$/);
  await expect(chips.getByRole('button', { name: /Spanish/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');

  // MULTI: adding Manhua unions the two categories.
  await chips.getByRole('button', { name: /Manhua/ }).click();
  await expect(page.getByRole('button', { name: /SitioLibre/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /ManhuaFresh/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /MangaRock/ })).toHaveCount(0);
  const hash = decodeURIComponent(new URL(page.url()).hash);
  expect(hash).toBe('#/browse?sites=1&cats=Manhua,Spanish');

  // PERSISTENCE: a reload (shared-URL semantics) restores the facet.
  await page.reload();
  await expect(page.getByRole('button', { name: /SitioLibre/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /ManhuaFresh/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /MangaRock/ })).toHaveCount(0);
  const chipsAfterReload = page.getByRole('group', { name: 'Filter sites by category' });
  await expect(chipsAfterReload.getByRole('button', { name: /Manhua/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(chipsAfterReload.getByRole('button', { name: /Spanish/ })).toHaveAttribute('aria-pressed', 'true');

  // ALL: clears the facet (full list, cats param gone).
  await chipsAfterReload.getByRole('button', { name: 'All' }).click();
  await expect(page.getByRole('button', { name: /MangaRock/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /ManhuaFresh/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /SitioLibre/ })).toBeVisible();
  await expect(page).toHaveURL(/#\/browse\?sites=1$/);

  // Chips AND-compose with the search box (matrix completion).
  await chipsAfterReload.getByRole('button', { name: /Manga/ }).click();
  await page.getByLabel('Search sites').fill('rock');
  await expect(page.getByRole('button', { name: /MangaRock/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /BrokenScan/ })).toHaveCount(0);
});

test('picker → auto-provision(mock catalog, WS progress) → entries → manga deep-link', async ({ page }: { page: Page }): Promise<void> => {
  const mock = await installPickerMockApi(page);
  await page.goto('/#/browse?sites=1');

  await page.getByRole('button', { name: /ManhuaFresh/ }).click();
  // The hex id rides the URL (?site=), never the UI text.
  await expect(page).toHaveURL(new RegExp(`#/browse\\?site=${FRESH_ID}`));

  // Provisioning is visible (inline status + WS-driven toast phases).
  await expect(page.getByTestId('provision-status')).toBeVisible();
  await expect(page.getByText(/Downloading the site’s list/)).toBeVisible();

  // Terminal WS frame → entries open on completion.
  pushSyncFrame(mock.ws, {
    type: 'sync',
    id: '3',
    sync: { jobId: `catalog-sync:${FRESH_ID}`, moduleId: FRESH_ID, phase: 'done', outcome: 'updated' },
  });
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
  expect(mock.freshInstalled()).toBe(true);
  expect(mock.syncCalls()).toBe(1);
  await expect(page.getByTestId('provision-status')).toHaveCount(0);

  // The provisioned catalog carries the muted 'from catalog' badge.
  await expect(page.getByTitle('Prebuilt list from FMD2-DB')).toHaveText('from catalog');

  // Hex still never rendered as text on the entries view.
  expect(await page.locator('body').innerText()).not.toMatch(HEX32);

  // The manga deep-link flow (catalog→manga) is unchanged.
  await page.getByRole('button', { name: /^Alpha Quest/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/manga\\?`));
  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();
});

test('cancel withdraws the provisioning UX and returns to the picker', async ({ page }: { page: Page }): Promise<void> => {
  const mock = await installPickerMockApi(page, { hangSync: true });
  await page.goto('/#/browse?sites=1');

  await page.getByRole('button', { name: /ManhuaFresh/ }).click();
  await expect(page.getByTestId('provision-status')).toBeVisible();
  await expect(page.getByText(/Downloading the site’s list/)).toBeVisible();

  await page.getByTestId('provision-status').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Cancelled' })).toBeVisible();
  await expect(page.getByTestId('provision-status')).toHaveCount(0);
  expect(mock.syncCalls()).toBe(1);

  // Back to the picker — nothing partial opened.
  await page.getByRole('button', { name: 'Change site' }).click();
  await expect(page.getByRole('heading', { name: 'Browse sites' })).toBeVisible();
});

test('catalog-less directory-capable site → automatic live fallback: ONE progress experience, muted badge, no mode vocabulary', async ({ page }: { page: Page }): Promise<void> => {
  const mock = await installPickerMockApi(page);
  await page.goto('/#/browse?sites=1');

  await page.getByRole('button', { name: /NoCatalogSite/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/browse\\?site=${NOCATALOG_ID}`));

  // ONE progress experience: 'Preparing <site>…' — the same one shown
  // for any other site; no source/mode decision point ever appears.
  await expect(page.getByTestId('provision-status')).toBeVisible();
  await expect(page.getByText(/Preparing NoCatalogSite…/)).toBeVisible();

  // FMD2-DB 404 → the entries open AUTOMATICALLY via the live channel
  // (no button press, no mode offer) and the preparation withdraws.
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
  await expect(page.getByTestId('provision-status')).toHaveCount(0);
  expect(mock.syncCalls()).toBe(1);

  // The muted source badge is the ONLY trace — transparency, not a
  // decision point.
  await expect(page.getByTitle('List fetched live from the site')).toHaveText('from site');

  // THE MODE-VOCABULARY CONTRACT (DOM grep): no 'live browse'/'scrape'
  // strings, no mode-named buttons anywhere.
  await expectNoModeVocabulary(page);

  // Hex still never rendered as text.
  expect(await page.locator('body').innerText()).not.toMatch(HEX32);
});
