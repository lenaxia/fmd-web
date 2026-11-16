/**
 * Visual regression fixtures (design system AC): one committed
 * screenshot per page × per theme — the zero-treshold diff gate that
 * keeps every tab on the design system. Runs under its own config
 * (playwright.visual.config.ts) so the fixtures land in
 * web/e2e/visual/fixtures/ (committed), never in test-results.
 *
 * Reviewed-update flow for INTENTIONAL visual changes:
 *   npm run e2e:visual -- --update-snapshots   # regenerate
 *   # review the fixture diff in the PR, commit alongside the change
 */
import { test, expect, type Page } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi } from './fixtures';

type PageName = 'browse' | 'manga' | 'downloads' | 'favorites' | 'library' | 'settings';
type ThemeName = 'dark' | 'light';

const ROUTES: Record<PageName, string> = {
  browse: `/#/browse?catalog=${CATALOG_ID}`,
  manga: `/#/manga?catalog=${CATALOG_ID}&module=${MODULE_ID}&url=${encodeURIComponent(
    'https://fixtures.example/manga/alpha',
  )}&title=${encodeURIComponent('Alpha Quest')}`,
  downloads: '/#/downloads',
  favorites: '/#/favorites',
  library: '/#/library',
  settings: '/#/settings',
};

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  installMockApi(page);
  await page.route(/^https?:\/\/[^/]+\/api\/readyz$/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, reason: 'ready' }),
    });
  });
  await page.routeWebSocket(/^ws:\/\/[^/]+\/ws$/, (ws): void => {
    ws.onMessage((): void => {});
  });
});

for (const theme of ['dark', 'light'] as const satisfies readonly ThemeName[]) {
  test.describe(`theme=${theme}`, (): void => {
    for (const name of Object.keys(ROUTES) as PageName[]) {
      test(`${name} matches its committed ${theme} fixture`, async ({ page }: { page: Page }): Promise<void> => {
        // Pre-hydration persistence: the inline theme script picks this up
        // before first paint — exactly what a real returning user gets.
        await page.addInitScript((t): void => {
          window.localStorage.setItem('fmd-web-theme', t);
        }, theme);

        await page.goto(ROUTES[name], { waitUntil: 'networkidle' });
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /^.*\bdark\b.*$/ : /^.*\blight\b.*$/);

        await expect(page).toHaveScreenshot(`${name}-${theme}.png`, {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
        });
      });
    }
  });
}
