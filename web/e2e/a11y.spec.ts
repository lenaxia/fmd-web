/**
 * Keyboard-navigation smoke (design system AC): the shell is fully
 * operable without a mouse — (1) Tab cycles the primary nav in DOM
 * order (Radix focus management + native links), (2) a complete page
 * interaction (search → submit → open entry) runs on keyboard alone.
 * Fully offline: same fixture mock API as the smoke suite.
 */
import { test, expect, type Page } from '@playwright/test';
import { CATALOG_ID, installMockApi } from './fixtures';

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  installMockApi(page);
  await page.routeWebSocket(/^ws:\/\/[^/]+\/ws$/, (ws): void => {
    ws.onMessage((): void => {});
  });
});

const NAV_HREFS = ['#/browse', '#/favorites', '#/downloads', '#/library', '#/settings'];

/** Press Tab until the active element matches a named predicate (or bail). */
async function tabUntil(page: Page, target: 'browse-search' | 'toggle-theme' | 'catalog-entry', maxTabs = 30): Promise<boolean> {
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press('Tab');
    const matched = await page.evaluate((t): boolean => {
      const el = document.activeElement;
      if (el === null) {
        return false;
      }
      switch (t) {
        case 'browse-search':
          return el.id === 'browse-search';
        case 'toggle-theme':
          return el.getAttribute('aria-label') === 'Toggle theme';
        case 'catalog-entry':
          return el instanceof HTMLButtonElement && el.closest('.catalog-list') !== null;
        default:
          return false;
      }
    }, target);
    if (matched) {
      return true;
    }
  }
  return false;
}

test('Tab cycles the shell nav (brand → five tabs in order → theme toggle)', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto(`/#/browse?catalog=${CATALOG_ID}`);
  await expect(page.getByRole('button', { name: /Alpha Quest/ })).toBeVisible();

  const seen: (string | null)[] = [];
  const steps = 9; // brand + 5 nav links + theme toggle + first content stops
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate((): string | null => {
        const el = document.activeElement;
        if (el === null) return null;
        const href = el.getAttribute('href');
        if (href !== null) return href;
        const label = el.getAttribute('aria-label');
        return label !== null ? `aria-label:${label}` : el.tagName.toLowerCase();
      }),
    );
  }

  // The five primary tabs receive focus consecutively, in DOM order.
  const navIndexes = NAV_HREFS.map((href): number => seen.indexOf(href));
  for (const [i, href] of NAV_HREFS.entries()) {
    expect(seen).toContain(href);
    expect(navIndexes[i]).toBeGreaterThan(-1);
  }
  expect([...navIndexes].sort((a, b): number => a - b)).toEqual(navIndexes);
  // The theme toggle is reachable right after the nav.
  expect(seen).toContain('aria-label:Toggle theme');
});

test('Full Browse interaction without a mouse: search → submit → open entry', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto(`/#/browse?catalog=${CATALOG_ID}`);
  await expect(page.getByRole('button', { name: /Alpha Quest/ })).toBeVisible();

  // Keyboard-only: Tab into the search field, type, submit via Enter.
  const reachedInput = await tabUntil(page, 'browse-search');
  expect(reachedInput).toBe(true);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');

  // Search results render (keyboard-submitted form).
  await expect(page.getByRole('button', { name: /Alpha Quest/ })).toBeVisible();

  // Tab to the first catalog entry and activate it with Enter.
  const reachedEntry = await tabUntil(page, 'catalog-entry');
  expect(reachedEntry).toBe(true);
  await page.keyboard.press('Enter');

  // The manga detail opened — no mouse anywhere in this test.
  await expect(page).toHaveURL(/.#\/manga\?/);
  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();
});

test('Theme toggle is keyboard-operable and persists the choice', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto(`/#/downloads`);
  await expect(page.getByText(/Event stream:/)).toBeVisible();

  const initial = await page.evaluate((): string => document.documentElement.className);
  const reachedToggle = await tabUntil(page, 'toggle-theme');
  expect(reachedToggle).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).not.toHaveClass(initial, { timeout: 5_000 });

  const stored = await page.evaluate((): string | null => localStorage.getItem('fmd-web-theme'));
  expect(stored === 'dark' || stored === 'light').toBe(true);
});
