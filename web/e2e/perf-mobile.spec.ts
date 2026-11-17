/**
 * Mobile virtualization perf (R3 — tsk-verdant-manger-hovers): the
 * SAME bounded-DOM / no-jank / reachable-tail contract as the desktop
 * perf spec, at the mobile project's 390×844 touch viewport. The list
 * geometry changes (narrower rows, more wrapping) — the virtualization
 * and scroll-jank guarantees must NOT (equal citizens: layout adapts,
 * capability does not).
 */
import { test, expect, type Page } from '@playwright/test';
import { CATALOG_ID, installMockApi } from './fixtures';

// deviceScaleFactor 1 (the mobile PROJECT runs @3x for visual parity):
// the perf budget measures the DATA PATH (virtualization, jank), not
// the 3× software rasterization of an offline headless sandbox — at
// @3x every rAF pays ~9× the pixels and the median triples (~83ms)
// without any app-side change. Viewport + touch stay mobile.
test.use({ deviceScaleFactor: 1 });

// Mobile lists are taller (wrapped meta lines) — the wheel-to-tail
// loops take proportionally longer than the desktop budget.
test.setTimeout(60_000);
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

test('Browse catalog @390: 1200 rows render virtualized, scroll to the tail without jank', async ({ page }: { page: Page }): Promise<void> => {
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

  const list = page.locator('.catalog-list');
  await expect(list.locator('[data-virtualized="true"]')).toHaveCount(0); // hook sits on the scroll parent
  await expect(page.locator('[data-virtualized="true"]')).toHaveCount(1);
  await assertVirtualizedScroll(page, { list, wheelSteps: 60, lastIndexMin: CATALOG_ROWS - 20, medianMax: 68 });
  await expect(page.getByRole('button', { name: new RegExp(`^Perf Entry ${CATALOG_ROWS - 1}( |$)`) })).toBeAttached();
});

test('Settings site list @390: 1000 modules render virtualized, scroll without jank', async ({ page }: { page: Page }): Promise<void> => {
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
  const moduleList = page.getByRole('list', { name: 'Site modules' });
  await expect(moduleList.getByText('PerfSite 0', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Modules \(1000\)/)).toBeVisible();

  const list = page.locator('.module-list');
  await expect(page.locator('[data-virtualized="true"]')).toHaveCount(1);
  await assertVirtualizedScroll(page, { list, wheelSteps: 100, lastIndexMin: MODULE_ROWS - 20, medianMax: 68 });
  await expect(page.getByText(`PerfSite ${MODULE_ROWS - 1}`).first()).toBeAttached();
});
