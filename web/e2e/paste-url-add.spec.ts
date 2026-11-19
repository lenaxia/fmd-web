/**
 * E2E — [crystal-nectar-pricks] paste-URL, the universal front door
 * (D1 §2 ENTER): a paste box on the search home AND the command
 * palette's Add-by-URL action both land in the ONE preview/follow
 * flow — resolve by host (POST /api/info url-only), preview (title,
 * cover via the proxy seam, alt titles), one-decision follow (plain
 * vs auto-download), and the followed manga appears in Favorites.
 * Typed failures (no_site_match / ambiguous_site) surface as human
 * guidance, never a 500 (Playwright fails on uncaught page errors —
 * these tests passing IS the never-a-500 assertion).
 *
 * Desktop project; fully offline (fixture-driven mock API).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { MODULE_ID, installMockApi, info as baseInfo } from './fixtures';
import type { FavoriteT } from '../src/api/hooks';

const MANGA_URL = 'https://fixtures.example/manga/alpha';
const FAVORITE_ID = `${MODULE_ID}${MANGA_URL}`.toLowerCase();

/** The paste-preview fixture: a proxied cover link (the seam this spec pins). */
const pasteInfo = { ...baseInfo, moduleId: MODULE_ID, coverLink: 'https://cdn.example/cover.jpg' };

function favoriteRow(autoDownload: boolean): FavoriteT {
  return {
    id: FAVORITE_ID,
    moduleId: MODULE_ID,
    url: MANGA_URL,
    title: 'Alpha Quest',
    status: 'Ongoing',
    currentChapter: 2,
    newChapterCount: 0,
    autoDownload,
    lastCheck: null,
    lastUpdated: null,
    saveTo: null,
    enabled: true,
    dateAdded: '2026-11-19T00:00:00Z',
    coverLink: null,
  };
}

const json = (route: Route, body: unknown, status = 200): void => {
  void route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
};

/** 1x1 transparent PNG — enough for the browser to decode + fire onLoad
 * (copied from cover-proxy.spec.ts: without bytes here, CoverImage's
 * onError swaps the placeholder in and the proxy-src assertion dies). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function installCoverProxy(page: Page): Promise<void> {
  await page.route(/^https?:\/\/[^/]+\/api\/cover/, (route: Route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(PNG_BASE64, 'base64'),
    });
  });
}

interface FavoritesState {
  rows: FavoriteT[];
  posts: { autoDownload?: boolean }[];
}

/** Stateful favorites: the POST round-trip is observable in both lists. */
async function installStatefulFavorites(page: Page, state: FavoritesState): Promise<void> {
  await page.route(/^https?:\/\/[^/]+\/api\/favorites$/, (route): void => {
    const method = route.request().method();
    if (method === 'GET') {
      json(route, { favorites: state.rows });
    } else if (method === 'POST') {
      const body = route.request().postDataJSON() as { autoDownload?: boolean };
      state.posts.push(body.autoDownload === true ? { autoDownload: true } : {});
      state.rows.push(favoriteRow(body.autoDownload === true));
      json(route, { favorite: state.rows[state.rows.length - 1] ?? null }, 201);
    } else {
      json(route, {}, 404);
    }
  });
}

test('paste → preview → follow → appears in favorites (the universal front door)', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  const state: FavoritesState = { rows: [], posts: [] };
  await installMockApi(page);
  await installCoverProxy(page);
  await installStatefulFavorites(page, state);
  await page.route(/^https?:\/\/[^/]+\/api\/info$/, (route): void => {
    json(route, pasteInfo);
  });

  await page.goto('/#/browse');
  await page.getByLabel('Add by URL').fill(MANGA_URL);
  await page.getByRole('button', { name: 'Preview' }).click();

  // The info preview: title, alt titles, cover VIA THE PROXY SEAM.
  const preview = page.getByTestId('paste-url-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();
  await expect(preview.getByTestId('paste-url-alt-titles')).toHaveText('Alpha Quest (Alt)');
  await expect(preview.getByTestId('paste-url-cover')).toBeVisible();
  await expect(page.locator('[data-testid="paste-url-cover"] img')).toHaveAttribute(
    'src',
    `/api/cover?moduleId=${MODULE_ID}&url=${encodeURIComponent('https://cdn.example/cover.jpg')}`,
  );

  // One decision — Follow. No wizard, no re-ask.
  await page.getByTestId('paste-url-follow').click();
  await expect(page.getByTestId('paste-url-done')).toBeVisible();
  expect(state.posts).toEqual([{}]);

  // The followed manga appears in Favorites.
  await page.getByRole('button', { name: 'Open Favorites' }).click();
  await expect(page.getByText('Alpha Quest').first()).toBeVisible();
});

test('Follow + auto-download posts exactly one body difference', async ({ page }: { page: Page }): Promise<void> => {
  const state: FavoritesState = { rows: [], posts: [] };
  await installMockApi(page);
  await installCoverProxy(page);
  await installStatefulFavorites(page, state);
  await page.route(/^https?:\/\/[^/]+\/api\/info$/, (route): void => {
    json(route, pasteInfo);
  });

  await page.goto('/#/browse');
  await page.getByLabel('Add by URL').fill(MANGA_URL);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('paste-url-preview')).toBeVisible();

  await page.getByTestId('paste-url-follow-auto').click();
  await expect(page.getByTestId('paste-url-done')).toContainText('download automatically');
  expect(state.posts).toEqual([{ autoDownload: true }]);
});

test('unknown host surfaces the typed no_site_match guidance, never a 500', async ({ page }: { page: Page }): Promise<void> => {
  const state: FavoritesState = { rows: [], posts: [] };
  await installMockApi(page);
  await installCoverProxy(page);
  await installStatefulFavorites(page, state);
  await page.route(/^https?:\/\/[^/]+\/api\/info$/, (route): void => {
    json(
      route,
      { error: { code: 'no_site_match', message: 'no site matches this URL' } },
      400,
    );
  });

  await page.goto('/#/browse');
  await page.getByLabel('Add by URL').fill('https://nowhere.example/manga/x');
  await page.getByRole('button', { name: 'Preview' }).click();

  const alert = page.getByTestId('paste-url-error');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('data-error-code', 'no_site_match');
  await expect(alert).toContainText('No site matches this URL');
  await expect(alert).toContainText("site fmd-web has a module for");
  await expect(alert.getByRole('button', { name: 'Browse supported sites' })).toBeVisible();
  // No preview, no favorite, and the page stayed alive (the box is
  // still operable for a corrected paste).
  await expect(page.getByTestId('paste-url-preview')).toHaveCount(0);
  expect(state.posts).toEqual([]);
  await page.getByLabel('Add by URL').fill(MANGA_URL);
  await expect(page.getByLabel('Add by URL')).toHaveValue(MANGA_URL);
});

test('ambiguous host names the candidate sites', async ({ page }: { page: Page }): Promise<void> => {
  await installMockApi(page);
  await installCoverProxy(page);
  await installStatefulFavorites(page, { rows: [], posts: [] });
  await page.route(/^https?:\/\/[^/]+\/api\/info$/, (route): void => {
    json(
      route,
      {
        error: {
          code: 'ambiguous_site',
          message: 'host shared by: MangaDexA, MangaDexB',
        },
      },
      400,
    );
  });

  await page.goto('/#/browse');
  await page.getByLabel('Add by URL').fill('https://ambiguous.example/manga/x');
  await page.getByRole('button', { name: 'Preview' }).click();

  const alert = page.getByTestId('paste-url-error');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('data-error-code', 'ambiguous_site');
  await expect(alert).toContainText('more than one site');
  await expect(alert).toContainText('MangaDexA, MangaDexB');
});

test('command palette entry: Add manga by URL arms the same preview/follow flow', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  const state: FavoritesState = { rows: [], posts: [] };
  await installMockApi(page);
  await installCoverProxy(page);
  await installStatefulFavorites(page, state);
  await page.route(/^https?:\/\/[^/]+\/api\/info$/, (route): void => {
    json(route, pasteInfo);
  });

  // From a NON-home surface (Downloads): the palette action navigates
  // and lands the URL in the search home's paste box.
  await page.goto('/#/downloads');
  await page.getByRole('button', { name: 'Open command palette' }).click();
  const input = page.getByTestId('palette-input');
  await input.fill(MANGA_URL);
  const item = page.getByTestId('palette-action-add-by-url');
  // A URL-shaped query KEEPS the item visible (keywords seam) and
  // shows the target.
  await expect(item).toBeVisible();
  await expect(item.getByTestId('palette-add-by-url-target')).toHaveText(MANGA_URL);
  await item.click();

  // Landed on the home, armed, resolved — then the same one-decision
  // follow works from the palette path.
  const preview = page.getByTestId('paste-url-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();
  await page.getByTestId('paste-url-follow').click();
  await expect(page.getByTestId('paste-url-done')).toBeVisible();
  expect(state.posts).toEqual([{}]);
});
