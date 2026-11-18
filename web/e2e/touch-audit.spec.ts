/**
 * TOUCH-AFFORDANCE AUDIT (R3a/R3b — tsk-verdant-manger-hovers, mobile
 * project): two automated sweeps that make the owner ruling ENFORCEABLE
 * rather than aspirational.
 *
 *  (a) TRIGGER AUDIT — every popover/tooltip/dialog/menu trigger the app
 *      renders, enumerated across routes, opened by REAL TAPS (or focus
 *      for hover-shaped tooltips) at the 390×844 touch viewport. Zero
 *      hover-only affordances survive: if a surface cannot open here,
 *      this table fails.
 *
 *  (b) TOUCH-TARGET AUDIT — on every audited route state (including
 *      open overlays), every visible interactive element must meet the
 *      44px touch token in BOTH dimensions (0.5px rendering tolerance).
 *
 * The audit table prints to stdout and lands in
 * docs/evidence-mobile-parity.md (the committed evidence).
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  CATALOG_ID,
  MODULE_ID,
  entries,
  info as infoFixture,
  installMockApi,
  job as jobFixture,
  module as moduleFixture,
} from './fixtures';
import type { FavoriteT, JobT } from '../src/api/hooks';

/** A clean (non-broken, enabled, catalog-installed) registry so the site
 * entries view OPENS without provisioning. */
async function installCleanModules(page: Page): Promise<void> {
  await page.route(/\/api\/modules/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modules: [{ ...moduleFixture, capabilities: { ...moduleFixture.capabilities, known_broken_flags: [] } }],
        count: 1,
      }),
    });
  });
}

/** One favorited manga (the fixture entry) — favorites route + the
 * favorited-row tooltip case. */
const FAVORITE_ID = `${MODULE_ID}${entries[0]?.link ?? ''}`.toLowerCase();
function favoriteRow(): FavoriteT {
  return {
    id: FAVORITE_ID,
    moduleId: MODULE_ID,
    // useFavoriteState matches moduleId + url EXACTLY — the row's
    // mangaUrl is the RAW catalog link, not the resolved absolute URL.
    url: entries[0]?.link ?? '',
    title: 'Alpha Quest',
    status: 'Ongoing',
    enabled: true,
    autoDownload: false,
    currentChapter: null,
    saveTo: '',
    dateAdded: '2026-11-12T00:00:00Z',
    coverLink: null,
    lastCheck: null,
    lastUpdated: null,
    newChapterCount: 0,
  };
}

async function installFavorites(page: Page, rows: readonly FavoriteT[]): Promise<void> {
  await page.route(/\/api\/favorites(\?|$)/, (route): void => {
    if (route.request().method() === 'GET') {
      void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ favorites: rows }) });
    } else {
      void route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ favorite: rows[0] ?? {} }) });
    }
  });
}

function doneJob(): JobT {
  return {
    ...jobFixture,
    id: 'd0ne0000000000000000000000000000',
    state: 'done',
    payload: { mangaTitle: 'Alpha Quest', chapterName: 'Chapter 1' },
    progress: { stage: 'finalize', done: 2, total: 2, libraryPath: '/tmp/lib/d0ne.zip' },
  };
}

async function installJobs(page: Page, jobs: readonly JobT[]): Promise<void> {
  await page.route(/\/api\/jobs\?/, (route): void => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs }) });
  });
}

/** Every overlay trigger under audit. `activate` taps (or focuses) and
 * the case passes when `content` becomes visible. */
interface TriggerCase {
  readonly route: string;
  readonly surface: string;
  readonly activation: 'tap' | 'focus';
  readonly open: (page: Page) => Promise<void>;
  readonly content: (page: Page) => Locator;
  readonly setup?: (page: Page) => void;
}

const MANGA_ROUTE = `/#/manga?catalog=${CATALOG_ID}&module=${MODULE_ID}&url=${encodeURIComponent(
  'https://fixtures.example/manga/alpha',
)}&title=${encodeURIComponent('Alpha Quest')}`;

const TRIGGER_CASES: readonly TriggerCase[] = [
  {
    route: '/#/browse',
    surface: 'command palette (header button)',
    activation: 'tap',
    open: async (page): Promise<void> => {
      await page.getByRole('button', { name: 'Open command palette' }).tap();
    },
    content: (page): Locator => page.getByTestId('palette-input'),
  },
  {
    route: '/#/browse?sites=1',
    surface: 'site picker filters (FilterBar sheet)',
    activation: 'tap',
    open: async (page): Promise<void> => {
      await page.getByRole('button', { name: 'Filters' }).tap();
    },
    content: (page): Locator => page.getByLabel('Search sites'),
  },
  {
    route: `/#/browse?site=${MODULE_ID}`,
    surface: 'entry metadata popover (row TAP — R3a core)',
    activation: 'tap',
    setup: async (page): Promise<void> => {
      await installCleanModules(page);
    },
    open: async (page): Promise<void> => {
      await page.getByRole('button', { name: /^Alpha Quest/ }).tap();
    },
    content: (page): Locator => page.getByTestId('entry-metadata'),
  },
  {
    route: `/#/browse?site=${MODULE_ID}`,
    surface: 'entry row overflow menu (kebab)',
    activation: 'tap',
    setup: async (page): Promise<void> => {
      await installCleanModules(page);
    },
    open: async (page): Promise<void> => {
      await page.getByRole('button', { name: 'Actions for Alpha Quest' }).tap();
    },
    content: (page): Locator => page.getByTestId('entry-row-menu'),
  },
  {
    route: `/#/browse?site=${MODULE_ID}`,
    surface: 'favorited-row tooltip (menu item, FOCUS path)',
    activation: 'focus',
    setup: async (page): Promise<void> => {
      await installCleanModules(page);
      await installFavorites(page, [favoriteRow()]);
    },
    open: async (page): Promise<void> => {
      await page.getByRole('button', { name: 'Actions for Alpha Quest' }).tap();
      await page.getByTestId('menu-add-favorite-wrap').focus();
    },
    content: (page): Locator => page.getByText('Already in favorites'),
  },
  {
    route: MANGA_ROUTE,
    surface: 'manga page (no overlays — target-audited only)',
    activation: 'tap',
    open: async (page): Promise<void> => {
      await page.getByRole('heading', { name: 'Alpha Quest' }).tap();
    },
    content: (page): Locator => page.getByRole('heading', { name: 'Alpha Quest' }),
  },
  {
    route: '/#/downloads',
    surface: 'job row overflow menu (kebab)',
    activation: 'tap',
    setup: async (page): Promise<void> => {
      await installJobs(page, [doneJob()]);
    },
    open: async (page): Promise<void> => {
      await page.getByRole('button', { name: `Actions for job ${doneJob().id}` }).tap();
    },
    content: (page): Locator => page.getByTestId(`job-menu-${doneJob().id}`),
  },
  {
    route: '/#/downloads',
    surface: 'delete-completed confirm dialog (toolbar)',
    activation: 'tap',
    setup: async (page): Promise<void> => {
      await installJobs(page, [doneJob()]);
    },
    open: async (page): Promise<void> => {
      await page.getByTestId('delete-completed').tap();
    },
    content: (page): Locator => page.getByTestId('delete-completed-dialog'),
  },
  {
    route: '/#/favorites',
    surface: 'check-all scope menu',
    activation: 'tap',
    setup: async (page): Promise<void> => {
      await installFavorites(page, [favoriteRow()]);
    },
    open: async (page): Promise<void> => {
      // [UX-AUDIT F-6] the split-button's CARET opens the scope menu.
      await page.getByTestId('check-scope-trigger').tap();
    },
    content: (page): Locator => page.getByTestId('check-scope-menu'),
  },
  {
    route: '/#/favorites',
    surface: 'favorite row overflow menu → Transfer website dialog',
    activation: 'tap',
    setup: async (page): Promise<void> => {
      await installFavorites(page, [favoriteRow()]);
    },
    open: async (page): Promise<void> => {
      await page.getByTestId(`favorite-menu-${FAVORITE_ID}`).tap();
      await page.getByTestId(`favorite-menu-transfer-${FAVORITE_ID}`).tap();
    },
    content: (page): Locator => page.getByRole('dialog').filter({ hasText: 'Transfer website' }),
  },
  {
    route: '/#/favorites',
    surface: 'favorite row overflow menu → Change save-to dialog',
    activation: 'tap',
    setup: async (page): Promise<void> => {
      await installFavorites(page, [favoriteRow()]);
    },
    open: async (page): Promise<void> => {
      await page.getByTestId(`favorite-menu-${FAVORITE_ID}`).tap();
      await page.getByTestId(`favorite-menu-saveto-${FAVORITE_ID}`).tap();
    },
    content: (page): Locator => page.getByRole('dialog').filter({ hasText: 'Change save-to' }),
  },
  {
    route: '/#/favorites',
    surface: 'import list dialog (toolbar)',
    activation: 'tap',
    setup: async (page): Promise<void> => {
      await installFavorites(page, [favoriteRow()]);
    },
    open: async (page): Promise<void> => {
      await page.getByTestId('import-list-button').tap();
    },
    content: (page): Locator => page.getByRole('dialog').filter({ hasText: 'Import' }),
  },
];

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await installMockApi(page);
  await page.route(/^https?:\/\/[^/]+\/api\/readyz$/, (route): Promise<void> => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, reason: 'ready' }),
    });
  });
  await page.route(/\/api\/info$/, (route): void => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(infoFixture) });
  });
});

/** The visible interactive inventory of the CURRENT page state. */
async function collectTargets(page: Page): Promise<{ selector: string; text: string; w: number; h: number }[]> {
  return await page.evaluate((): { selector: string; text: string; w: number; h: number }[] => {
    const SELECTOR = [
      'button',
      'a[href]',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="tab"]',
      '[role="button"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      'label:has(input:enabled)',
      'label:has([role="checkbox"])',
      'label:has([role="radio"])',
      'label:has([role="switch"])',
    ].join(', ');
    const out: { selector: string; text: string; w: number; h: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
      // A checkbox/radio INPUT (or Radix control) inside a label is
      // measured through its LABEL — the real hit area (HIG). Skip the
      // small control itself; the label is in the selector set.
      if (
        (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
        || ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') ?? '')
      ) {
        if (el.closest('label') !== null) {
          continue;
        }
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true') {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      // Only elements actually inside the viewport band (fixed bottom
      // nav + rendered virtual rows are the real touch surface).
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        continue;
      }
      out.push({
        selector: el.tagName.toLowerCase() + (el instanceof HTMLInputElement ? `[type=${el.type}]` : ''),
        text: (el.textContent ?? '').trim().split(/\s+/).slice(0, 4).join(' ').slice(0, 40),
        w: rect.width,
        h: rect.height,
      });
    }
    return out;
  });
}

const TOUCH_MIN = 44;
const TOLERANCE = 0.5;

async function auditTouchTargets(page: Page, state: string): Promise<void> {
  const targets = await collectTargets(page);
  expect(
    targets.length,
    `${state}: the audit must actually see interactive elements`,
  ).toBeGreaterThan(3);
  const violations = targets.filter(
    (t): boolean => t.w < TOUCH_MIN - TOLERANCE || t.h < TOUCH_MIN - TOLERANCE,
  );
  expect(
    violations,
    `${state}: touch targets below ${TOUCH_MIN}px — ${JSON.stringify(violations, null, 2)}`,
  ).toEqual([]);
}

test.describe('R3a trigger audit — every overlay opens via tap/focus at 390×844', (): void => {
  for (const triggerCase of TRIGGER_CASES) {
    test(`${triggerCase.route} — ${triggerCase.surface}`, async ({ page }: { page: Page }): Promise<void> => {
      triggerCase.setup?.(page);
      await page.goto(triggerCase.route);
      await triggerCase.open(page);
      await expect(triggerCase.content(page)).toBeVisible({ timeout: 10_000 });
      // The audit prints the committed evidence table (stdout).
      console.log(`[trigger-audit] OK | ${triggerCase.route} | ${triggerCase.surface} | ${triggerCase.activation}`);
      // While the overlay is OPEN, its items meet the touch floor too.
      // The settle waits out the overlay enter animations (zoom-in-95
      // would otherwise measure 44px targets at ~42px mid-flight).
      await page.waitForTimeout(450);
      await auditTouchTargets(page, `${triggerCase.surface} (open)`);
    });
  }
});

test.describe('R3b touch-target audit — 44px floor on every interactive element', (): void => {
  const ROUTES: readonly { readonly route: string; readonly setup?: (page: Page) => void }[] = [
    { route: '/#/browse' },
    { route: '/#/browse?sites=1' },
    { route: `/#/browse?site=${MODULE_ID}`, setup: async (page): Promise<void> => await installCleanModules(page) },
    { route: MANGA_ROUTE },
    { route: '/#/downloads', setup: async (page): Promise<void> => await installJobs(page, [doneJob()]) },
    { route: '/#/favorites', setup: async (page): Promise<void> => await installFavorites(page, [favoriteRow()]) },
    { route: '/#/library' },
    { route: '/#/settings' },
  ];

  for (const routeCase of ROUTES) {
    test(`${routeCase.route} — every visible control >= 44px`, async ({ page }: { page: Page }): Promise<void> => {
      routeCase.setup?.(page);
      await page.goto(routeCase.route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(150); // fonts + virtual rows settle
      await auditTouchTargets(page, routeCase.route);
    });
  }
});

test.describe('R3 responsive shell — bottom nav <768, top tabs >=768, identical routes', (): void => {
  test('mobile shell: bottom tab bar visible, 5 destinations, active state; top tabs hidden', async ({ page }: { page: Page }): Promise<void> => {
    await page.goto('/#/browse');
    const bottomNav = page.getByTestId('bottom-nav');
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.getByTestId('bottom-nav-browse')).toHaveAttribute('aria-current', 'page');
    for (const name of ['favorites', 'downloads', 'library', 'settings']) {
      await expect(bottomNav.getByTestId(`bottom-nav-${name}`)).toBeVisible();
      await expect(bottomNav.getByTestId(`bottom-nav-${name}`)).not.toHaveAttribute('aria-current', 'page');
    }
    // The top tab strip is the >=md surface.
    await expect(bottomNav).toContainText('Browse');
    const header = page.locator('header nav');
    await expect(header).toBeHidden();

    // Tapping a bottom destination navigates (tap, not click).
    await page.getByTestId('bottom-nav-downloads').tap();
    await expect(page).toHaveURL(/#\/downloads$/);
    await expect(page.getByTestId('bottom-nav-downloads')).toHaveAttribute('aria-current', 'page');
  });

  test('viewport switch keeps the route, swaps the chrome, never shifts layout', async ({ page }: { page: Page }): Promise<void> => {
    await page.goto('/#/favorites');
    await expect(page.getByTestId('bottom-nav')).toBeVisible();

    // Grow past the 768px boundary: bottom nav leaves, top tabs arrive.
    await page.setViewportSize({ width: 900, height: 844 });
    await expect(page.getByTestId('bottom-nav')).toBeHidden();
    await expect(page.locator('header nav')).toBeVisible();
    await expect(page).toHaveURL(/#\/favorites$/);

    // No horizontal overflow at EITHER width (no layout shift).
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await page.evaluate((): boolean => document.documentElement.scrollWidth > window.innerWidth + 1);
      expect(overflow, `horizontal overflow at ${width}px`).toBe(false);
    }
  });
});
