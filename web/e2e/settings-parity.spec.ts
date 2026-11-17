/**
 * Settings parity e2e (tsk-ethereal-verdict-orders): the accounts card
 * round-trip vs a mock OnLogin (save PUT → check-login POST → §5.2
 * status badge), and the FMD2 Websites-tree bulk controls (global
 * Select-all/None + per-category) reflected live in the site picker.
 * Fixture-driven like every smoke spec: the SPA runs against the real
 * Vite dev server, the §10 API is interception only.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { installMockApi, module as fixtureModule, MODULE_ID } from './fixtures';

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

const API = (suffix: string): RegExp => new RegExp(`^https?://[^/]+/api/${suffix}`);

/** The mock API state the settings-parity specs mutate + observe. */
interface SettingsMockState {
  /** Live copy of the module registry the bulk endpoint rewrites. */
  modules: Array<{ id: string; enabled: boolean }>;
  /** Captured PUT /api/accounts/:moduleId bodies. */
  accountSaves: Array<Record<string, unknown>>;
  /** Captured POST /api/modules/bulk bodies. */
  bulkWrites: Array<Record<string, unknown>>;
  /** Login outcomes served in order (last one repeats). */
  loginStatuses: string[];
}

/**
 * installMockApi + the settings-parity surface: a STATEFUL /api/modules
 * (bulk writes flip the served enabled set), the accounts CRUD + login
 * routes, and GET /api/settings (output defaults + browser state).
 */
async function installSettingsMockApi(page: Page, state: SettingsMockState): Promise<void> {
  await installMockApi(page);

  await page.route(API('settings$'), (route): void => {
    void route.fulfill(
      json({
        proxy: { type: '', host: '', port: '', user: '', pass: '' },
        output: {
          format: 'zip',
          chapterNameTemplate: '',
          unicodeReplacement: false,
          unicodeReplacementChar: '_',
          digitPadding: 0,
          removeMangaName: false,
        },
        // The settings page renders EVERY settings group ([parity-sweep]
        // favorites/performance/retention/filenamePolicy/diagnostics
        // sections render here too) — a partial body would crash them,
        // so the mock carries the full current SettingsResponse shape.
        favorites: { intervalMinutes: 60, checkAtStartup: true },
        performance: { requestTimeoutSeconds: 30, retryCount: 2, parallelChapters: 1, threadsPerChapter: 1 },
        retention: { days: 30 },
        filenamePolicy: { normalizePaths: false },
        diagnostics: { logEnabled: true, logLevel: 'info' },
        browser: { enabled: false, url: '' },
      }),
    );
  });

  // Stateful module registry: the bulk endpoint rewrites the enabled
  // set and GET serves the live rows (react-query invalidation makes
  // the picker re-fetch — the assertion target of the bulk spec).
  await page.route(API('modules'), (route): void => {
    if (route.request().method() === 'GET') {
      const rows = state.modules.map((m): Record<string, unknown> => ({
        ...fixtureModule,
        id: m.id,
        enabled: m.enabled,
      }));
      void route.fulfill(json({ modules: rows, count: rows.length }));
      return;
    }
    void route.fulfill(json({ error: { code: 'not_found', message: 'unmocked' } }, 404));
  });
  await page.route(API('modules/bulk'), (route): void => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.bulkWrites.push(body);
    const enabled: boolean = body['enabled'] === true;
    const category: string | undefined = typeof body['category'] === 'string' ? (body['category'] as string) : undefined;
    const targets = state.modules.filter((_m): boolean =>
      category !== undefined ? category === fixtureModule.category : true,
    );
    for (const target of targets) {
      target.enabled = enabled;
    }
    const rows = state.modules.map((m): Record<string, unknown> => ({
      ...fixtureModule,
      id: m.id,
      enabled: m.enabled,
    }));
    void route.fulfill(json({ modules: rows, updated: targets.length }));
  });

  await page.route(API('accounts'), (route): void => {
    void route.fulfill(json({ accounts: [], count: 0 }));
  });
  await page.route(API('accounts/[^/]+'), (route): void => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.accountSaves.push(body);
      void route.fulfill(
        json(
          {
            account: {
              moduleId: MODULE_ID,
              username: body['username'],
              enabled: true,
              status: 'asUnknown',
            },
          },
          201,
        ),
      );
      return;
    }
    // DELETE
    void route.fulfill(json({ ok: true }));
  });
  await page.route(API('accounts/[^/]+/login'), (route: Route): void => {
    const status: string =
      state.loginStatuses.length > 1 ? (state.loginStatuses.shift() as string) : (state.loginStatuses[0] as string);
    void route.fulfill(
      json({
        account: {
          moduleId: MODULE_ID,
          username: 'fixture-user',
          enabled: true,
          status,
        },
        ok: true,
      }),
    );
  });

  // Per-site re-sync catalog (update-list parity): the existing sync
  // endpoint behind the row action + progress toast.
  await page.route(API('sync/catalog/[^/]+'), (route): void => {
    void route.fulfill(
      json({ ok: true, result: { id: MODULE_ID, state: 'updated', dbSha: 'cd34'.repeat(16), bytes: 4096 } }),
    );
  });
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await installSettingsMockApi(page, {
    modules: [{ id: MODULE_ID, enabled: true }],
    accountSaves: [],
    bulkWrites: [],
    loginStatuses: ['asValid', 'asInvalid'],
  });
});

test('Settings: account card round-trip — save (PUT) then check login (POST) with the §5.2 status badge', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  const state = { saves: [] as Array<Record<string, unknown>> };
  page.on('request', (req): void => {
    if (req.method() === 'PUT' && /\/api\/accounts\//.test(req.url())) {
      state.saves.push(req.postDataJSON() as Record<string, unknown>);
    }
  });

  await page.goto('/#/settings');

  // The card renders for the AccountSupport site (FixtureSite).
  const card = page.getByLabel('Account for FixtureSite');
  await expect(card).toBeVisible();

  // Masked password with a show toggle (aria-pressed flip).
  const password = card.getByLabel('Password for FixtureSite', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await card.getByRole('button', { name: 'Show password for FixtureSite' }).click();
  await expect(password).toHaveAttribute('type', 'text');

  // Save PUTs the typed credentials; the password field clears after.
  await card.getByLabel('Username for FixtureSite', { exact: true }).fill('fixture-user');
  await password.fill('s3cret');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByText('Saved')).toBeVisible();
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]?.['username']).toBe('fixture-user');
  expect(state.saves[0]?.['password']).toBe('s3cret');
  await expect(password).toHaveValue('');

  // Check login runs the module OnLogin — the FIRST mock outcome is
  // asValid → the badge renders the §5.2 status.
  await card.getByRole('button', { name: 'Check login' }).click();
  await expect(page.getByTestId('account-status-asValid')).toBeVisible();
  await expect(page.getByText('Login valid')).toBeVisible();

  // A second check serves asInvalid — the badge flips (live state).
  await card.getByRole('button', { name: 'Check login' }).click();
  await expect(page.getByTestId('account-status-asInvalid')).toBeVisible();
});

test('Settings: bulk category Disable all rewrites module_state; the site picker reflects it immediately', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/settings');

  // The category header carries the FMD2 tree bulk controls.
  const header = page.getByTestId('module-category-header');
  await expect(header).toBeVisible();
  await expect(header.getByText('Fixtures')).toBeVisible();

  // The module row starts enabled.
  const enabledBox = page.getByLabel('FixtureSite', { exact: true });
  await expect(enabledBox).toBeChecked();

  // Per-category bulk disable — ONE POST /api/modules/bulk write.
  const bulkWrites: Array<Record<string, unknown>> = [];
  page.on('request', (req): void => {
    if (/\/api\/modules\/bulk$/.test(req.url())) {
      bulkWrites.push(req.postDataJSON() as Record<string, unknown>);
    }
  });
  await header.getByRole('button', { name: 'Disable all modules in Fixtures' }).click();

  // The list (stateful mock) reflects the rewrite immediately.
  await expect(enabledBox).not.toBeChecked();

  // And the site picker hides the disabled site right away.
  await page.goto('/#/browse?sites=1');
  await expect(page.getByText(/Pick a site/i)).toBeVisible();
  await expect(page.getByText('FixtureSite')).toHaveCount(0);

  // Back to Settings: global Select all (FMD2 Select All) re-enables.
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Select all' }).click();
  const checkbox = page.getByLabel('FixtureSite', { exact: true });
  await expect(checkbox).toBeChecked();
  await page.goto('/#/browse?sites=1');
  await expect(page.getByText('FixtureSite').first()).toBeVisible();

  // Exactly two bulk writes: category disable + global enable.
  expect(bulkWrites).toHaveLength(2);
  expect(bulkWrites[0]).toMatchObject({ enabled: false, category: 'Fixtures' });
  expect(bulkWrites[1]).toMatchObject({ enabled: true });
});

test('Settings: per-site Re-sync catalog (update-list parity) runs the sync endpoint behind a progress toast', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/settings');

  const syncs: string[] = [];
  page.on('request', (req): void => {
    if (req.method() === 'POST' && /\/api\/sync\/catalog\//.test(req.url())) {
      syncs.push(req.url());
    }
  });

  // The row action (only sites with an INSTALLED catalog carry it).
  await page.getByRole('button', { name: 'Re-sync catalog for FixtureSite' }).click();

  // The mock answers state:'updated' — the toast resolves to success.
  await expect(page.getByText('FixtureSite catalog sync updated')).toBeVisible();
  expect(syncs).toHaveLength(1);
  expect(syncs[0]).toContain(`/api/sync/catalog/${MODULE_ID}`);
});

test('Settings: module search narrows by name and category', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto('/#/settings');
  const search = page.getByLabel('Search modules by name or category');

  // No search: the fixture site is listed.
  await expect(page.getByLabel('FixtureSite', { exact: true })).toBeVisible();

  // Name hit.
  await search.fill('fixture');
  await expect(page.getByLabel('FixtureSite', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1/1 modules match' })).toBeVisible();

  // Category hit (the category text 'Fixtures' matches too).
  await search.fill('fixtures');
  await expect(page.getByLabel('FixtureSite', { exact: true })).toBeVisible();

  // Miss: empty state, no rows.
  await search.fill('zzz-does-not-exist');
  await expect(page.getByLabel('FixtureSite', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/No modules match the search/)).toBeVisible();
});
