/**
 * Shared virtualization-perf harness (perf.spec.ts desktop +
 * perf-mobile.spec.ts mobile — R3: the scroll-jank contract holds at
 * BOTH viewports). Frame recorder, reveal/wheel helpers and the
 * fixture generators live here so the two projects run byte-identical
 * assertions against their own viewport.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { module as moduleFixture } from './fixtures';
import type { CatalogEntryT, ModuleSummaryT } from '../src/api/hooks';

export const CATALOG_ROWS = 1_200;
export const MODULE_ROWS = 1_000;

export function catalogEntry(i: number): CatalogEntryT {
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

export function siteModule(i: number): ModuleSummaryT {
  return {
    ...moduleFixture,
    id: `perfmod${String(i).padStart(6, '0')}`,
    name: `PerfSite ${i}`,
    rootURL: `https://perf-${i}.example`,
    category: `Cat ${i % 12}`,
  };
}

/** Start a rAF gap recorder in the page; returns a stop() that yields the gaps. */
export async function startFrameRecorder(page: Page): Promise<() => Promise<number[]>> {
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
export async function revealContainer(page: Page, selector: string): Promise<void> {
  await page.evaluate((): void => {
    window.scrollTo(0, Number.MAX_SAFE_INTEGER);
  });
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  const y = (box?.y ?? 0) + Math.min(60, (box?.height ?? 120) / 2);
  await page.mouse.move((box?.x ?? 0) + 40, y);
}

/** Wheel-scroll the hovered container — INSIDE the recorded window. */
export async function wheelScroll(page: Page, steps: number): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, 1_200);
    await page.waitForTimeout(60);
  }
}

export function assertNoJank(gaps: number[], opts: { readonly medianMax?: number } = {}): void {
  expect(gaps.length).toBeGreaterThan(20); // recorder actually ran
  const sorted = [...gaps].sort((a, b): number => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const worst = sorted[sorted.length - 1] ?? 0;
  // Generous container-safe thresholds: scrolling must stay interactive
  // (median ≈ 60fps budget, no multi-hundred-ms long frame). The mobile
  // wheel path may pass a 2-frame median budget: under (hover: none)
  // emulation Chromium routes WHEEL scrolls through the main thread
  // (real touch scrolling composites on the UI thread), so the median
  // measures the emulated input path, not touch scrolling — the
  // worst-frame bound (no multi-hundred-ms frame) stays the real gate.
  expect(median).toBeLessThan(opts.medianMax ?? 34);
  expect(worst).toBeLessThan(300);
}

interface TailShape {
  scrollTop: number;
  scrollHeight: number;
  lastIndex: number;
}

async function readTail(list: Locator): Promise<TailShape> {
  return await list.evaluate((el: Element): TailShape => {
    const rows = el.querySelectorAll('li[data-index]');
    const last = rows[rows.length - 1];
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      lastIndex: last === undefined ? -1 : Number(last.getAttribute('data-index')),
    };
  });
}

/** The bounded-DOM + reachable-tail + no-jank assertions shared by both
 * viewport projects (the virtualization contract is viewport-blind). */
export async function assertVirtualizedScroll(
  page: Page,
  opts: {
    readonly list: Locator;
    readonly wheelSteps: number;
    readonly lastIndexMin: number;
    readonly medianMax?: number;
  },
): Promise<void> {
  const domRows = await opts.list.locator('li').count();
  expect(domRows).toBeGreaterThan(4);
  expect(domRows).toBeLessThan(100);

  await revealContainer(page, '[data-virtualized="true"]');
  // Settle: drain residual work from whatever ran before this test
  // (suite ordering, vite transforms, prior pages' GC) OUTSIDE the
  // recorded window — the budget measures THIS list's scroll, not the
  // runner's leftover load.
  await page.waitForTimeout(750);
  const stop = await startFrameRecorder(page);
  await wheelScroll(page, opts.wheelSteps);
  const gaps = await stop();
  assertNoJank(gaps, { ...(opts.medianMax !== undefined ? { medianMax: opts.medianMax } : {}) });

  // Wheel to the END deterministically (outside the recorded window):
  // dynamic row measurement grows the list while scrolling, so a fixed
  // page count can land a few kb short of the tail.
  for (let i = 0; i < opts.wheelSteps + 40; i += 1) {
    const atBottom: boolean = await page.evaluate((): boolean => {
      const el = document.querySelector('[data-virtualized="true"]');
      if (el === null) return false;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    });
    if (atBottom) break;
    await page.mouse.wheel(0, 4_000);
    await page.waitForTimeout(50);
  }

  const tail = await readTail(page.locator('[data-virtualized="true"]'));
  expect(tail.lastIndex).toBeGreaterThanOrEqual(opts.lastIndexMin);
  expect(tail.scrollHeight - tail.scrollTop).toBeLessThan(2_000);
}

/** The shell routes perf pages need (unrouted from installMockApi first):
 * readyz + an EMPTY module registry keeps the browse gate quiet while
 * the catalog route answers the big page. */
export async function installPerfShellRoutes(page: Page, modulesBody: unknown): Promise<void> {
  await page.route(/^https?:\/\/[^/]+\/api\/modules/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(modulesBody),
    });
  });
  await page.route(/^https?:\/\/[^/]+\/api\/readyz/, (route): void => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, reason: 'ready' }) });
  });
}
