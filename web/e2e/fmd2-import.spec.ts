/**
 * E2e: the Import-from-FMD2 happy path (Settings card → upload →
 * preview → confirm → result). The SPA runs against the mock API like
 * every settings spec (the server-side parse/apply contract has its
 * own 40-test suite — this spec proves the WEB flow end to end:
 * genuine multipart upload, preview rendering, credential opt-in OFF
 * by default, the apply token call, and the Favorites link out).
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockApi, MODULE_ID, module as fixtureModule } from './fixtures';

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

const API = (suffix: string): RegExp => new RegExp(`^https?://[^/]+/api/${suffix}`);

const UNMAPPED_ID = '5450026642ecrrd48apotd81e57f8e40';

const PREVIEW = {
  files: ['favorites.db'],
  ignored: [],
  favorites: {
    total: 3,
    importable: 2,
    bySite: [
      { moduleId: MODULE_ID, siteName: fixtureModule.name, count: 2, mapped: true },
    ],
    unmappedSiteIds: [{ id: UNMAPPED_ID, count: 1 }],
  },
  downloadedLedger: { rows: 2, matched: 2 },
  settings: {
    mappable: [
      { key: 'favorites-scheduler', label: 'Favorites check schedule', source: 'settings.json [update]', preview: 'check at startup, every 45 min', requiresCredentials: false },
    ],
    notImportable: [
      { source: 'settings.json [saveto] SaveTo', reason: 'desktop download path — the server manages its own library layout' },
    ],
  },
  credentials: {
    sites: [{ moduleId: MODULE_ID, siteName: fixtureModule.name, fields: ['username', 'password'] }],
    globalProxyAuth: false,
  },
  analyzeToken: 'e2e-token-1',
};

const REPORT = {
  favorites: {
    created: 2,
    updated: 0,
    unchanged: 0,
    skipped: [{ label: `Dead Row <${UNMAPPED_ID}/x>`, reason: 'site not installed (unknown catalog id)' }],
    unmappedSiteIds: [{ id: UNMAPPED_ID, count: 1 }],
    saveToPathsDropped: 1,
  },
  downloadedLedgerRowsApplied: 2,
  credentials: { imported: [], skipped: [] },
  settings: {
    applied: [{ key: 'favorites-scheduler', detail: 'favorites scheduler set (startup check on, every 45 min)' }],
    notImportable: PREVIEW.settings.notImportable,
  },
};

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await installMockApi(page);
  await page.route(API('import/fmd2/analyze'), (route): void => {
    void route.fulfill(json(PREVIEW));
  });
  await page.route(API('import/fmd2/apply'), (route): void => {
    void route.fulfill(json(REPORT));
  });
  // The Favorites landing (the result screen's link-out target).
  await page.route(API('favorites$'), (route): void => {
    void route.fulfill(json({ favorites: [] }));
  });
});

test('Settings → Import from FMD2: upload → preview → confirm → result (happy path)', async ({
  page,
}: {
  page: Page;
}): Promise<void> => {
  await page.goto('/#/settings');

  // The card renders idle with the dropzone.
  const section = page.getByTestId('fmd2-import-section');
  await expect(section).toBeVisible();
  await expect(section.getByTestId('fmd2-dropzone')).toBeVisible();

  // Upload a (fixture) favorites.db through the hidden input — a
  // GENUINE multipart body leaves the browser.
  const analyzeRequests: string[] = [];
  page.on('request', (req): void => {
    if (req.method() === 'POST' && /\/api\/import\/fmd2\/analyze$/.test(req.url())) {
      analyzeRequests.push(req.postData() ?? '');
    }
  });
  await section.getByTestId('fmd2-file-input').setInputFiles({
    name: 'favorites.db',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('SQLite format 3\0-e2e-fixture'),
  });
  await expect(analyzeRequests[0] ?? '').toContain('favorites.db');

  // The preview: counts, site row, unmapped id surfaced, settings ON,
  // credentials OFF by default.
  const preview = section.getByTestId('fmd2-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId('fmd2-preview-favorites')).toContainText('2 of 3');
  // The site renders in BOTH the by-site list and the credentials group.
  await expect(preview.getByText(fixtureModule.name).first()).toBeVisible();
  await expect(preview.getByTestId('fmd2-preview-unmapped')).toContainText(UNMAPPED_ID);
  await expect(preview.getByTestId('fmd2-setting-favorites-scheduler')).toBeChecked();
  await expect(preview.getByTestId(`fmd2-credential-${MODULE_ID}`)).not.toBeChecked();

  // Confirm: the apply call carries the token, favorites on, the
  // selected settings, and NO credentials (opt-in untouched).
  const applyBodies: string[] = [];
  page.on('request', (req): void => {
    if (req.method() === 'POST' && /\/api\/import\/fmd2\/apply$/.test(req.url())) {
      applyBodies.push(req.postData() ?? '');
    }
  });
  await preview.getByTestId('fmd2-apply').click();

  // The result summary: counts, unmapped enumeration, settings detail,
  // the not-imported list, and the Favorites link.
  const result = section.getByTestId('fmd2-result');
  await expect(result).toBeVisible();
  expect(applyBodies).toHaveLength(1);
  expect(JSON.parse(applyBodies[0] ?? '{}')).toEqual({
    token: 'e2e-token-1',
    favorites: true,
    settings: ['favorites-scheduler'],
    credentials: [],
  });
  await expect(result.getByTestId('fmd2-result-favorites')).toContainText('2 created');
  await expect(result.getByTestId('fmd2-result-unmapped')).toContainText(UNMAPPED_ID);
  await expect(result.getByTestId('fmd2-result-settings')).toContainText('favorites scheduler set');
  await expect(result.getByTestId('fmd2-result-notimported')).toContainText('not imported');

  // The link lands on Favorites.
  await result.getByRole('button', { name: 'Go to Favorites' }).click();
  await expect(page).toHaveURL(/#\/favorites$/);
});
