/**
 * Settings parity e2e: the accounts card round-trip vs a mock OnLogin
 * (save PUT → check-login POST → §5.2 status badge), and the rebuilt
 * Websites surface (tsk-skilled-tabby-blooms): faceted filtering
 * (LANGUAGE with the scanlation collapse, H-STATUS, NEEDS SETUP +
 * text search, URL-synced and back-navigation-safe), client-side
 * category grouping (ONE header per category over interleaved
 * registration order — the "only 1 english site" fix), bulk controls
 * scoped to the CURRENT filtered selection with a disable-all
 * confirm, and the inline-expand global proxy box.
 * Fixture-driven like every smoke spec: the SPA runs against the real
 * Vite dev server, the §10 API is interception only.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { installMockApi, module as fixtureModule, MODULE_ID } from './fixtures';

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

const API = (suffix: string): RegExp => new RegExp(`^https?://[^/]+/api/${suffix}`);

/**
 * Production shape in miniature: categories INTERLEAVE in registration
 * (directory-walk) order, one site ships an EMPTY category, and
 * accountSupport mixes — the exact inputs behind the user's "only 1
 * english site" misread.
 */
interface MockModuleRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly accountSupport: boolean;
  enabled: boolean;
}

const REGISTRY: readonly MockModuleRow[] = [
  { id: MODULE_ID, name: 'FixtureSite', category: 'English', accountSupport: true, enabled: true },
  { id: '1'.repeat(32), name: 'RawDex', category: 'Raw', accountSupport: false, enabled: true },
  { id: '2'.repeat(32), name: 'ScanHaven', category: 'English-Scanlation', accountSupport: false, enabled: true },
  { id: '3'.repeat(32), name: 'HDen', category: 'H-Sites', accountSupport: false, enabled: true },
  { id: '4'.repeat(32), name: 'NoCatOne', category: '', accountSupport: false, enabled: true },
  { id: '5'.repeat(32), name: 'SpanishSun', category: 'Spanish', accountSupport: false, enabled: true },
];

/** The mock API state the settings-parity specs mutate + observe. */
interface SettingsMockState {
  /** Live copy of the module registry the bulk endpoint rewrites. */
  modules: MockModuleRow[];
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
  // Served in REGISTRATION order (interleaved categories) — the input
  // the client-side grouping fix sorts into one-header-per-category.
  await page.route(API('modules'), (route): void => {
    if (route.request().method() === 'GET') {
      const rows = state.modules.map((m): Record<string, unknown> => ({
        ...fixtureModule,
        id: m.id,
        name: m.name,
        category: m.category,
        accountSupport: m.accountSupport,
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
    const ids: readonly string[] | undefined = Array.isArray(body['ids'])
      ? (body['ids'] as readonly string[])
      : undefined;
    // targets = explicit ids[] > exact category > every module (the
    // server's documented precedence — the scoped bulk contract).
    const targets = state.modules.filter((m): boolean => {
      if (ids !== undefined) {
        return ids.includes(m.id);
      }
      if (category !== undefined) {
        return m.category === category;
      }
      return true;
    });
    for (const target of targets) {
      target.enabled = enabled;
    }
    const rows = state.modules.map((m): Record<string, unknown> => ({
      ...fixtureModule,
      id: m.id,
      name: m.name,
      category: m.category,
      accountSupport: m.accountSupport,
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
    modules: REGISTRY.map((row): MockModuleRow => ({ ...row })),
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

test('Settings → Websites: interleaved registry groups into ONE header per category (the "only 1 english site" fix)', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/settings');

  // The mock serves registration order (English, Raw, English-Scanlation,
  // H-Sites, '', Spanish — categories INTERLEAVE). The client sorts by
  // (category, name): exactly one header per category, TRUE counts.
  const headers = page.getByTestId('module-category-header');
  await expect(headers).toHaveCount(6);
  const english = headers.filter({ hasText: 'English' }).first();
  await expect(english).toBeVisible();
  await expect(english).toContainText('(1)'); // FixtureSite
  await expect(headers.filter({ hasText: 'English-Scanlation' })).toContainText('(1)'); // ScanHaven
  // The raw-empty category displays as 'Unknown'.
  await expect(headers.filter({ hasText: 'Unknown' })).toContainText('(1)');

  // The LANGUAGE facet chips show the collapsed distribution at a
  // glance: English 2 (English 1 + English-Scanlation 1), Raw 1,
  // H-Sites 1, Spanish 1, Unknown 1.
  const facets = page.getByTestId('module-facets');
  const langGroup = facets.getByRole('group', { name: 'Language' });
  await expect(langGroup.getByRole('button', { name: /English 2/ })).toBeVisible();
  await expect(langGroup.getByRole('button', { name: /Raw 1/ })).toBeVisible();
  await expect(langGroup.getByRole('button', { name: /H-Sites 1/ })).toBeVisible();
  await expect(langGroup.getByRole('button', { name: /Spanish 1/ })).toBeVisible();
  await expect(langGroup.getByRole('button', { name: /Unknown 1/ })).toBeVisible();
  const setupGroup = facets.getByRole('group', { name: 'Needs setup' });
  await expect(setupGroup.getByRole('button', { name: /No setup needed 5/ })).toBeVisible();
  await expect(setupGroup.getByRole('button', { name: /Needs credentials 1/ })).toBeVisible();
});

test('Settings → Websites: facet chips filter the list and SURVIVE back-navigation (URL-synced)', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/settings');
  const facets = page.getByTestId('module-facets');
  const langGroup = facets.getByRole('group', { name: 'Language' });

  // Clicking the collapsed English chip narrows to English +
  // English-Scanlation and lands in the URL (push → back restores).
  await langGroup.getByRole('button', { name: /English 2/ }).click();
  await expect(page).toHaveURL(/#\/settings\?lang=English$/);
  await expect(page.getByLabel('FixtureSite', { exact: true })).toBeVisible();
  await expect(page.getByLabel('ScanHaven', { exact: true })).toBeVisible();
  await expect(page.getByLabel('RawDex', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('HDen', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '2/6 sites match' })).toBeVisible();

  // "No setup needed" composes (AND across groups): only ScanHaven
  // stays (FixtureSite carries AccountSupport).
  await facets.getByRole('group', { name: 'Needs setup' }).getByRole('button', { name: /No setup needed/ }).click();
  await expect(page).toHaveURL(/#\/settings\?lang=English&setup=no-setup$/);
  await expect(page.getByLabel('ScanHaven', { exact: true })).toBeVisible();
  await expect(page.getByLabel('FixtureSite', { exact: true })).toHaveCount(0);

  // Navigate away, then BACK: the facet selection (URL) is restored.
  await page.goto('/#/browse?sites=1');
  await page.goBack();
  await expect(page).toHaveURL(/#\/settings\?lang=English&setup=no-setup$/);
  await expect(page.getByLabel('ScanHaven', { exact: true })).toBeVisible();
  await expect(page.getByLabel('RawDex', { exact: true })).toHaveCount(0);
  const restored = page.getByTestId('module-facets').getByRole('group', { name: 'Language' });
  await expect(restored.getByRole('button', { name: /English/ })).toHaveAttribute('aria-pressed', 'true');
});

test('Settings → Websites: bulk controls operate on the CURRENT filtered selection, with confirm on disable-all', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/settings');

  const bulkWrites: Array<Record<string, unknown>> = [];
  page.on('request', (req): void => {
    if (/\/api\/modules\/bulk$/.test(req.url())) {
      bulkWrites.push(req.postDataJSON() as Record<string, unknown>);
    }
  });

  // Filter to Raw (exactly one site: RawDex).
  const facets = page.getByTestId('module-facets');
  await facets.getByRole('group', { name: 'Language' }).getByRole('button', { name: /Raw 1/ }).click();
  await expect(page).toHaveURL(/#\/settings\?lang=Raw$/);
  await expect(page.getByRole('status').filter({ hasText: '1/6 sites match' })).toBeVisible();

  // Enable all under the filter: scoped ids write, no confirm needed.
  await page.getByTestId('module-bulk-global').getByRole('button', { name: 'Enable all' }).click();
  await expect
    .poll((): number => bulkWrites.length)
    .toBeGreaterThanOrEqual(1);
  expect(bulkWrites[0]).toMatchObject({ enabled: true, ids: ['1'.repeat(32)] });

  // Disable all (destructive): the confirm dialog gates the write.
  await page.getByTestId('module-bulk-global').getByRole('button', { name: 'Disable all' }).click();
  const dialog = page.getByTestId('module-disable-all-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /Disable 1 filtered sites\?/ })).toBeVisible();
  const writesBeforeConfirm: number = bulkWrites.length;
  await dialog.getByTestId('module-disable-all-confirm').click();
  await expect
    .poll((): number => bulkWrites.length)
    .toBe(writesBeforeConfirm + 1);
  expect(bulkWrites[bulkWrites.length - 1]).toMatchObject({ enabled: false, ids: ['1'.repeat(32)] });

  // The disabled site disappears from the picker immediately (the
  // stateful mock + react-query invalidation).
  await page.goto('/#/browse?sites=1');
  await expect(page.getByText('RawDex')).toHaveCount(0);
  await expect(page.getByText('FixtureSite').first()).toBeVisible();
});

test('Settings: bulk category Disable all rewrites module_state; the site picker reflects it immediately', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/settings');

  // The category header carries the FMD2 tree bulk controls.
  const header = page.getByTestId('module-category-header').filter({ hasText: 'English' }).first();
  await expect(header).toBeVisible();

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
  await header.getByRole('button', { name: 'Disable all modules in English' }).click();

  // The list (stateful mock) reflects the rewrite immediately.
  await expect(enabledBox).not.toBeChecked();

  // And the site picker hides the disabled site right away.
  await page.goto('/#/browse?sites=1');
  await expect(page.getByText(/Pick a site/i)).toBeVisible();
  await expect(page.getByText('FixtureSite')).toHaveCount(0);

  // Back to Settings: global Enable all re-enables (registry-wide —
  // no filter active).
  await page.goto('/#/settings');
  await page.getByTestId('module-bulk-global').getByRole('button', { name: 'Enable all' }).click();
  const checkbox = page.getByLabel('FixtureSite', { exact: true });
  await expect(checkbox).toBeChecked();
  await page.goto('/#/browse?sites=1');
  await expect(page.getByText('FixtureSite').first()).toBeVisible();

  // Exactly two bulk writes: category disable + global enable.
  expect(bulkWrites).toHaveLength(2);
  expect(bulkWrites[0]).toMatchObject({ enabled: false, category: 'English' });
  expect(bulkWrites[1]).toMatchObject({ enabled: true });
});

test('Settings → Websites: the proxy editor lives in a collapsed inline-expand box (hidden by default)', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/settings');

  // Collapsed: a one-line summary + the sidecar badge; the editor
  // fields are NOT on the page.
  const section = page.getByTestId('proxy-section');
  await expect(section).toBeVisible();
  await expect(section.getByTestId('proxy-summary')).toHaveText('none');
  await expect(page.getByLabel('Host', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);

  // The header toggle expands the box IN PLACE (accordion — no
  // overlay; Save stays disabled: nothing drafted — the editor is
  // intact inside).
  const toggle = section.getByTestId('proxy-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const editor = section.getByTestId('proxy-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Type')).toHaveValue('');
  await expect(editor.getByRole('button', { name: 'Save proxy' })).toBeDisabled();

  // Collapsing re-hides the editor (same toggle, no close button).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Host', { exact: true })).toHaveCount(0);
});

test('Settings: module search narrows by name and category', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto('/#/settings');
  const search = page.getByLabel('Search modules by name or category');

  // No search: the fixture site is listed.
  await expect(page.getByLabel('FixtureSite', { exact: true })).toBeVisible();

  // Name hit.
  await search.fill('fixture');
  await expect(page.getByLabel('FixtureSite', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1/6 sites match' })).toBeVisible();

  // Category hit (the category text 'Raw' matches too).
  await search.fill('raw');
  await expect(page.getByLabel('RawDex', { exact: true })).toBeVisible();
  await expect(page.getByLabel('FixtureSite', { exact: true })).toHaveCount(0);

  // Miss: empty state, no rows.
  await search.fill('zzz-does-not-exist');
  await expect(page.getByLabel('FixtureSite', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/No modules match the filters/)).toBeVisible();
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
