/**
 * E2E — live search + FMD2 filter panel (tsk-savvy-jockey-ambles):
 * as-you-type search updates results while typing (250ms debounce),
 * applying a genre filter updates the URL, and back/forward restore
 * the previous filter state. Fully offline (fixture-driven mock API).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { CATALOG_ID, installMockApi, entries } from './fixtures';

/**
 * Dynamic /search mock layered OVER installMockApi (later routes win):
 * honors q (title contains), genres[] + genresMode, status — the same
 * semantics as the server.
 */
function installDynamicSearch(page: Page): { searchRequests: string[] } {
  const searchRequests: string[] = [];
  void page.route(/\/api\/catalog\/[^/]+\/search/, (route: Route): void => {
    const url = new URL(route.request().url());
    searchRequests.push(url.search);
    const q: string = (url.searchParams.get('q') ?? '').toLowerCase();
    const genres: string[] = url.searchParams.getAll('genres');
    const genresMode: string = url.searchParams.get('genresMode') ?? 'all';
    const status: string = url.searchParams.get('status') ?? '';
    const filtered = entries.filter((entry): boolean => {
      if (q !== '' && !entry.title.toLowerCase().includes(q)) return false;
      if (status !== '' && entry.status !== status) return false;
      if (genres.length > 0) {
        const hits = genres.map((g): boolean => entry.genres.includes(g));
        if (!(genresMode === 'any' ? hits.some(Boolean) : hits.every(Boolean))) return false;
      }
      return true;
    });
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: filtered, total: filtered.length, source: 'catalog' }),
    });
  });
  return { searchRequests };
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  installMockApi(page);
});

test('as-you-type: results update while typing (debounced, single fetch for the burst)', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  const { searchRequests } = installDynamicSearch(page);
  await page.goto(`/#/browse?site=${CATALOG_ID}`);

  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();

  // Type a query that filters to ONE entry — results update while typing.
  await page.getByLabel('Search').pressSequentially('bet', { delay: 60 });
  await expect(page.getByRole('button', { name: /^Beta Trails/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeHidden();

  // URL carries q (shareable); the mode label shows the filtered state.
  expect(page.url()).toContain('q=bet');
  await expect(page.getByText(/Filtered/)).toBeVisible();

  // Debounce: the whole burst produced requests only for settled states
  // (the final 'bet' at minimum; no per-keystroke 'b'/'be' spam).
  await expect
    .poll((): number => searchRequests.filter((s): boolean => s.includes('q=bet')).length)
    .toBeGreaterThanOrEqual(1);
  expect(searchRequests.some((s): boolean => s.includes('q=b&') || s.includes('q=be&'))).toBe(false);
});

test('genre filter: URL updates; back/forward restore the previous state', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  installDynamicSearch(page);
  await page.goto(`/#/browse?site=${CATALOG_ID}`);
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
  const urlBefore: string = page.url();

  // Open the filter panel, check Drama (ALL default) → push + filtered results.
  await page.getByRole('button', { name: /Filters/ }).click();
  // (click, not check(): the controlled checkbox re-renders through the
  // URL-sync cycle — the URL + results below prove the applied state)
  await page.getByRole('checkbox', { name: 'Drama' }).click();
  await expect(page.getByRole('button', { name: /^Beta Trails/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeHidden();
  expect(page.url()).toContain('genres=Drama');
  expect(page.url()).not.toContain('mode=any'); // ALL default omits mode

  // Back → the unfiltered latest view + URL restore.
  await page.goBack();
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();
  expect(page.url()).not.toContain('genres=');
  expect(page.url()).toBe(urlBefore);

  // Forward → the filtered state returns.
  await page.goForward();
  await expect(page.getByRole('button', { name: /^Beta Trails/ })).toBeVisible();
  expect(page.url()).toContain('genres=Drama');
});
