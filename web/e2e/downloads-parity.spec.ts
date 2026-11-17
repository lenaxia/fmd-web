/**
 * Downloads-parity e2e (FMD2 tsDownload tab; tsk-retro-fountain-tasks):
 * task actions round-trip (pause → stopped, resume → fresh queued row),
 * the REAL progress bar (images done/total from the payload, advancing
 * across the mock), URL-synced filters (state chips + search + date
 * window incl. custom range) — and NO raw JSON anywhere in the DOM
 * (grep assertion).
 *
 * Stateful mock API only (loopback + interception, like the parity
 * specs before it); the WS feed is left offline — the list renders
 * from REST and the assertions key on the durable REST truth.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { installMockApi, MODULE_ID } from './fixtures';
import type { JobT } from '../src/api/hooks';

interface JobsState {
  jobs: JobT[];
  actions: { id: string; type: string }[];
  bulk: { action: string; scope: string }[];
  deleted: { id: string; data: boolean }[];
  seenQueries: string[];
}

function job(id: string, overrides: Partial<JobT> = {}): JobT {
  return {
    id,
    type: 'download',
    moduleId: MODULE_ID,
    payload: {
      moduleId: MODULE_ID,
      mangaUrl: 'https://fixtures.example/manga/alpha',
      mangaTitle: 'Alpha Quest',
      chapterLink: 'https://fixtures.example/manga/alpha/ch-1',
      chapterName: 'Chapter 1: The Beginning',
    },
    state: 'queued',
    priority: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function installStatefulDownloads(page: Page, state: JobsState): Promise<void> {
  const json = (route: Route, body: unknown, status = 200): void => {
    void route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  };
  const API = (suffix: string): RegExp => new RegExp(`^https?://[^/]+/api/${suffix}`);

  // List — honors states/q (URL-sync proof: the mock filters).
  await page.route(API('jobs\\?'), (route): void => {
    const url = new URL(route.request().url());
    state.seenQueries.push(url.search);
    let rows = [...state.jobs];
    const states = url.searchParams.get('states');
    if (states !== null) {
      const set = new Set(states.split(','));
      rows = rows.filter((row): boolean => set.has(row.state));
    }
    const q = url.searchParams.get('q');
    if (q !== null && q !== '') {
      const needle = q.toLowerCase();
      rows = rows.filter((row): boolean => {
        const payload = row.payload as Record<string, unknown>;
        const title = typeof payload['mangaTitle'] === 'string' ? payload['mangaTitle'] : '';
        const chapter = typeof payload['chapterName'] === 'string' ? payload['chapterName'] : '';
        return title.toLowerCase().includes(needle) || chapter.toLowerCase().includes(needle);
      });
    }
    json(route, { jobs: [...rows].reverse() });
  });

  // Per-job action — the stateful matrix subset the spec drives.
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
      json(route, { job: state.jobs[index] });
      return;
    }
    if (body.type === 'pause' && current.state === 'queued') {
      state.jobs[index] = { ...current, paused: true };
      json(route, { job: state.jobs[index] });
      return;
    }
    if ((body.type === 'resume' || body.type === 'enable') && current.state === 'queued' && current.paused === true) {
      const { paused: _lifted, ...rest } = current;
      void _lifted;
      state.jobs[index] = rest;
      json(route, { job: rest });
      return;
    }
    if (body.type === 'resume' && current.state === 'cancelled') {
      const fresh = job(String(100 + state.jobs.length), {
        payload: current.payload,
        state: 'queued',
      });
      state.jobs.push(fresh);
      json(route, { job: fresh });
      return;
    }
    if (body.type === 'redownload' && current.state === 'done') {
      const fresh = job(String(100 + state.jobs.length), {
        payload: current.payload,
        state: 'queued',
      });
      state.jobs.push(fresh);
      json(route, { job: fresh });
      return;
    }
    json(
      route,
      {
        error: {
          code: 'conflict',
          message: `cannot ${body.type} job ${id} in state ${current.state}`,
          details: { job: { id, state: current.state, paused: current.paused === true }, action: body.type },
        },
      },
      409,
    );
  });

  await page.route(API('jobs/\\d+$'), (route): void => {
    if (route.request().method() !== 'DELETE') {
      json(route, {}, 404);
      return;
    }
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').at(-1) ?? '';
    const data = url.searchParams.get('data') === 'true';
    state.deleted.push({ id, data });
    const index = state.jobs.findIndex((row): boolean => row.id === id);
    if (index === -1) {
      json(route, { error: { code: 'not_found', message: 'unknown job' } }, 404);
      return;
    }
    const removed = state.jobs[index] as JobT;
    state.jobs.splice(index, 1);
    json(route, { job: removed, dataDeleted: data });
  });

  await page.route(API('jobs/bulk-action'), (route): void => {
    const body = route.request().postDataJSON() as { action: string; scope: string };
    state.bulk.push({ action: body.action, scope: body.scope });
    const touched: JobT[] = [];
    for (const [index, row] of state.jobs.entries()) {
      if (body.action === 'pause') {
        if (row.state === 'queued' && row.paused !== true) {
          state.jobs[index] = { ...row, paused: true };
          touched.push(state.jobs[index] as JobT);
        } else if (row.state === 'running') {
          state.jobs[index] = { ...row, state: 'cancelled' };
          touched.push(state.jobs[index] as JobT);
        }
      } else if (body.action === 'resume') {
        if (row.state === 'queued' && row.paused === true) {
          const { paused: _lifted, ...rest } = row;
          void _lifted;
          state.jobs[index] = rest;
          touched.push(rest);
        }
      } else if (body.action === 'delete' && row.state === 'done') {
        touched.push(row);
      }
    }
    if (body.action === 'delete') {
      state.jobs = state.jobs.filter((row): boolean => row.state !== 'done');
    }
    json(route, { action: body.action, scope: body.scope, affected: touched.length, jobs: touched });
  });
}

test('pause/resume round-trip: running → stopped → fresh queued row', async ({ page }: { page: Page }): Promise<void> => {
  const state: JobsState = {
    jobs: [job('1', { state: 'running', progress: { stage: 'download', done: 3, total: 10, rate: 204800 } })],
    actions: [],
    bulk: [],
    deleted: [],
    seenQueries: [],
  };
  await installMockApi(page);
  await installStatefulDownloads(page, state);

  await page.goto('/#downloads');
  await expect(page.locator('[data-job-id="1"]')).toBeVisible();
  // FMD2 palette badge + real bar + transfer rate from the payload.
  await expect(page.locator('[data-job-id="1"] .badge')).toHaveAttribute('data-status', 'downloading');
  await expect(page.locator('[data-testid="job-progress-count"]')).toHaveText('3/10');
  await expect(page.locator('[data-testid="job-rate"]')).toHaveText('200 KiB/s');

  // Pause (primary control) → stopped badge.
  await page.locator('[data-job-id="1"] >> button[aria-label^="Pause job"]').click();
  await expect(page.locator('[data-job-id="1"] .badge')).toHaveAttribute('data-status', 'stopped');

  // Resume via the row's primary control (cancelled → resume is the
  // primary action; the overflow menu omits the primary) → a FRESH
  // queued row appears (mock id: 100 + prior row count = 101).
  await page.locator('[data-job-id="1"] >> button[aria-label^="Resume job"]').click();
  await expect(page.locator('[data-job-id="101"] .badge')).toHaveAttribute('data-status', 'waiting');
  expect(state.actions).toContainEqual({ id: '1', type: 'pause' });
  expect(state.actions).toContainEqual({ id: '1', type: 'resume' });
});

test('progress bar renders and advances from the payload (no raw JSON in the DOM)', async ({ page }: { page: Page }): Promise<void> => {
  const state: JobsState = {
    jobs: [job('2', { state: 'running', progress: { stage: 'download', done: 2, total: 10 } })],
    actions: [],
    bulk: [],
    deleted: [],
    seenQueries: [],
  };
  await installMockApi(page);
  await installStatefulDownloads(page, state);

  await page.goto('/#downloads');
  await expect(page.locator('[data-testid="job-progress-count"]')).toHaveText('2/10');
  const bar = page.locator('.job-progress-bar');
  await expect(bar).toBeVisible();

  // The mock advances; a reload re-renders the REAL bar at 90%.
  state.jobs[0] = { ...(state.jobs[0] as JobT), progress: { stage: 'download', done: 9, total: 10, rate: 4096 } };
  await page.reload();
  await expect(page.locator('[data-testid="job-progress-count"]')).toHaveText('9/10');
  await expect(page.locator('[data-testid="job-rate"]')).toHaveText('4 KiB/s');

  // NO raw JSON anywhere in the jobs DOM (the old page printed it).
  const listText = await page.locator('.job-list').innerText();
  expect(listText).not.toContain('{');
  expect(listText).not.toContain('"stage"');
});

test('filters are URL-synced and drive the list (chips, search, date window, custom range)', async ({ page }: { page: Page }): Promise<void> => {
  const today = new Date().toISOString().slice(0, 10);
  const state: JobsState = {
    jobs: [
      job('3', { state: 'queued', createdAt: `${today}T10:00:00.000Z`, payload: { mangaTitle: 'Alpha Quest', chapterName: 'Chapter 1' } }),
      job('4', { state: 'failed', createdAt: `${today}T09:00:00.000Z`, payload: { mangaTitle: 'Beta Trails', chapterName: 'Chapter 2' } }),
    ],
    actions: [],
    bulk: [],
    deleted: [],
    seenQueries: [],
  };
  await installMockApi(page);
  await installStatefulDownloads(page, state);

  await page.goto('/#downloads');
  await expect(page.locator('[data-job-id="3"]')).toBeVisible();
  await expect(page.locator('[data-job-id="4"]')).toBeVisible();

  // State chip → URL ?states= and a filtered list.
  await page.locator('[data-testid="state-chip-failed"]').click();
  await expect(page).toHaveURL(/states=failed/);
  await expect(page.locator('[data-job-id="4"]')).toBeVisible();
  await expect(page.locator('[data-job-id="3"]')).toBeHidden();

  // Search narrows by title (URL ?q=).
  await page.locator('#jobs-search').fill('beta');
  await expect(page).toHaveURL(/q=beta/);
  await expect(page.locator('[data-job-id="4"]')).toBeVisible();
  await expect(page.locator('[data-job-id="3"]')).toBeHidden();

  // Date window → URL ?window=month; custom range shows From/To.
  await page.locator('#jobs-date-window').selectOption('month');
  await expect(page).toHaveURL(/window=month/);
  await page.locator('#jobs-date-window').selectOption('custom');
  await expect(page.locator('[data-testid="custom-range"]')).toBeVisible();
  await page.locator('#jobs-date-from').fill('2026-01-01');
  await page.locator('#jobs-date-to').fill('2026-12-31');
  await expect(page).toHaveURL(/from=2026-01-01/);
  await expect(page).toHaveURL(/to=2026-12-31/);

  // The mock saw the synced query params (server-side filter contract).
  const last = state.seenQueries.at(-1) ?? '';
  expect(last).toContain('states=failed');
  expect(last).toContain('q=beta');
});

test('toolbar bulk ops round-trip: pause all, resume all, delete completed (confirm)', async ({ page }: { page: Page }): Promise<void> => {
  const state: JobsState = {
    jobs: [
      job('5', { state: 'queued' }),
      job('6', { state: 'done', progress: { stage: 'finalize', done: 5, total: 5, libraryPath: '/tmp/lib/6.zip' } }),
    ],
    actions: [],
    bulk: [],
    deleted: [],
    seenQueries: [],
  };
  await installMockApi(page);
  await installStatefulDownloads(page, state);

  await page.goto('/#downloads');
  await expect(page.locator('[data-job-id="5"]')).toBeVisible();

  await page.locator('[data-testid="pause-all"]').click();
  await expect(page.locator('[data-job-id="5"] .badge')).toHaveAttribute('data-status', 'stopped');
  await page.locator('[data-testid="resume-all"]').click();
  await expect(page.locator('[data-job-id="5"] .badge')).toHaveAttribute('data-status', 'waiting');

  // Delete completed asks first (FMD2 RS_DlgRemoveFinishTasks).
  await page.locator('[data-testid="delete-completed"]').click();
  await expect(page.locator('[data-testid="delete-completed-dialog"]')).toBeVisible();
  await page.locator('[data-testid="delete-completed-confirm"]').click();
  await expect(page.locator('[data-job-id="6"]')).toHaveCount(0);
  expect(state.bulk).toContainEqual({ action: 'delete', scope: 'completed' });
});
