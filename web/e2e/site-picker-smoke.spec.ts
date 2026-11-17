/**
 * Playwright e2e — SITE-FIRST BROWSE (FMD2 cbSelectManga parity):
 * picker by NAME → auto-provision (mock FMD2-DB catalog, WS-driven
 * progress) → entries → manga deep-link; cancel; the FMD2-DB-404
 * taxonomy with the §6.8 live-scrape offer; known-broken rows
 * disabled with reason; hex module ids NEVER rendered (they ride the
 * URL only). Fully offline: loopback + intercepted routes/sockets.
 */
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { installMockApi, module, type ModuleSummaryT } from './fixtures';

const INSTALLED_ID = '1'.repeat(32);
const FRESH_ID = '2'.repeat(32);
const BROKEN_ID = '3'.repeat(32);
const NOCATALOG_ID = '4'.repeat(32);

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
 * known-broken, and a 404-catalog site (live-capable). */
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
  installMockApi(page); // base §10 mocks (catalog pages, info, jobs, …)

  const state = { freshInstalled: false, syncCalls: 0 };
  const ws: { current?: WebSocketRoute } = {};

  await page.route(/^https?:\/\/[^/]+\/api\/modules$/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ modules: pickerModules(state.freshInstalled), count: 4 }),
    });
  });

  await page.route(new RegExp(`^https?://[^/]+/api/sync/catalog/(${FRESH_ID}|${NOCATALOG_ID})$`), (route): void => {
    state.syncCalls += 1;
    if (opts?.hangSync === true) {
      return; // never fulfills — the cancel test ends the UX client-side
    }
    const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    if (id === NOCATALOG_ID) {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          result: { id, state: 'failed', error: 'no-catalog: FMD2-DB has no catalog archive for this site (HTTP 404)' },
        }),
      });
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

  // Catalog entries for the provisionable/404 sites (the §6.8 live
  // channel serves the 404 site — source discriminator carried).
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

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await page.route(/^https?:\/\/[^/]+\/api\/readyz$/, (route): void => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true }) });
  });
});

test('picker: sites by NAME, category groups, chips; broken disabled; hex IDs never rendered', async ({ page }: { page: Page }): Promise<void> => {
  const mock = await installPickerMockApi(page);
  void mock;
  await page.goto('/#/browse');

  await expect(page.getByRole('heading', { name: 'Browse sites' })).toBeVisible();
  await expect(page.getByRole('button', { name: /MangaRock/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /ManhuaFresh/ })).toBeVisible();

  // Category grouping headers with counts.
  await expect(page.locator('.site-category', { hasText: 'Manga' })).toBeVisible();
  await expect(page.locator('.site-category', { hasText: 'Manhua' })).toBeVisible();

  // Catalog-state chips.
  await expect(page.getByText('catalog ready').first()).toBeVisible();
  await expect(page.getByText('live browse').first()).toBeVisible();

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
});

test('picker → auto-provision(mock catalog, WS progress) → entries → manga deep-link', async ({ page }: { page: Page }): Promise<void> => {
  const mock = await installPickerMockApi(page);
  await page.goto('/#/browse');

  await page.getByRole('button', { name: /ManhuaFresh/ }).click();
  // The hex id rides the URL (?site=), never the UI text.
  await expect(page).toHaveURL(new RegExp(`#/browse\\?site=${FRESH_ID}`));

  // Provisioning is visible (inline status + WS-driven toast phases).
  await expect(page.getByTestId('provision-status')).toBeVisible();
  await expect(page.getByText(/Downloading the catalog archive/)).toBeVisible();

  // Terminal WS frame → entries open on completion.
  pushSyncFrame(mock.ws, {
    type: 'sync',
    id: '3',
    sync: { jobId: `catalog-sync:${FRESH_ID}`, moduleId: FRESH_ID, phase: 'done', outcome: 'updated' },
  });
  await expect(page.getByRole('button', { name: /Alpha Quest/ })).toBeVisible();
  expect(mock.freshInstalled()).toBe(true);
  expect(mock.syncCalls()).toBe(1);
  await expect(page.getByTestId('provision-status')).toHaveCount(0);

  // Hex still never rendered as text on the entries view.
  expect(await page.locator('body').innerText()).not.toMatch(HEX32);

  // The manga deep-link flow (catalog→manga) is unchanged.
  await page.getByRole('button', { name: /Alpha Quest/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/manga\\?`));
  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();
});

test('cancel withdraws the provisioning UX and returns to the picker', async ({ page }: { page: Page }): Promise<void> => {
  const mock = await installPickerMockApi(page, { hangSync: true });
  await page.goto('/#/browse');

  await page.getByRole('button', { name: /ManhuaFresh/ }).click();
  await expect(page.getByTestId('provision-status')).toBeVisible();
  await expect(page.getByText(/Downloading the catalog archive/)).toBeVisible();

  await page.getByTestId('provision-status').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Provisioning cancelled')).toBeVisible();
  await expect(page.getByTestId('provision-status')).toHaveCount(0);
  expect(mock.syncCalls()).toBe(1);

  // Back to the picker — nothing partial opened.
  await page.getByRole('button', { name: 'Change site' }).click();
  await expect(page.getByRole('heading', { name: 'Browse sites' })).toBeVisible();
});

test('FMD2-DB 404 → friendly no-catalog + §6.8 live-scrape offer (source badge)', async ({ page }: { page: Page }): Promise<void> => {
  await installPickerMockApi(page);
  await page.goto('/#/browse');

  await page.getByRole('button', { name: /NoCatalogSite/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/browse\\?site=${NOCATALOG_ID}`));

  await expect(page.getByText('No prebuilt catalog for this site')).toBeVisible();
  await expect(page.getByText(/live browsing/i)).toBeVisible();

  // Live browse serves the directory walk with the source badge.
  await page.getByRole('button', { name: 'Browse live instead' }).click();
  await expect(page.getByRole('button', { name: /Alpha Quest/ })).toBeVisible();
  await expect(page.getByTitle(/live-scrape fallback/)).toHaveText('live scrape');
});
