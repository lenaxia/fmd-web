/**
 * E2E — search scope + preferred sites ([fuzzy-javelin-pearls], D1 §2
 * ENTER): the scope selector on the search home (all/preferred/
 * specific), the preferred-sites allowlist persistence (the picker
 * star → PUT → survives reload), and the zero-network shape of the
 * default all-sites search (no per-site live request under scope=all).
 *
 * Fully offline (fixture-driven mock API, same posture as
 * search-home.spec.ts).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi, module as moduleFixture, entries } from './fixtures';

const SITE_LIVE = 'c'.repeat(32); // catalog-less, live-capable
const SITE_DEAD = 'd'.repeat(32); // cataloged, unreachable preferred

const registryModules = [
  { ...moduleFixture, name: 'FixtureSite', capabilities: { ...moduleFixture.capabilities, known_broken_flags: [] } },
  {
    ...moduleFixture,
    id: SITE_LIVE,
    name: 'LiveWalk',
    catalogInstalled: false,
    capabilities: { ...moduleFixture.capabilities, live_scrape_fallback: true },
  },
  {
    ...moduleFixture,
    id: SITE_DEAD,
    name: 'DeadPreferred',
    availability: { status: 'unreachable', checkedAt: '2026-11-01T00:00:00Z', reason: 'DNS gone' },
  },
];

/** Stateful preferred-sites mock: GET serves the current list, PUT replaces. */
async function installPreferred(page: Page, initial: string[] = []): Promise<{ puts: string[][] }> {
  const puts: string[][] = [];
  let current = [...initial];
  await page.route(/\/api\/preferred-sites$/, (route: Route): void => {
    if (route.request().method() === 'PUT') {
      current = [...((JSON.parse(route.request().postData() ?? '{"sites":[]}') as { sites?: string[] }).sites ?? [])];
      puts.push([...current]);
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sites: current }),
      });
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sites: current }),
    });
  });
  return { puts };
}

async function installRegistry(page: Page): Promise<void> {
  await page.route(/\/api\/modules/, (route: Route): void => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ modules: registryModules, count: registryModules.length }),
    });
  });
}

/** Union search mock recording query strings. */
async function installUnion(page: Page): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  await page.route(/\/api\/search/, (route: Route): void => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: entries.map((entry): unknown => ({
          ...entry,
          site: MODULE_ID,
          siteName: 'FixtureSite',
        })),
        facets: [{ siteId: MODULE_ID, siteName: 'FixtureSite', count: entries.length }],
        warnings: [],
        excluded: [],
        scope: url.searchParams.get('scope') ?? 'all',
      }),
    });
  });
  return { requests };
}

/** Per-site live search mock (counts calls — scope=all must NEVER hit it). */
async function installLive(page: Page): Promise<{ calls: () => number }> {
  let liveCalls = 0;
  await page.route(/\/api\/catalog\/[0-9a-f]{32}\/search/, (route: Route): void => {
    liveCalls += 1;
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [{ ...entries[0], link: '/live/one', title: 'LiveWalk Hit' }],
        total: 1,
        source: 'live',
      }),
    });
  });
  return { calls: (): number => liveCalls };
}

test.beforeEach(async ({ page }): Promise<void> => {
  await installMockApi(page);
});

test.describe('search scope', () => {
  test('default is all sites: the union request carries no scope and never live-searches', async ({ page }): Promise<void> => {
    await installRegistry(page);
    await installPreferred(page, [SITE_LIVE]);
    const union = await installUnion(page);
    const live = await installLive(page);

    await page.goto('/#/browse');
    await page.getByRole('searchbox', { name: 'Search all sites' }).fill('que');
    await expect(page.getByText('Alpha Quest')).toBeVisible();
    expect(union.requests.length).toBeGreaterThan(0);
    expect(union.requests[0]).not.toContain('scope=');
    expect(live.calls()).toBe(0);
  });

  test('preferred scope: request carries scope=preferred; chips render in allowlist order with the dead site dimmed', async ({ page }): Promise<void> => {
    await installRegistry(page);
    await installPreferred(page, [SITE_DEAD, MODULE_ID]);
    const union = await installUnion(page);

    await page.goto('/#/browse');
    await page.getByTestId('scope-preferred').click();
    await page.getByRole('searchbox', { name: 'Search preferred sites' }).fill('que');
    await expect(page.getByText('Alpha Quest')).toBeVisible();
    const scoped = union.requests.find((s): boolean => s.includes('scope=preferred'));
    expect(scoped).toBeDefined();
    // Canonical order: DeadPreferred first (the allowlist order), and
    // it is DIMMED (data-unavailable) but present — never hidden.
    const chips = page.getByTestId(/^preferred-chip-/);
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute('data-testid', `preferred-chip-${SITE_DEAD}`);
    await expect(chips.nth(0)).toHaveAttribute('data-unavailable', 'true');
    await expect(chips.nth(1)).not.toHaveAttribute('data-unavailable');
  });

  test('picker star persists the allowlist (PUT observed; survives reload)', async ({ page }): Promise<void> => {
    await installRegistry(page);
    const { puts } = await installPreferred(page);

    await page.goto('/#/browse?sites=1');
    await page.getByTestId(`prefer-toggle-${MODULE_ID}`).click();
    await expect(page.getByText('Preferred')).toBeVisible({ timeout: 10_000 });
    await expect
      .poll((): number => puts.length, { message: 'the star fires the PUT' })
      .toBeGreaterThanOrEqual(1);
    expect(puts[0]).toEqual([MODULE_ID]);
    // The Preferred group floats the starred row.
    await expect(page.getByTestId(`prefer-toggle-${MODULE_ID}`)).toHaveAttribute('aria-pressed', 'true');

    // Reload: the allowlist is SERVER-side state — the star survives.
    await page.reload();
    await expect(page.getByTestId(`prefer-toggle-${MODULE_ID}`)).toHaveAttribute('aria-pressed', 'true', {
      timeout: 10_000,
    });
  });

  test('specific picks: the union carries the explicit sites and the URL keeps them', async ({ page }): Promise<void> => {
    await installRegistry(page);
    await installPreferred(page);
    const union = await installUnion(page);

    await page.goto('/#/browse');
    await page.getByTestId('scope-specific').click();
    await page.getByTestId(`specific-pick-${MODULE_ID}`).click();
    await expect(page).toHaveURL(new RegExp(`picks=${MODULE_ID}`));
    await page.getByRole('searchbox', { name: 'Search picked sites' }).fill('que');
    await expect(page.getByText('Alpha Quest')).toBeVisible();
    const withSites = union.requests.find((s): boolean => s.includes(`sites=${MODULE_ID}`));
    expect(withSites).toBeDefined();
    void CATALOG_ID;
  });
});
