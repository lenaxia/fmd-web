/**
 * Site-availability e2e (dead-site discovery): the picker HINT (an
 * unreachable row dims but stays clickable; the client-local
 * Hide-unavailable toggle hides exactly those rows) and the Settings
 * registry Check flow (one probe against the mocked site writes the
 * record — the status marker + facet counts flip on the refetch).
 * Fixture-driven like the parity specs: loopback + interception only
 * (the classification contract itself is pinned hermetically in
 * server/test/{engine,runtime,api} against real transports).
 */
import { test, expect, type Route } from '@playwright/test';
import { CATALOG_ID, installMockApi } from './fixtures';

const ALIVE_ID = '1'.repeat(32);
const DEAD_ID = '2'.repeat(32);
const FRESH_ID = '3'.repeat(32);

const UNREACHABLE = {
  status: 'unreachable',
  checkedAt: '2026-11-19T00:00:00Z',
  reason: 'connect ECONNREFUSED 127.0.0.1:9',
};
const REACHABLE = { status: 'reachable', checkedAt: '2026-11-19T00:05:00Z', reason: null };
const UNKNOWN = { status: 'unknown', checkedAt: null, reason: null };

function moduleRow(id: string, name: string, availability: object): object {
  return {
    id,
    name,
    rootURL: 'https://fixtures.example',
    category: 'Fixtures',
    accountSupport: false,
    file: `modules/${name}.lua`,
    enabled: true,
    proxy: null,
    catalogInstalled: id === ALIVE_ID,
    availability,
    options: [],
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: [],
      known_broken_flags: [],
      live_scrape_fallback: false,
    },
  };
}

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * Layer the availability-shaped registry OVER the shared mock API:
 * the modules GET answers pre-check records until the Check POST for
 * the dead site fires, then serves the post-check (reachable) record —
 * exactly the write-through the real endpoint performs.
 */
async function installAvailabilityApi(page: import('@playwright/test').Page): Promise<void> {
  await installMockApi(page);
  const checked = { dead: false };
  await page.route(/\/api\/modules$/, (route: Route): void => {
    void route.fulfill(
      json({
        modules: [
          moduleRow(ALIVE_ID, 'AliveSite', REACHABLE),
          moduleRow(DEAD_ID, 'DeadSite', checked.dead ? REACHABLE : UNREACHABLE),
          moduleRow(FRESH_ID, 'FreshSite', UNKNOWN),
        ],
        count: 3,
      }),
    );
  });
  await page.route(/\/api\/modules\/[^/]+\/check$/, (route: Route): void => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith(`${DEAD_ID}/check`)) {
      void route.fulfill(json({ error: { code: 'not_found', message: 'unknown module' } }, 404));
      return;
    }
    checked.dead = true;
    void route.fulfill(
      json({
        moduleId: DEAD_ID,
        verdict: 'reachable',
        detail: 'Reachable (HTTP 200)',
        availability: REACHABLE,
      }),
    );
  });
}

test.beforeEach(async ({ page }): Promise<void> => {
  await installAvailabilityApi(page);
});

test('picker: an unreachable site dims with its reason but stays clickable; unknown renders normal', async ({ page }): Promise<void> => {
  await page.goto('/#/browse?sites=1');
  const deadRow = page.locator(`[data-site-id="${DEAD_ID}"]`);
  await expect(deadRow).toBeVisible();
  await expect(deadRow).toHaveAttribute('data-unavailable', 'true');
  // the reason surfaces on the row hint
  await expect(deadRow.getByRole('button', { name: /browse/ })).toHaveAttribute('title', /connect ECONNREFUSED/);
  // unknown renders as a NORMAL row (no dim, no marker)
  const freshRow = page.locator(`[data-site-id="${FRESH_ID}"]`);
  await expect(freshRow).toBeVisible();
  await expect(freshRow).not.toHaveAttribute('data-unavailable', 'true');
  // the hint is NOT a gate: clicking the dead site still navigates
  await deadRow.getByRole('button', { name: /browse/ }).click();
  await page.waitForFunction(
    (needle: string): boolean => globalThis.location.hash.includes(needle),
    `site=${DEAD_ID}`,
  );
});

test('picker: the client-local Hide-unavailable toggle hides exactly the unreachable rows', async ({ page }): Promise<void> => {
  await page.goto('/#/browse?sites=1');
  await expect(page.locator(`[data-site-id="${DEAD_ID}"]`)).toBeVisible();
  await page.getByTestId('hide-unavailable-toggle').check();
  await expect(page.locator(`[data-site-id="${DEAD_ID}"]`)).not.toBeVisible();
  await expect(page.locator(`[data-site-id="${ALIVE_ID}"]`)).toBeVisible();
  await expect(page.locator(`[data-site-id="${FRESH_ID}"]`)).toBeVisible();
  // plain view state: the toggle never lands in the URL
  await expect(page).not.toHaveURL(/hide/);
  // and unchecking restores the dimmed row
  await page.getByTestId('hide-unavailable-toggle').uncheck();
  await expect(page.locator(`[data-site-id="${DEAD_ID}"]`)).toBeVisible();
});

test('registry: the per-row Check writes the record — marker, tooltip and facet counts flip', async ({ page }): Promise<void> => {
  await page.goto('/#/settings');
  const deadMarker = page.getByTestId(`availability-${DEAD_ID}`);
  await expect(deadMarker).toBeVisible();
  await expect(deadMarker).toHaveAttribute('title', /unreachable/);
  await expect(deadMarker).toHaveAttribute('title', /connect ECONNREFUSED/);
  // facet counts: All 3 / Reachable 1 / Unreachable 1 / Unknown 1
  const facets = page.getByTestId('module-facets');
  await expect(facets.getByRole('group', { name: 'Last check' }).getByRole('button', { name: /Unreachable 1/ })).toBeVisible();
  // ONE probe (no batch): the dead site's Check button
  await page.getByTestId(`check-site-${DEAD_ID}`).click();
  // the record rides the refetched registry: the marker flips to ok
  await expect(deadMarker).toHaveAttribute('title', /reachable/);
  // and the facet counts follow the record (Unreachable drops to 0)
  await expect(facets.getByRole('group', { name: 'Last check' }).getByRole('button', { name: /Unreachable 0/ })).toBeVisible();
  void CATALOG_ID;
});
