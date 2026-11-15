/**
 * Compose e2e main scenario (runs AFTER wait-on /readyz): browse
 * latest → search → manga detail with LIVE info through the seed
 * module against the mock upstream → enqueue dry-run → job visible in
 * Downloads with the queued state. Fully offline: every upstream is
 * the local fixture container.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface E2EJson {
  readonly catalogId: string;
  readonly mangaTitle: string;
  readonly searchQuery: string;
  readonly mangaPath: string;
}

const E2E = JSON.parse(
  readFileSync(new URL('../../e2e/fixtures/e2e.json', import.meta.url), 'utf8'),
) as E2EJson;
const CATALOG_ID: string = E2E.catalogId;

test('browse latest → search → live info → dry-run enqueue → Downloads queued', async ({ page }: { page: Page }): Promise<void> => {
  // ── 1. browse latest ──────────────────────────────────────────────
  await page.goto(`/#/browse?catalog=${CATALOG_ID}`);
  await expect(page.getByRole('heading', { name: 'FMD Web' })).toBeVisible();
  const alphaQuest = page.getByRole('button', { name: /Alpha Quest/ });
  await expect(alphaQuest).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Showing 5 of 5 entries')).toBeVisible();
  await expect(page.getByRole('button', { name: /Zeta Landing/ })).toBeVisible();

  // ── 2. FTS search ─────────────────────────────────────────────────
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByLabel('Search titles').fill(E2E.searchQuery);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: /Alpha Quest/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Beta Trails/ })).toHaveCount(0);
  await expect(page.getByText('Showing 1 of 1 entries')).toBeVisible();

  // ── 3. manga detail: LIVE info through the seed module ────────────
  const downloadRequests: string[] = [];
  page.on('request', (req): void => {
    if (req.url().includes('/api/jobs/download')) {
      downloadRequests.push(req.url());
    }
  });
  await page.getByRole('button', { name: /Alpha Quest/ }).click();
  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Alpha Author')).toBeVisible();
  await expect(page.getByText('Action, Adventure')).toBeVisible();
  await expect(page.getByText(/Chapters \(3\)/)).toBeVisible();

  // ── 4. dry-run: preview WITHOUT sending ──────────────────────────
  await page.getByLabel('Chapter 1: The Beginning').check();
  const preview = page.getByLabel('Enqueue request preview');
  await expect(preview).toContainText(`"moduleId": "${CATALOG_ID}"`);
  await expect(preview).toContainText('"idempotencyKey"');
  await expect(preview).toContainText('/manga/alpha-quest/ch/1');
  expect(downloadRequests).toHaveLength(0);

  // ── 5. enqueue → Downloads shows the queued job ───────────────────
  await page.getByRole('button', { name: /Enqueue 1 chapter/ }).click();
  await expect(page.getByText(/Job .* queued/)).toBeVisible();
  expect(downloadRequests).toHaveLength(1);

  await page.getByRole('link', { name: 'Downloads' }).click();
  const jobRow = page.locator('.job-row');
  await expect(jobRow).toBeVisible({ timeout: 30_000 });
  // The download lane claims within one poll (250 ms), so `queued` is a
  // transient — assert the job's LIVE badge (queued or already running).
  await expect(jobRow.locator('.badge')).toHaveText(/^(queued|running)$/);
  await expect(jobRow).toContainText('Alpha Quest');
  await expect(jobRow).toContainText('Chapter 1: The Beginning');
});
