/**
 * Bootstrap-watch (D20 UI-asserted auto-bootstrap): run IMMEDIATELY
 * after the stack starts, before scripts/e2e.sh waits on /readyz.
 * Asserts, in the browser:
 *   1. the D20 empty state renders while the server bootstraps;
 *   2. the bootstrap progress banner appears (server stage surfaced);
 *   3. the banner clears when /readyz flips ready (200).
 */
import { expect, test, type Page } from '@playwright/test';

async function gotoWithRetry(page: Page, attempts = 60): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      return;
    } catch (error: unknown) {
      last = error;
      await page.waitForTimeout(1000);
    }
  }
  throw last instanceof Error ? last : new Error('app never accepted connections');
}

test('empty-state → bootstrap progress → ready', async ({ page, request }): Promise<void> => {
  await gotoWithRetry(page);

  // The app shell is up; with no catalog selected the D20 empty state
  // explains the first-run bootstrap (always rendered on bare /#/browse).
  await expect(page.getByRole('heading', { name: 'FMD Web' })).toBeVisible();
  await expect(page.getByText('No catalog selected')).toBeVisible();
  await expect(page.getByText(/auto-triggers module \+ catalog sync \(D20\)/)).toBeVisible();

  // Bootstrap progress: the banner surfaces the server's stage. It may
  // already be on screen when the browser attaches; allow a window.
  const banner = page.getByTestId('bootstrap-status');
  await expect(banner).toBeVisible({ timeout: 30_000 });

  // …and it clears once /readyz reports ready (bootstrap done).
  await expect(banner).toHaveCount(0, { timeout: 180_000 });

  const ready = await request.get('/readyz');
  expect(ready.status()).toBe(200);
  expect((await ready.json())['ready']).toBe(true);
});
