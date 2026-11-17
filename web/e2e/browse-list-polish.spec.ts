/**
 * Browse-list polish e2e (FMD2 manga-list affordances): the metadata
 * hover popover over entry rows (catalog data only), and the row
 * overflow menu's three actions — Open (navigation), Download all
 * chapters (the BATCH endpoint with the deterministic per-manga
 * idempotency key — replay returns the same jobs), Add to favorites
 * (disabled + tooltip once favorited). Fixture-driven like the other
 * specs — loopback + interception only.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi } from './fixtures';

const SITE_URL = `#/browse?site=${CATALOG_ID}`;

interface BatchCall {
  body: Record<string, unknown>;
  status: number;
}

/** Stateful batch mock: first call 201 fresh, every replay 200 + replayed. */
function installBatchRecorder(page: Page, calls: BatchCall[]): void {
  void page.route(/\/api\/jobs\/download\/batch$/, (route: Route): void => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const fresh = calls.length === 0;
    const status = fresh ? 201 : 200;
    calls.push({ body, status });
    void route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({
        jobs: [
          { id: 'job-batch-1', type: 'download', moduleId: MODULE_ID, payload: {}, state: 'queued', priority: 0, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z' },
          { id: 'job-batch-2', type: 'download', moduleId: MODULE_ID, payload: {}, state: 'queued', priority: 0, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z' },
        ],
        replayed: !fresh,
      }),
    });
  });
}

async function openRowMenu(page: Page, rowTitle: string): Promise<void> {
  // Direct click — no row hover (the metadata popover opening over the
  // row must never gate the menu; both are independent affordances).
  await page.getByRole('button', { name: `Actions for ${rowTitle}` }).click();
  await expect(page.getByTestId('entry-row-menu')).toBeVisible();
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  installMockApi(page);
});

test('hovering a row shows the full catalog metadata popover (no fetch)', async ({ page }: {
  page: Page;
}): Promise<void> => {
  let infoCalls = 0;
  await page.route(/\/api\/info$/, (route: Route): void => {
    infoCalls += 1;
    void route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(SITE_URL);
  await expect(page.getByText('Alpha Quest')).toBeVisible();

  await page.getByText('Alpha Quest').hover();
  const popover = page.getByTestId('entry-metadata');
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute('data-entry-link', '/manga/alpha');
  await expect(popover.getByText('Author A')).toBeVisible();
  await expect(popover.getByText('Ongoing')).toBeVisible();

  // Catalog data only — the popover never triggers a live info fetch.
  await expect(popover).toBeVisible();
  expect(infoCalls).toBe(0);
});

test('row menu → Open navigates to the manga page', async ({ page }: {
  page: Page;
}): Promise<void> => {
  await page.goto(SITE_URL);
  await expect(page.getByText('Alpha Quest')).toBeVisible();

  await openRowMenu(page, 'Alpha Quest');
  await page.getByTestId('entry-row-menu').getByText('Open').click();

  await expect(page).toHaveURL(new RegExp(`#/manga\\?catalog=${CATALOG_ID}`));
});

test('row menu → Download all chapters POSTs one batch per manga; replay is idempotent', async ({ page }: {
  page: Page;
}): Promise<void> => {
  const calls: BatchCall[] = [];
  installBatchRecorder(page, calls);
  await page.goto(SITE_URL);
  await expect(page.getByText('Alpha Quest')).toBeVisible();

  await openRowMenu(page, 'Alpha Quest');
  await page.getByTestId('entry-row-menu').getByText('Download all chapters').click();
  await expect(page.getByText(/Queued 2 chapter downloads/)).toBeVisible();

  // The double submit: same key, whole-batch replay, SAME jobs back.
  await openRowMenu(page, 'Alpha Quest');
  await page.getByTestId('entry-row-menu').getByText('Download all chapters').click();
  await expect(page.getByText(/Already queued/)).toBeVisible();

  expect(calls).toHaveLength(2);
  expect(calls[0]?.status).toBe(201);
  expect(calls[1]?.status).toBe(200);
  expect(calls[0]?.body['chapters']).toBe('all');
  expect(calls[0]?.body['moduleId']).toBe(CATALOG_ID);
  expect(calls[0]?.body['mangaUrl']).toBe('/manga/alpha');
  expect(calls[0]?.body['idempotencyKey']).toBe(calls[1]?.body['idempotencyKey']);
});

test('row menu → Add to favorites: POSTs, then disables with a tooltip', async ({ page }: {
  page: Page;
}): Promise<void> => {
  const favoritePosts: unknown[] = [];
  const SITE = CATALOG_ID;
  const rows: unknown[] = [];
  // Stateful favorites (registered AFTER installMockApi → wins).
  void page.route(/\/api\/favorites$/, (route: Route): void => {
    if (route.request().method() === 'GET') {
      void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ favorites: rows }) });
    } else {
      favoritePosts.push(route.request().postDataJSON());
      rows.push({ id: 'fav-1', moduleId: SITE, url: '/manga/alpha', title: 'Alpha Quest' });
      void route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ favorite: rows[rows.length - 1] }),
      });
    }
  });
  await page.goto(SITE_URL);
  await expect(page.getByText('Alpha Quest')).toBeVisible();

  await openRowMenu(page, 'Alpha Quest');
  await page.getByTestId('entry-row-menu').getByText('Add to favorites').click();
  await expect(page.getByText(/Added Alpha Quest to favorites/)).toBeVisible();
  expect(favoritePosts).toHaveLength(1);

  // Favorited now: the item is disabled and the tooltip says why (hover
  // lands on the WRAPPER — the disabled item itself is pointer-events:none).
  await openRowMenu(page, 'Alpha Quest');
  const item = page.getByTestId('menu-add-favorite');
  await expect(item).toBeDisabled();
  await page.getByTestId('menu-add-favorite-wrap').hover();
  await expect(page.getByText('Already in favorites')).toBeVisible();
});
