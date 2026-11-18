/**
 * Cover proxy e2e (covers live-defect): a cover RENDERS through the
 * same-origin proxy — the manga-page hero <img> carries the proxied
 * /api/cover url (never the raw CDN url a strict `img-src 'self'`
 * posture would block) and the bytes actually load (opacity flip on
 * onLoad); the favorites grid renders its row cover off the stored
 * coverLink the same way; an empty coverLink keeps the No-cover
 * fallback. Fixture-driven like the parity specs — loopback +
 * interception only (the proxy route is mocked at the boundary; its
 * server contract is pinned hermetically in
 * server/test/api/cover-proxy.test.ts against a REAL loopback origin).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi, info as baseInfo } from './fixtures';

const MANGA_URL = 'https://fixtures.example/manga/alpha';
const COVER_URL = 'http://fmcdn.mfcdn.net/store/manga/32761/cover.jpg?token=abc&ttl=1893456000';
const PROXIED = `/api/cover?moduleId=${MODULE_ID}&url=${encodeURIComponent(COVER_URL)}`;

/** 1x1 transparent PNG — enough for the browser to decode + fire onLoad. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Intercept the cover proxy boundary with image bytes (loopback only).
 * The pattern is deliberately UNANCHORED at the end — the proxy src
 * carries a query string (`?moduleId=…&url=…`) a `$` would reject. */
async function installCoverProxy(page: Page): Promise<void> {
  await page.route(/^https?:\/\/[^/]+\/api\/cover/, (route: Route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'cache-control': 'public, max-age=3600' },
      body: Buffer.from(PNG_BASE64, 'base64'),
    });
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
  await installMockApi(page);
  await installCoverProxy(page);
});

test('manga-page hero cover renders through the same-origin proxy', async ({ page }: {
  page: Page;
}): Promise<void> => {
  await page.route(/^https?:\/\/[^/]+\/api\/info/, (route: Route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      // moduleId = MODULE_ID: coverSrc binds the proxy url to the
      // SERVING module id the info response carries.
      body: JSON.stringify({ ...baseInfo, moduleId: MODULE_ID, coverLink: COVER_URL }),
    });
  });
  await gotoManga(page);

  const cover = page.getByTestId('manga-cover');
  await expect(cover).toBeVisible();
  const img = cover.locator('img');
  // The CDN url NEVER reaches the <img> — only the same-origin proxy
  // url can load behind `img-src 'self' data: blob:`.
  await expect(img).toHaveAttribute('src', PROXIED);
  // The bytes actually loaded (onLoad flips opacity-0 → opacity-100).
  await expect(img).toHaveClass(/opacity-100/);
});

test('favorites grid renders the row cover off the stored coverLink', async ({ page }: {
  page: Page;
}): Promise<void> => {
  const favoriteId = `${MODULE_ID}${MANGA_URL}`.toLowerCase();
  await page.route(/^https?:\/\/[^/]+\/api\/favorites$/, (route: Route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        favorites: [
          {
            id: favoriteId,
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
            coverLink: COVER_URL,
          },
        ],
      }),
    });
  });
  await page.goto('/#/favorites');
  await expect(page.getByRole('heading', { name: /Favorites/ })).toBeVisible();

  const cover = page.getByTestId(`favorite-cover-${favoriteId}`);
  await expect(cover).toBeVisible();
  await expect(cover.locator('img')).toHaveAttribute(
    'src',
    `/api/cover?moduleId=${MODULE_ID}&url=${encodeURIComponent(COVER_URL)}`,
  );
  await expect(cover.locator('img')).toHaveClass(/opacity-100/);
});

test('empty coverLink keeps the No-cover fallback (no proxy hop)', async ({ page }: {
  page: Page;
}): Promise<void> => {
  await gotoManga(page);
  const cover = page.getByTestId('manga-cover');
  await expect(cover).toBeVisible();
  // baseInfo ships coverLink: '' — the placeholder stands, no <img>.
  await expect(cover.getByRole('img', { name: /no cover/ })).toBeVisible();
  await expect(cover.locator('img')).toHaveCount(0);
});
