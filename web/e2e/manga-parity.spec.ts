/**
 * MangaPage parity e2e (FMD2 info-pane): the add-to-favorites
 * round-trip through a STATEFUL mock favorites API, the
 * downloaded-chapter visual state (tint/badge + hide-downloaded
 * toggle, fed by /api/info's embedded downloaded set) and the
 * Ascending/Descending presentation toggle. Fixture-driven like the
 * smoke specs — loopback + interception only.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi, info as baseInfo } from './fixtures';

interface FavoriteFixture {
  id: string;
  moduleId: string;
  url: string;
  title: string | null;
  status: string | null;
  currentChapter: number | null;
  newChapterCount: number;
  autoDownload: boolean;
  lastCheck: string;
  lastUpdated: string | null;
}

const MANGA_URL = 'https://fixtures.example/manga/alpha';
const FAVORITE_ID = `${MODULE_ID}${MANGA_URL}`.toLowerCase();

/** info with ch-1 already downloaded (ledger membership seeds tinting). */
const infoWithDownloads = { ...baseInfo, downloaded: ['/manga/alpha/ch-1'] };

function favoriteRow(): FavoriteFixture {
  return {
    id: FAVORITE_ID,
    moduleId: MODULE_ID,
    url: MANGA_URL,
    title: 'Alpha Quest',
    status: 'Ongoing',
    currentChapter: 2,
    newChapterCount: 0,
    autoDownload: false,
    lastCheck: '2026-11-13T00:00:00Z',
    lastUpdated: null,
  };
}

/** Stateful favorites mock: the round-trip observes real membership. */
function installStatefulFavorites(page: Page, rows: FavoriteFixture[]): void {
  const json = (route: Route, body: unknown, status = 200): void => {
    void route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  };
  void page.route(/^https?:\/\/[^/]+\/api\/favorites$/, (route): void => {
    if (route.request().method() === 'GET') {
      json(route, { favorites: rows });
    } else {
      rows.push(favoriteRow());
      json(route, { favorite: rows[rows.length - 1] }, 201);
    }
  });
  void page.route(/^https?:\/\/[^/]+\/api\/favorites\/.+$/, (route): void => {
    const index = rows.findIndex((row): boolean => row.id === FAVORITE_ID);
    if (index >= 0) rows.splice(index, 1);
    json(route, { ok: true });
  });
  // Precedence over the installMockApi info fixture (registered later).
  void page.route(/^https?:\/\/[^/]+\/api\/info$/, (route): void => {
    json(route, infoWithDownloads);
  });
}

async function gotoManga(page: Page): Promise<void> {
  await page.goto(
    `/#/manga?catalog=${CATALOG_ID}&module=${MODULE_ID}&url=${encodeURIComponent(
      MANGA_URL,
    )}&title=${encodeURIComponent('Alpha Quest')}`,
  );
  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  installMockApi(page);
});

test('favorite round-trip: Add to favorites → In favorites → remove', async ({ page }: {
  page: Page;
}): Promise<void> => {
  const rows: FavoriteFixture[] = [];
  installStatefulFavorites(page, rows);
  await gotoManga(page);

  const add = page.getByRole('button', { name: 'Add to favorites' });
  await expect(add).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select new' })).toBeDisabled();

  await add.click();
  await expect(page.getByRole('button', { name: 'In favorites' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to favorites' })).toBeHidden();
  expect(rows).toHaveLength(1);
  // membership unlocks select-new
  await expect(page.getByRole('button', { name: 'Select new' })).toBeEnabled();

  await page.getByRole('button', { name: 'In favorites' }).click();
  await expect(page.getByRole('button', { name: 'Add to favorites' })).toBeVisible();
  expect(rows).toHaveLength(0);
});

test('downloaded chapters are tinted and hide-downloaded drops them', async ({ page }: {
  page: Page;
}): Promise<void> => {
  installStatefulFavorites(page, []);
  await gotoManga(page);

  // ch-1 carries the downloaded badge (ledger membership via /api/info)
  await expect(page.getByLabel('Chapter 1: The Beginning')).toBeVisible();
  await expect(
    page.locator('[data-downloaded="true"]', { hasText: 'Chapter 1: The Beginning' }),
  ).toBeVisible();
  await expect(page.getByText('downloaded', { exact: true })).toBeVisible();
  await expect(page.getByTestId('manga-cover')).toBeVisible();

  await page.getByRole('button', { name: 'Hide downloaded' }).click();
  await expect(page.getByLabel('Chapter 1: The Beginning')).toBeHidden();
  await expect(page.getByLabel('Chapter 2: The Middle')).toBeVisible();
  await expect(page.getByText('1 shown')).toBeVisible();
});

test('Ascending/Descending toggles the chapter presentation order', async ({ page }: {
  page: Page;
}): Promise<void> => {
  installStatefulFavorites(page, []);
  await gotoManga(page);

  await expect(page.getByLabel('Chapter 1: The Beginning')).toBeVisible();
  const firstBefore = await page
    .getByRole('checkbox', { name: /Chapter/ })
    .first()
    .getAttribute('id');
  expect(firstBefore).toContain('chapter-');

  await page.getByRole('button', { name: 'Ascending' }).click();
  await expect(page.getByRole('button', { name: 'Descending' })).toBeVisible();

  // After the flip the FIRST chapter checkbox in DOM order is chapter-2.
  const firstAfter = await page
    .getByRole('checkbox', { name: /Chapter/ })
    .first()
    .getAttribute('id');
  expect(firstAfter).not.toBe(firstBefore);

  // Enqueue with Start paused carries paused:true on the wire.
  await page.getByLabel('Chapter 2: The Middle').check();
  await page.getByLabel('Start paused').check();
  await expect(page.getByLabel('Enqueue request preview')).toContainText('"paused": true');
  const posted: string[] = [];
  page.on('request', (req): void => {
    if (req.url().includes('/api/jobs/download')) posted.push(req.postData() ?? '');
  });
  await page.getByRole('button', { name: /Enqueue 1 chapter/ }).click();
  await expect
    .poll((): number => posted.length)
    .toBe(1);
  expect(JSON.parse(posted[0] ?? '{}')).toMatchObject({ paused: true });
});
