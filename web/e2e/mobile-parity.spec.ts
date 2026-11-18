/**
 * MOBILE PARITY E2E (R3 — tsk-verdant-manger-hovers, mobile project at
 * 390×844 touch): the KEY flows, end-to-end, on the touch surface —
 * the 'equal citizens' claim TESTED, not asserted.
 *
 *   1. picker (chips + search) → entries → metadata popover VIA TAP →
 *      manga page → enqueue incl. start-paused;
 *   2. downloads: pause/resume/retry (+ enable/disable) through the
 *      row controls and kebab menus;
 *   3. favorites: new-chapters sheet decisions + DRAG-DISMISS;
 *   4. settings: module search + per-category bulk toggle.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import {
  MODULE_ID,
  entries,
  installMockApi,
  job as jobFixture,
  module as moduleFixture,
} from './fixtures';
import type { FavoriteT, JobT } from '../src/api/hooks';

async function installCleanModules(page: Page, modules: object[] = []): Promise<void> {
  await page.route(/\/api\/modules/, (route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modules: [
          {
            ...moduleFixture,
            capabilities: { ...moduleFixture.capabilities, known_broken_flags: [] },
          },
          ...modules,
        ],
        count: 1 + modules.length,
      }),
    });
  });
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await installMockApi(page);
  await page.route(/^https?:\/\/[^/]+\/api\/readyz$/, (route): Promise<void> => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, reason: 'ready' }),
    });
  });
});

// ── Flow 1: picker → entries → popover (tap) → manga → enqueue ──────

test('browse journey: picker chips+search → entries → tap-popover → manga → enqueue start-paused', async ({ page }: { page: Page }): Promise<void> => {
  // The longest key flow spans FOUR surfaces (picker sheet → chips →
  // entries popover → manga enqueue ×2) — headroom over the 20s
  // default for full-suite load.
  test.setTimeout(45_000);
  await installCleanModules(page);
  const downloadBodies: Record<string, unknown>[] = [];
  await page.route(/\/api\/jobs\/download$/, (route): void => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    downloadBodies.push(body);
    void route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ job: { ...jobFixture, paused: body['paused'] === true } }),
    });
  });

  // The picker at mobile: the search input collapses into the Sheet
  // (open it, type), the category chips stay on the page under it —
  // the chips + search pair of the site-first picker.
  await page.goto('/#/browse?sites=1');
  await expect(page.getByRole('heading', { name: 'Browse sites' })).toBeVisible();
  await page.getByRole('button', { name: 'Filters' }).tap();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Search sites')).toBeVisible();
  await sheet.getByLabel('Search sites').fill('Fixture');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Category chips (page-level): the All chip clears, the category
  // chip narrows — both tappable.
  await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Fixtures\s*1$/ }).tap();
  await expect(page.getByRole('button', { name: /FixtureSite/ }).first()).toBeVisible();

  // Open the site (tap the row).
  await page.getByRole('button', { name: /FixtureSite/ }).first().tap();
  await expect(page).toHaveURL(new RegExp(`site=${MODULE_ID}`));
  await expect(page.getByRole('button', { name: /^Alpha Quest/ })).toBeVisible();

  // TAP the entry row: the metadata popover opens (R3a) — and the tap
  // must NOT navigate (the popover owns the preview; Open navigates).
  await page.getByRole('button', { name: /^Alpha Quest/ }).tap();
  const popover = page.getByTestId('entry-metadata');
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute('data-entry-link', entries[0]?.link ?? '');
  await expect(page).toHaveURL(new RegExp(`#/browse\\?site=${MODULE_ID}`));

  // Open → the manga page (the popover's explicit action).
  await page.getByTestId('entry-metadata-open').tap();
  await expect(page).toHaveURL(/#\/manga\?/);
  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();

  // Enqueue ONE chapter with Start paused (cbAddAsStopped parity).
  // Chapter rows are label-wrapped checkboxes — tapping the row text
  // selects the chapter.
  await page.getByText('Chapter 1: The Beginning').tap();
  await page.locator('#enqueue-start-paused').check();
  await page.getByRole('button', { name: /Enqueue 1 chapter/ }).tap();
  await expect(page.getByText(/paused — resume it from Downloads/)).toBeVisible();
  expect(downloadBodies.length).toBe(1);
  expect(downloadBodies[0]).toMatchObject({ paused: true, mangaTitle: 'Alpha Quest' });
});

// ── Flow 2: downloads actions (row primary + kebab menus) ───────────

interface DownloadsState {
  jobs: JobT[];
  actions: { id: string; type: string }[];
}

/** The stateful action matrix the flow drives (pause hold/lift, retry). */
async function installStatefulDownloads(page: Page, state: DownloadsState): Promise<void> {
  const json = (route: Route, body: unknown, status = 200): void => {
    void route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  };
  const API = (suffix: string): RegExp => new RegExp(`^https?://[^/]+/api/${suffix}`);

  await page.route(API('jobs\\?'), (route): void => {
    json(route, { jobs: [...state.jobs].reverse() });
  });
  await page.route(API('jobs/\\d+/action'), (route): void => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    const body = route.request().postDataJSON() as { type: string };
    state.actions.push({ id, type: body.type });
    const index = state.jobs.findIndex((row): boolean => row.id === id);
    if (index === -1) {
      json(route, { error: { code: 'not_found', message: 'unknown job' } }, 404);
      return;
    }
    const current = state.jobs[index] as JobT;
    if (body.type === 'pause' && current.state === 'running') {
      state.jobs[index] = { ...current, state: 'cancelled', progress: { stage: 'download', done: 3, total: 10 } };
    } else if ((body.type === 'pause' || body.type === 'disable') && current.state === 'queued') {
      state.jobs[index] = { ...current, paused: true };
    } else if ((body.type === 'resume' || body.type === 'enable') && current.state === 'queued' && current.paused === true) {
      const { paused: _lifted, ...rest } = current;
      void _lifted;
      state.jobs[index] = rest;
    } else if (body.type === 'resume' && current.state === 'cancelled') {
      const { paused: _dropped, ...freshCancelled } = current;
      void _dropped;
      state.jobs.push({ ...freshCancelled, id: String(100 + state.jobs.length), state: 'queued' });
    } else if (body.type === 'retry' && current.state === 'failed') {
      state.jobs.push({ ...current, id: String(100 + state.jobs.length), state: 'queued' });
    } else {
      json(
        route,
        { error: { code: 'conflict', message: `cannot ${body.type} ${id} in ${current.state}` } },
        409,
      );
      return;
    }
    json(route, { job: state.jobs[index] ?? state.jobs[state.jobs.length - 1] });
  });
}

test('downloads: pause/resume round-trip and retry via row controls + kebab menus', async ({ page }: { page: Page }): Promise<void> => {
  const state: DownloadsState = {
    jobs: [
      { ...jobFixture, id: '20', payload: { mangaTitle: 'Alpha Quest', chapterName: 'Chapter 1' }, state: 'running', progress: { stage: 'download', done: 3, total: 10, rate: 204800 } },
      { ...jobFixture, id: '21', payload: { mangaTitle: 'Beta Trails', chapterName: 'Chapter 2' }, state: 'failed', error: 'upstream 500' },
    ],
    actions: [],
  };
  await installStatefulDownloads(page, state);

  await page.goto('/#/downloads');
  await expect(page.locator('[data-job-id="20"]')).toBeVisible();

  // Mobile row anatomy: title line + SECONDARY line (badge+progress);
  // the id chip is hidden on the compact surface.
  await expect(page.locator('[data-job-id="20"] .job-title')).toBeVisible();
  await expect(page.locator('[data-job-id="20"] [data-testid="job-progress-count"]')).toBeVisible();

  // Pause the running job (primary control, tapped).
  await page.locator('[data-job-id="20"] >> button[aria-label^="Pause job"]').tap();
  await expect(page.locator('[data-job-id="20"] .badge')).toHaveAttribute('data-status', 'stopped');

  // Resume the stopped job (primary) → a FRESH queued row (the mock
  // mints ids as 100 + current job count: two seeds → 102).
  await page.locator('[data-job-id="20"] >> button[aria-label^="Resume job"]').tap();
  await expect(page.locator('[data-job-id="102"] .badge')).toHaveAttribute('data-status', 'waiting');

  // Hold the fresh row VIA THE KEBAB MENU (Disable = resume-able hold)
  // — the menu path on touch.
  await page.locator('[data-job-id="102"] button[aria-label^="Actions for job"]').tap();
  await page.getByTestId('job-action-disable').tap();
  await expect(page.locator('[data-job-id="102"] .badge')).toHaveAttribute('data-status', 'stopped');
  // Settle: the action invalidates + refetches the list; tapping the
  // row's buttons mid-re-render can hit a replaced node (the row
  // re-orders — newest first — after the refetch lands).
  await page.waitForTimeout(350);
  // …and lift the hold via the paused row's PRIMARY control (Resume).
  await page.locator('[data-job-id="102"] >> button[aria-label^="Resume job"]').tap();
  await expect(page.locator('[data-job-id="102"] .badge')).toHaveAttribute('data-status', 'waiting');

  // Retry the failed job (primary) → a fresh queued row (three rows
  // at this point → 103).
  await page.locator('[data-job-id="21"] >> button[aria-label^="Retry job"]').tap();
  await expect(page.locator('[data-job-id="103"] .badge')).toHaveAttribute('data-status', 'waiting');

  expect(state.actions).toContainEqual({ id: '20', type: 'pause' });
  expect(state.actions).toContainEqual({ id: '20', type: 'resume' });
  expect(state.actions).toContainEqual({ id: '102', type: 'disable' });
  expect(state.actions).toContainEqual({ id: '102', type: 'resume' });
  expect(state.actions).toContainEqual({ id: '21', type: 'retry' });
});

// ── Flow 3: favorites new-chapters sheet + drag-dismiss ─────────────

async function installFavoritesFlow(page: Page): Promise<{ downloads: { paused: boolean[] } }> {
  const downloads = { paused: [] as boolean[] };
  const row: FavoriteT = {
    id: `${MODULE_ID}${entries[0]?.link ?? ''}`.toLowerCase(),
    moduleId: MODULE_ID,
    url: `https://fixtures.example${entries[0]?.link ?? ''}`,
    title: 'Alpha Quest',
    status: 'Ongoing',
    enabled: true,
    autoDownload: false,
    currentChapter: null,
    saveTo: '',
    dateAdded: '2026-11-12T00:00:00Z',
    lastCheck: null,
    lastUpdated: null,
    newChapterCount: 0,
  };
  const NEW_CHAPTERS = [
    { position: 1, link: '/manga/alpha/ch-1', name: 'Chapter 1: The Beginning' },
    { position: 2, link: '/manga/alpha/ch-2', name: 'Chapter 2: The Middle' },
  ];
  const json = (route: Route, body: unknown, status = 200): void => {
    void route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  };
  await page.route(/^https?:\/\/[^/]+\/api\/favorites(\?|$)/, (route): void => {
    if (route.request().method() === 'GET') {
      json(route, { favorites: [row] });
    } else {
      json(route, { favorite: row }, 201);
    }
  });
  await page.route(/^https?:\/\/[^/]+\/api\/favorites\/check$/, (route): void => {
    json(route, {
      scope: 'all',
      cancelled: false,
      checked: 1,
      failed: 0,
      queuedDownloads: 0,
      results: [
        {
          favorite: { ...row, newChapterCount: NEW_CHAPTERS.length, currentChapter: 2 },
          status: 'checked',
          newChapters: NEW_CHAPTERS,
          queuedDownloads: 0,
        },
      ],
    });
  });
  await page.route(/\/api\/jobs\/download$/, (route): void => {
    const body = route.request().postDataJSON() as { paused?: boolean };
    downloads.paused.push(body.paused === true);
    void route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ job: { ...jobFixture, paused: body.paused === true } }),
    });
  });
  return { downloads };
}

test('favorites: batch check opens the sheet; queue decision enqueues PAUSED; drag-dismiss closes', async ({ page }: { page: Page }): Promise<void> => {
  const { downloads } = await installFavoritesFlow(page);

  await page.goto('/#/favorites');
  // Mobile collapse: the dense grid columns are GONE — the secondary
  // meta line carries them (responsive data-table contract).
  await expect(page.locator('.favorite-columns-meta').first()).toBeVisible();
  await expect(page.locator('.favorite-col-website').first()).toBeHidden();

  await page.getByTestId('check-all-button').tap();
  await page.getByTestId('check-scope-all').tap();

  const sheet = page.getByTestId('new-chapters-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('2 new chapters');

  // Add to queue → PAUSED jobs (the sheet's queue decision).
  await sheet.getByTestId(`newchapter-queue-${`${MODULE_ID}${entries[0]?.link ?? ''}`.toLowerCase()}`).tap();
  await expect(sheet.getByTestId('newchapter-pending-count')).toHaveText('0 pending decisions');
  expect(downloads.paused).toEqual([true, true]);

  // DRAG-DISMISS: grab the handle, pull past the threshold, release.
  const handle = page.getByTestId('new-chapters-drag-handle');
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 10);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 140, { steps: 10 });
  await page.mouse.up();
  await expect(sheet).toBeHidden();
});

// ── Flow 4: settings Websites facets + bulk on the touch surface ────

test('settings: facets + module search narrow; bulk toggles fire scoped writes; proxy drawer opens via tap', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  // A no-setup sibling so the NEEDS SETUP facet has both values.
  // (installed BEFORE the bulk route: Playwright matches handlers in
  // reverse registration order and this broad /api/modules/ pattern
  // would otherwise swallow the POST /api/modules/bulk capture)
  await installCleanModules(page, [
    { ...moduleFixture, id: '9'.repeat(32), name: 'PlainSite', category: 'Fixtures', accountSupport: false },
  ]);
  const bulkWrites: Array<Record<string, unknown>> = [];
  await page.route(/\/api\/modules\/bulk$/, (route): void => {
    if (route.request().method() === 'POST') {
      bulkWrites.push(route.request().postDataJSON() as Record<string, unknown>);
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modules: [],
        updated: 1,
      }),
    });
  });

  await page.goto('/#/settings');

  // The facet bar is fully tappable at 390px: the LANGUAGE chip
  // narrows the list AND lands in the URL.
  const facets = page.getByTestId('module-facets');
  await expect(facets.getByRole('group', { name: 'Language' }).getByRole('button', { name: /Fixtures 2/ })).toBeVisible();
  await facets.getByRole('group', { name: 'Language' }).getByRole('button', { name: /Fixtures 2/ }).tap();
  await expect(page).toHaveURL(/#\/settings\?lang=Fixtures$/);
  await expect(page.getByRole('status').filter({ hasText: '2/2 sites match' })).toBeVisible();

  // The user-requested "no setup" filter is a tap away.
  await facets.getByRole('group', { name: 'Needs setup' }).getByRole('button', { name: /No setup needed 1/ }).tap();
  await expect(page.getByLabel('PlainSite', { exact: true })).toBeVisible();
  await expect(page.getByLabel('FixtureSite', { exact: true })).toHaveCount(0);

  // Module search still narrows (AND-composed with the facets).
  const search = page.getByLabel('Search modules by name or category');
  await search.fill('Plain');
  await expect(page.getByRole('status').filter({ hasText: '1/2 sites match' })).toBeVisible();

  // Per-category bulk disable through the category header (tap).
  const header = page.getByTestId('module-category-header').first();
  await expect(header).toBeVisible();
  await header.getByRole('button', { name: 'Disable all modules in Fixtures' }).tap();
  await expect
    .poll((): number => bulkWrites.length)
    .toBeGreaterThanOrEqual(1);
  expect(bulkWrites[0]).toMatchObject({ enabled: false, category: 'Fixtures' });

  // The collapsed proxy drawer opens via its single tap affordance and
  // the SetProxy editor inside is usable.
  const section = page.getByTestId('proxy-section');
  await section.getByTestId('proxy-drawer-open').tap();
  const drawer = page.getByTestId('proxy-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('Type')).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).tap();
  await expect(drawer).toBeHidden();
});
