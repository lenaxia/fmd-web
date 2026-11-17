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
import { CATALOG_ID, installMockApi, module as moduleFixture } from './fixtures';
import type { CatalogEntryT, ModuleSummaryT } from '../src/api/hooks';

const CATALOG_ROWS = 1_200;
const MODULE_ROWS = 1_000;

function catalogEntry(i: number): CatalogEntryT {
  return {
    link: `/manga/perf-${i}`,
    title: `Perf Entry ${i}`,
    alttitles: '',
    authors: `Author ${i % 40}`,
    artists: '',
    genres: 'Action',
    status: 'Ongoing',
    summary: '',
    numChapter: i % 50,
    jdn: CATALOG_ROWS - i,
  };
}

function siteModule(i: number): ModuleSummaryT {
  return {
    ...moduleFixture,
    id: `perfmod${String(i).padStart(6, '0')}`,
    name: `PerfSite ${i}`,
    rootURL: `https://perf-${i}.example`,
    category: `Cat ${i % 12}`,
  };
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  installMockApi(page);
});

/** Start a rAF gap recorder in the page; returns a stop() that yields the gaps. */
async function startFrameRecorder(page: Page): Promise<() => Promise<number[]>> {
  await page.evaluate((): void => {
    const w = window as typeof window & { __fmdGaps: number[]; __fmdLast: number };
    w.__fmdGaps = [];
    w.__fmdLast = 0;
    const tick = (t: number): void => {
      const gaps = (window as typeof window & { __fmdGaps: number[] }).__fmdGaps;
      const last = (window as typeof window & { __fmdLast: number }).__fmdLast;
      if (last > 0) {
        gaps.push(t - last);
      }
      (window as typeof window & { __fmdLast: number }).__fmdLast = t;
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
  return async (): Promise<number[]> =>
    page.evaluate((): number[] => [...((window as typeof window & { __fmdGaps?: number[] }).__fmdGaps ?? [])]);
}

/** Bring the list fully into the viewport and hover it (BELOW the
 * recorded window — the page-jump itself must not count as jank). */
async function revealContainer(page: Page, selector: string): Promise<void> {
  await page.evaluate((): void => {
    window.scrollTo(0, Number.MAX_SAFE_INTEGER);
  });
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  const y = (box?.y ?? 0) + Math.min(60, (box?.height ?? 120) / 2);
  await page.mouse.move((box?.x ?? 0) + 40, y);
}

/** Wheel-scroll the hovered container — INSIDE the recorded window. */
async function wheelScroll(page: Page, steps: number): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, 1_200);
    await page.waitForTimeout(60);
  }
}

function assertNoJank(gaps: number[]): void {
  expect(gaps.length).toBeGreaterThan(20); // recorder actually ran
  const sorted = [...gaps].sort((a, b): number => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const worst = sorted[sorted.length - 1] ?? 0;
  // Generous container-safe thresholds: scrolling must stay interactive
  // (median ≈ 60fps budget, no multi-hundred-ms long frame).
  expect(median).toBeLessThan(34);
  expect(worst).toBeLessThan(300);
}

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
  await expect(page.getByRole('button', { name: /Perf Entry 0/ })).toBeVisible({ timeout: 10_000 });

  // Virtualization engaged + the DOM stays bounded (≈viewport + overscan).
  const list = page.locator('.catalog-list');
  await expect(list.locator('[data-virtualized="true"]')).toHaveCount(0); // hook sits on the scroll parent
  await expect(page.locator('[data-virtualized="true"]')).toHaveCount(1);
  const domRows = await list.locator('li').count();
  expect(domRows).toBeGreaterThan(4);
  expect(domRows).toBeLessThan(100);

  // Scroll to the tail under a frame recorder: no long frames.
  await revealContainer(page, '[data-virtualized="true"]');
  const stop = await startFrameRecorder(page);
  await wheelScroll(page, 60);
  const gaps = await stop();
  assertNoJank(gaps);

  // The tail is reachable: the scroll position is at the end and the
  // virtualizer renders the final rows (bounded DOM, on-demand range).
  const tail = await page.evaluate((): { scrollTop: number; scrollHeight: number; lastIndex: number } => {
    const el = document.querySelector('[data-virtualized="true"]');
    if (el === null) return { scrollTop: -1, scrollHeight: -1, lastIndex: -1 };
    const rows = el.querySelectorAll('li[data-index]');
    const last = rows[rows.length - 1];
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      lastIndex: last === undefined ? -1 : Number(last.getAttribute('data-index')),
    };
  });
  expect(tail.lastIndex).toBeGreaterThanOrEqual(CATALOG_ROWS - 20);
  expect(tail.scrollHeight - tail.scrollTop).toBeLessThan(2_000); // actually at the end
  await expect(page.getByRole('button', { name: `Perf Entry ${CATALOG_ROWS - 1}` })).toBeAttached();
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
  await expect(page.getByText('PerfSite 0')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Modules \(1000\)/)).toBeVisible();

  const list = page.locator('.module-list');
  await expect(page.locator('[data-virtualized="true"]')).toHaveCount(1);
  const domRows = await list.locator('li').count();
  expect(domRows).toBeGreaterThan(4);
  expect(domRows).toBeLessThan(100);

  await revealContainer(page, '[data-virtualized="true"]');
  const stop = await startFrameRecorder(page);
  await wheelScroll(page, 60);
  const gaps = await stop();
  assertNoJank(gaps);

  const tail = await page.evaluate((): { scrollTop: number; scrollHeight: number; lastIndex: number } => {
    const el = document.querySelector('[data-virtualized="true"]');
    if (el === null) return { scrollTop: -1, scrollHeight: -1, lastIndex: -1 };
    const rows = el.querySelectorAll('li[data-index]');
    const last = rows[rows.length - 1];
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      lastIndex: last === undefined ? -1 : Number(last.getAttribute('data-index')),
    };
  });
  expect(tail.lastIndex).toBeGreaterThanOrEqual(MODULE_ROWS - 20);
  expect(tail.scrollHeight - tail.scrollTop).toBeLessThan(2_000);
  await expect(page.getByText(`PerfSite ${MODULE_ROWS - 1}`).first()).toBeAttached();
});
