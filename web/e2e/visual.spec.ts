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

/**
 * R3 mobile viewport column (tsk-verdant-manger-hovers): the same
 * 6-page × 2-theme matrix at 390×844 — 12 more committed fixtures
 * (24 total), EVERY one carrying the bottom-nav shell (asserted
 * before the shot so a shell regression fails loudly, not just
 * visually).
 */
for (const theme of ['dark', 'light'] as const satisfies readonly ThemeName[]) {
  test.describe(`mobile theme=${theme}`, (): void => {
    test.use({ viewport: { width: 390, height: 844 } });

    for (const name of Object.keys(ROUTES) as PageName[]) {
      test(`${name} mobile matches its committed ${theme} fixture`, async ({ page }: { page: Page }): Promise<void> => {
        await page.addInitScript((t): void => {
          window.localStorage.setItem('fmd-web-theme', t);
        }, theme);

        await page.goto(ROUTES[name], { waitUntil: 'networkidle' });
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /^.*\bdark\b.*$/ : /^.*\blight\b.*$/);
        // The bottom-nav shell IS part of every mobile fixture.
        await expect(page.getByTestId('bottom-nav')).toBeVisible();

        await expect(page).toHaveScreenshot(`${name}-mobile-${theme}.png`, {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
        });
      });
    }
  });
}

/**
 * Search-first home + command palette (R5): BOTH viewports × both
 * themes — desktop (1280×800) and mobile (390×844) are designed
 * together, so both are locked by fixtures. Recents are seeded for a
 * deterministic, fully-populated home (names only — no timestamps).
 */
for (const theme of ['dark', 'light'] as const satisfies readonly ThemeName[]) {
  test.describe(`search-home theme=${theme}`, (): void => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test(`search-home-desktop-${theme} matches its committed fixture`, async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await seedSearchHome(page, theme);
      await page.goto('/#/browse', { waitUntil: 'networkidle' });
      await expect(page.getByLabel('Search all sites')).toBeVisible();
      await expect(page).toHaveScreenshot(`search-home-desktop-${theme}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
      });
    });

    test(`palette-desktop-${theme} matches its committed fixture`, async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await seedSearchHome(page, theme);
      await page.goto('/#/browse', { waitUntil: 'networkidle' });
      // Open via the visible affordance — deterministic, and the R3
      // mobile path into the bargain.
      await page.getByRole('button', { name: 'Open command palette' }).click();
      await expect(page.getByTestId('palette-input')).toBeVisible();
      await page.waitForTimeout(400); // dialog enter animation settles (animations are NOT fully disabled for overlays)
      await expect(page).toHaveScreenshot(`palette-desktop-${theme}.png`, {
        animations: 'disabled',
        caret: 'hide',
      });
    });
  });

  test.describe(`search-home-mobile theme=${theme}`, (): void => {
    test.use({ viewport: { width: 390, height: 844 } });

    test(`search-home-mobile-${theme} matches its committed fixture`, async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await seedSearchHome(page, theme);
      await page.goto('/#/browse', { waitUntil: 'networkidle' });
      await expect(page.getByLabel('Search all sites')).toBeVisible();
      await expect(page).toHaveScreenshot(`search-home-mobile-${theme}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
      });
    });

    test(`palette-mobile-${theme} matches its committed fixture`, async ({
      page,
    }: {
      page: Page;
    }): Promise<void> => {
      await seedSearchHome(page, theme);
      await page.goto('/#/browse', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Open command palette' }).click();
      await expect(page.getByTestId('palette-input')).toBeVisible();
      await page.waitForTimeout(400);
      await expect(page).toHaveScreenshot(`palette-mobile-${theme}.png`, {
        animations: 'disabled',
        caret: 'hide',
      });
    });
  });
}

/** Deterministic home state: theme + seeded recents (no timestamps). */
async function seedSearchHome(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((t): void => {
    window.localStorage.setItem('fmd-web-theme', t);
    window.localStorage.setItem(
      'fmd.recent-sites',
      JSON.stringify([
        { id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5dd', name: 'MangaRock' },
        { id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5de', name: 'ManhuaFresh' },
      ]),
    );
    window.localStorage.setItem(
      'fmd.recent-manga',
      JSON.stringify([
        {
          moduleId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
          url: 'https://fixtures.example/manga/alpha',
          title: 'Alpha Quest',
        },
      ]),
    );
  }, theme);
}
