/**
 * Virtualization perf smoke (design system AC): the site list
 * (Settings modules) and catalog rows (Browse) render 1000+ items
 * with a bounded DOM and no scroll jank. The mock routes deliberately
 * ignore the app's page size and answer with 1200-entry / 1000-module
 * pages — the ListPanel virtualizes above its threshold and this spec
 * proves it: few rows in the DOM, scroll reaches the tail, and no
 * long frame while scrolling.
 */
import { test, expect, type Page } from '@playwright/test';
import { CATALOG_ID, installMockApi } from './fixtures';
import type { CatalogEntryT, ModuleSummaryT } from '../src/api/hooks';
import {
  CATALOG_ROWS,
  MODULE_ROWS,
  assertVirtualizedScroll,
  catalogEntry,
  siteModule,
} from './perf-helpers';

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await installMockApi(page);
});

test('Browse catalog: 1200 rows render virtualized, scroll to the tail without jank', async ({ page }: { page: Page }): Promise<void> => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(/^https?:\/\/[^/]+\/api\/catalog\/[^/]+\/latest/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: Array.from({ length: CATALOG_ROWS }, (_, i): CatalogEntryT => catalogEntry(i)),
        total: CATALOG_ROWS,
      }),
    });
  });
  // readyz + modules for the shell queries (catch-all from installMockApi
  // was unrouted; re-add the minimal set the shell needs — the site-first
  // browse gate requires the registry to resolve before entries open).
  await page.route(/^https?:\/\/[^/]+\/api\/modules/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ modules: [], count: 0 }),
    });
  });
  await page.route(/^https?:\/\/[^/]+\/api\/readyz/, (route): void => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, reason: 'ready' }) });
  });

  await page.goto(`/#/browse?catalog=${CATALOG_ID}`);
  await expect(page.getByRole('button', { name: /^Perf Entry 0/ })).toBeVisible({ timeout: 10_000 });

  // Virtualization engaged + the DOM stays bounded, jank-free, tail
  // reachable (shared assertions with the mobile viewport project).
  const list = page.locator('.catalog-list');
  await expect(list.locator('[data-virtualized="true"]')).toHaveCount(0); // hook sits on the scroll parent
  await expect(page.locator('[data-virtualized="true"]')).toHaveCount(1);
  await assertVirtualizedScroll(page, { list, wheelSteps: 60, lastIndexMin: CATALOG_ROWS - 20 });
  await expect(page.getByRole('button', { name: new RegExp(`^Perf Entry ${CATALOG_ROWS - 1}( |$)`) })).toBeAttached();
});

test('Settings site list: 1000 modules render virtualized, scroll without jank', async ({ page }: { page: Page }): Promise<void> => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(/^https?:\/\/[^/]+\/api\/modules/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modules: Array.from({ length: MODULE_ROWS }, (_, i): ModuleSummaryT => siteModule(i)),
        count: MODULE_ROWS,
      }),
    });
  });
  await page.route(/^https?:\/\/[^/]+\/api\/readyz/, (route): void => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, reason: 'ready' }) });
  });

  await page.goto('/#/settings');
  // Scoped to the module list: the Settings page also renders account
  // cards (settings-parity) whose texts carry the same site names.
  const moduleList = page.getByRole('list', { name: 'Site modules' });
  await expect(moduleList.getByText('PerfSite 0', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Modules \(1000\)/)).toBeVisible();

  const list = page.locator('.module-list');
  await expect(page.locator('[data-virtualized="true"]')).toHaveCount(1);
  // 100 pages ≈ 120k px: the settings rows carry the row actions
  // (configure + re-sync catalog, settings-parity) and measure ~2× the
  // default estimate — the budget must cover the real list height,
  // not the estimate. (Virtualization + jank is the contract, not
  // the page count.)
  await assertVirtualizedScroll(page, { list, wheelSteps: 100, lastIndexMin: MODULE_ROWS - 20 });
  // The tail row: the Websites list sorts by (category, name) — the
  // registration-order LAST module (PerfSite 999, category 'Cat 3')
  // sits mid-list now; the sorted tail is the lexicographic max of
  // the last string-sorted category 'Cat 9' (i % 12 === 9 → 993).
  await expect(page.getByText('PerfSite 993', { exact: true }).first()).toBeAttached();
});
