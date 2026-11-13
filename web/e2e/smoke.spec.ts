/**
 * Playwright e2e smoke — ONE happy-path per page (Browse · Manga ·
 * Downloads · Settings) against the real Vite dev server with the
 * fixture-driven mock API (e2e/fixtures.ts). Fully offline: only
 * loopback + intercepted requests.
 */
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi, job } from './fixtures';

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  installMockApi(page);
});

test('Browse: catalog latest list with cursor pagination + search', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto(`/#/browse?catalog=${CATALOG_ID}`);

  await expect(page.getByRole('heading', { name: 'FMD Web' })).toBeVisible();
  const firstEntry = page.getByRole('button', { name: /Alpha Quest/ });
  await expect(firstEntry).toBeVisible();

  // page 1 → page 2 via the Load-more cursor
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('button', { name: /Beta Trails/ })).toBeVisible();
  await expect(page.getByText('Showing 2 of 2 entries')).toBeVisible();

  // search mode: opaque cursor flows back to the server
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search titles').fill('alpha');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: /Alpha Quest/ })).toBeVisible();
});

test('Manga: live info display, chapter list, enqueue dry-run', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto(
    `/#/manga?catalog=${CATALOG_ID}&module=${MODULE_ID}&url=${encodeURIComponent(
      'https://fixtures.example/manga/alpha',
    )}&title=${encodeURIComponent('Alpha Quest')}`,
  );

  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();
  await expect(page.getByText('Author A')).toBeVisible();
  await expect(page.getByText(/Chapters \(2\)/)).toBeVisible();

  // dry-run: selecting a chapter previews the exact POST body — no request
  const jobsRequested: string[] = [];
  page.on('request', (req): void => {
    if (req.url().includes('/api/jobs/download')) {
      jobsRequested.push(req.url());
    }
  });
  await page.getByLabel('Chapter 1: The Beginning').check();
  const preview = page.getByLabel('Enqueue request preview');
  await expect(preview).toContainText(`"moduleId": "${MODULE_ID}"`);
  await expect(preview).toContainText('"idempotencyKey"');
  expect(jobsRequested).toHaveLength(0);

  // enqueue POSTs the same body
  await page.getByRole('button', { name: /Enqueue 1 chapter/ }).click();
  await expect(page.getByText(/queued/)).toBeVisible();
  expect(jobsRequested).toHaveLength(1);
});

test('Downloads: job list, cursor load-more, WS progress updates live', async ({ page }: { page: Page }): Promise<void> => {
  // Mock the D19 event stream: capture the socket, push the progress
  // event once the REST list has rendered (deterministic ordering).
  const holder: { ws?: WebSocketRoute } = {};
  await page.routeWebSocket(/^ws:\/\/[^/]+\/ws$/, (ws: WebSocketRoute): void => {
    holder.ws = ws;
    ws.onMessage((): void => {
      /* hello acknowledged; events are pushed by the test */
    });
  });

  await page.goto('/#/downloads');
  await expect(page.getByText(/Event stream:/)).toBeVisible();

  // REST list renders first
  await expect(page.getByText('Alpha Quest — Chapter 1: The Beginning')).toBeVisible();
  await expect(page.getByText('Event stream: Live')).toBeVisible();

  // WS event patches the row live (D19)
  holder.ws?.send(
    JSON.stringify({
      type: 'event',
      id: 'evt-1',
      job: { ...job, state: 'running', progress: { pages: '3/40' } },
    }),
  );
  await expect(page.locator('.job-list').getByText('running', { exact: true })).toBeVisible();
  await expect(page.getByText('{"pages":"3/40"}')).toBeVisible();

  // cursor pagination still works
  await page.getByRole('button', { name: 'Load more' }).click();
  // page 2 is empty (fixtures) — row from page 1 remains, no crash
  await expect(page.getByText('Alpha Quest — Chapter 1: The Beginning')).toBeVisible();
});

test('Settings: module list with capability/known-broken badges + options editor', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto('/#/settings');

  await expect(page.getByText('FixtureSite')).toBeVisible();
  await expect(page.getByText('known broken: cloudflare-loop')).toBeVisible();
  await expect(page.getByText('needs browser')).toBeVisible();
  await expect(page.getByText('account')).toBeVisible();

  // options editor opens honoring the module descriptors
  await page.getByRole('button', { name: 'Configure' }).click();
  const quality = page.getByLabel(/Quality/);
  await expect(quality).toBeVisible();
  await expect(quality).toHaveValue('1');
  await expect(page.getByLabel(/Auto-skip pages/)).not.toBeChecked();

  // combobox INDEX semantics: pick 'high' (index 2) and save — the PUT body stores the index
  const putBodies: string[] = [];
  page.on('request', (req): void => {
    if (req.method() === 'PUT' && req.url().includes(`/api/modules/${MODULE_ID}`)) {
      putBodies.push(req.postData() ?? '');
    }
  });
  await quality.selectOption({ label: 'high' });
  await page.getByRole('button', { name: 'Save options' }).click();
  await expect(page.getByText('Options saved.')).toBeVisible();
  expect(putBodies).toHaveLength(1);
  const body = JSON.parse(putBodies[0] ?? '{}') as { options?: Record<string, unknown> };
  expect(body.options?.['Quality']).toBe(2);
});
