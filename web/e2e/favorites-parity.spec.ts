/**
 * Favorites-parity e2e (FMD2 favorites tab): create-from-UI →
 * listing columns → toolbar batch check (scope menu) → the
 * NewChaptersSheet decision (Download all honoring auto-download
 * pre-queue) → downloads populate — the full journey against a
 * STATEFUL mock API (loopback + interception only, like the parity
 * specs before it).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { MODULE_ID, installMockApi, info as baseInfo } from './fixtures';
import type { FavoriteT, JobT } from '../src/api/hooks';

const MANGA_URL = 'https://fixtures.example/manga/alpha';
const FAVORITE_ID = `${MODULE_ID}${MANGA_URL}`.toLowerCase();

function favoriteRow(overrides: Partial<FavoriteT> = {}): FavoriteT {
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
    saveTo: null,
    enabled: true,
    dateAdded: '2026-11-12T00:00:00Z',
    ...overrides,
  };
}

interface DownloadsState {
  jobs: JobT[];
}

/**
 * Stateful favorites + check + downloads mock: the create round-trip,
 * the batch check results and every download enqueue observe real
 * state (the Downloads page lists exactly what the sheet created).
 */
async function installStatefulFavorites(page: Page, rows: FavoriteT[], downloads: DownloadsState): Promise<void> {
  const json = (route: Route, body: unknown, status = 200): void => {
    void route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  };
  const NEW_CHAPTERS = [
    { position: 1, link: '/manga/alpha/ch-1', name: 'Chapter 1: The Beginning' },
    { position: 2, link: '/manga/alpha/ch-2', name: 'Chapter 2: The Middle' },
  ];
  await page.route(/^https?:\/\/[^/]+\/api\/favorites$/, (route): void => {
    const method = route.request().method();
    if (method === 'GET') {
      json(route, { favorites: rows });
    } else if (method === 'POST') {
      rows.push(favoriteRow());
      json(route, { favorite: rows[rows.length - 1] }, 201);
    } else {
      json(route, {}, 404);
    }
  });
  await page.route(/^https?:\/\/[^/]+\/api\/favorites\/check$/, (route): void => {
    const body = route.request().postDataJSON() as { scope?: string };
    // REAL ENGINE CONTRACT (engine.ts: auto-download rows): the FULL
    // newChapters list comes back WITH queuedDownloads > 0 — the sheet
    // lists them pre-queued, it never hides them behind an empty list.
    const results = rows.map((favorite): object => ({
      favorite: {
        ...favorite,
        newChapterCount: NEW_CHAPTERS.length,
        currentChapter: 2,
      },
      status: 'checked',
      newChapters: NEW_CHAPTERS,
      queuedDownloads: favorite.autoDownload ? NEW_CHAPTERS.length : 0,
    }));
    for (const [index, favorite] of rows.entries()) {
      rows[index] = { ...favorite, newChapterCount: NEW_CHAPTERS.length };
    }
    json(route, {
      scope: body.scope ?? 'all',
      cancelled: false,
      checked: rows.length,
      failed: 0,
      queuedDownloads: NEW_CHAPTERS.length * rows.length,
      results,
    });
  });
  await page.route(/^https?:\/\/[^/]+\/api\/jobs\/download$/, (route): void => {
    const body = route.request().postDataJSON() as { mangaTitle?: string; chapterName?: string };
    const job: JobT = {
      id: `job-${downloads.jobs.length + 1}`,
      type: 'download',
      moduleId: MODULE_ID,
      payload: { mangaTitle: body.mangaTitle ?? '', chapterName: body.chapterName ?? '' },
      state: 'queued',
      priority: 0,
      createdAt: '2026-11-17T00:00:00Z',
      updatedAt: '2026-11-17T00:00:00Z',
    };
    downloads.jobs.push(job);
    json(route, { job }, 201);
  });
  await page.route(/^https?:\/\/[^/]+\/api\/jobs\?/, (route): void => {
    json(route, { jobs: [...downloads.jobs].reverse() });
  });
}

test('create favorite from the manga page, batch-check, decide in the sheet, downloads populate', async ({ page }: { page: Page }): Promise<void> => {
  const rows: FavoriteT[] = [];
  const downloads: DownloadsState = { jobs: [] };
  await installMockApi(page);
  await installStatefulFavorites(page, rows, downloads);

  // 1 — create from the manga page (the interplay story's affordance).
  await page.goto(
    `/#/manga?module=${MODULE_ID}&url=${encodeURIComponent(baseInfo.url)}&title=${encodeURIComponent('Alpha Quest')}`,
  );
  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();
  await page.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(page.getByRole('button', { name: 'In favorites' })).toBeVisible();

  // 2 — the listing shows the parity columns (website join + dates).
  await page.goto('/#favorites');
  await expect(page.getByText('Alpha Quest')).toBeVisible();
  await expect(page.getByText('FixtureSite').first()).toBeVisible();
  await expect(page.getByText(/added 2026-11-12 00:00/u).first()).toBeVisible();
  await expect(page.getByText('Website')).toBeVisible();

  // 3 — toolbar batch check, scope menu → All.
  await page.getByTestId('check-all-button').click();
  await page.getByTestId('check-scope-all').click();

  // 4 — the sheet presents the result; Download all enqueues the chapters.
  const sheet = page.getByTestId('new-chapters-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('has')).toContainText('2 new chapters');
  await sheet.getByTestId('newchapter-download-all').click();
  await expect
    .poll((): number => downloads.jobs.length)
    .toBe(2);

  // 5 — the downloads page lists exactly what the sheet created.
  await page.goto('/#downloads');
  await expect(page.getByText('Chapter 1: The Beginning').first()).toBeVisible();
  await expect(page.getByText('Chapter 2: The Middle').first()).toBeVisible();
});

test('auto-download favorites show pre-queued in the sheet (no double enqueue)', async ({ page }: { page: Page }): Promise<void> => {
  const rows: FavoriteT[] = [
    favoriteRow({
      id: `${MODULE_ID}https://fixtures.example/manga/beta`.toLowerCase(),
      url: 'https://fixtures.example/manga/beta',
      title: 'Beta Trails',
      autoDownload: true,
      newChapterCount: 2,
    }),
  ];
  const downloads: DownloadsState = { jobs: [] };
  await installMockApi(page);
  await installStatefulFavorites(page, rows, downloads);

  await page.goto('/#favorites');
  await page.getByTestId('check-all-button').click();
  await page.getByTestId('check-scope-enabled').click();

  const sheet = page.getByTestId('new-chapters-sheet');
  await expect(sheet).toBeVisible();
  // The auto row was already queued by the check — badge, disabled actions.
  await expect(sheet.getByText('auto-queued (auto-download)')).toBeVisible();
  await expect(sheet.getByTestId(`newchapter-download-${rows[0]?.id ?? ''}`)).toBeDisabled();
  await expect(sheet.getByTestId('newchapter-pending-count')).toHaveText('0 pending decisions');
});
