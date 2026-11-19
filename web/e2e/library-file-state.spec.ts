/**
 * Library file-state e2e (file-state story): a seeded library with a
 * MOVED file (re-linked by rescan), a DELETED file (missing), and an
 * ORPHAN shows correct badges and the re-link — on the Library page
 * (chips + rescan report) and the manga detail (Files section +
 * chapter badges). Fixture-driven like the parity specs: loopback +
 * interception only (the reconcile contract itself is pinned
 * hermetically in server/test/{jobs,api} against a REAL temp root).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { CATALOG_ID, MODULE_ID, installMockApi } from './fixtures';

const MANGA_URL = 'https://fixtures.example/manga/alpha';

const SEED = {
  ch1: {
    id: '101',
    moduleId: MODULE_ID,
    manga: 'Alpha Quest',
    fileName: 'Chapter 1 The Beginning.zip',
    bytes: 1258291,
    createdAt: '2026-11-18T17:34:02.117Z',
    state: 'downloaded',
    verifiedAt: '2026-11-19T00:00:00.000Z',
    path: 'Alpha Quest/Chapter 1 The Beginning.zip',
    absolutePath: '/srv/fmd/library/Alpha Quest/Chapter 1 The Beginning.zip',
    mtime: '2026-11-18T17:34:02.117Z',
  },
  ch2Deleted: {
    id: '102',
    moduleId: MODULE_ID,
    manga: 'Alpha Quest',
    fileName: 'Chapter 2 The Middle.zip',
    bytes: 999,
    createdAt: '2026-11-18T17:40:00.000Z',
    state: 'missing',
    verifiedAt: '2026-11-19T00:00:00.000Z',
    path: 'Alpha Quest/Chapter 2 The Middle.zip',
    absolutePath: '/srv/fmd/library/Alpha Quest/Chapter 2 The Middle.zip',
  },
  ch3Moved: {
    id: '103',
    moduleId: MODULE_ID,
    manga: 'Alpha Quest',
    fileName: 'Chapter 3 The Finale.zip',
    bytes: 2048,
    createdAt: '2026-11-18T17:44:00.000Z',
    // BEFORE the rescan: still recorded at the OLD directory → missing.
    state: 'missing',
    verifiedAt: '2026-11-19T00:00:00.000Z',
    path: 'Alpha Quest/Chapter 3 The Finale.zip',
    absolutePath: '/srv/fmd/library/Alpha Quest/Chapter 3 The Finale.zip',
  },
  orphan: {
    path: 'Alpha Quest/untracked-legacy.zip',
    absolutePath: '/srv/fmd/library/Alpha Quest/untracked-legacy.zip',
    bytes: 512,
    mtime: '2026-11-17T10:00:00.000Z',
  },
};

const REPORT = {
  startedAt: '2026-11-19T00:06:00.000Z',
  finishedAt: '2026-11-19T00:06:01.000Z',
  durationMs: 1000,
  scope: 'library',
  counts: { scanned: 3, present: 1, relinked: 1, missing: 1, orphans: 1, outsideRoot: 0 },
  relinked: [
    { id: '103', fromPath: 'Alpha Quest/Chapter 3 The Finale.zip', toPath: 'imported/Chapter 3 The Finale.zip' },
  ],
  missing: [
    { id: '102', manga: 'Alpha Quest', fileName: 'Chapter 2 The Middle.zip', path: 'Alpha Quest/Chapter 2 The Middle.zip', candidates: [] },
  ],
  orphans: [SEED.orphan],
};

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * The seeded library with rescan-driven truth: BEFORE the rescan the
 * moved chapter sits missing at its recorded (old) path; the POST
 * flips the store the way the real reconcile persists the re-link.
 */
function installLibraryState(page: Page): void {
  let rescanned = false;
  page.route(/\/api\/library\?/, (route: Route): void => {
    const url = new URL(route.request().url());
    const filter = url.searchParams.get('filter');
    if (filter === 'missing') {
      void route.fulfill(json({ files: [SEED.ch2Deleted] }));
      return;
    }
    if (filter === 'orphans') {
      void route.fulfill(json({ files: [], orphans: rescanned ? [SEED.orphan] : [] }));
      return;
    }
    const rows = [SEED.ch1, SEED.ch2Deleted, rescanned
      ? { ...SEED.ch3Moved, state: 'downloaded', path: 'imported/Chapter 3 The Finale.zip', absolutePath: '/srv/fmd/library/imported/Chapter 3 The Finale.zip' }
      : SEED.ch3Moved];
    void route.fulfill(json({ files: rows }));
  });
  page.route(/\/api\/library\/rescan/, (route: Route): void => {
    if (route.request().method() === 'POST') {
      rescanned = true;
      void route.fulfill(json({ report: REPORT }));
      return;
    }
    void route.fulfill(json({ report: rescanned ? REPORT : null }));
  });
  page.route(/\/api\/library\/title-files/, (route: Route): void => {
    void route.fulfill(
      json({
        moduleId: MODULE_ID,
        url: MANGA_URL,
        verifiedAt: '2026-11-19T00:05:00.000Z',
        files: [
          { ...SEED.ch1, chapterLink: '/manga/alpha/ch-1' },
          { ...SEED.ch2Deleted, chapterLink: '/manga/alpha/ch-2' },
          {
            ...(rescanned
              ? { ...SEED.ch3Moved, state: 'downloaded' as const, path: 'imported/Chapter 3 The Finale.zip', absolutePath: '/srv/fmd/library/imported/Chapter 3 The Finale.zip' }
              : SEED.ch3Moved),
            chapterLink: '/manga/alpha/ch-3',
          },
        ],
        orphans: rescanned ? [SEED.orphan] : [],
      }),
    );
  });
}

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await installMockApi(page);
  installLibraryState(page);
});

test('library: rescan re-links the moved file, keeps the deleted one missing, surfaces the orphan', async ({ page }: {
  page: Page;
}): Promise<void> => {
  await page.goto('#/library');
  // Seeded truth BEFORE the rescan: present + two missing (the moved
  // file is not at its recorded path yet).
  await expect(page.locator('.library-row', { hasText: 'Chapter 1 The Beginning.zip' })).toBeVisible();
  await expect(page.getByText('downloaded').first()).toBeVisible();
  await expect(page.locator('.library-row', { hasText: 'Chapter 3 The Finale.zip' }).getByText('missing')).toBeVisible();

  // URL-as-truth: the Missing chip filters + rewrites the hash.
  await page.getByTestId('library-filter-missing').click();
  await expect(page).toHaveURL(/#\/library\?filter=missing/);
  await expect(page.locator('.library-row', { hasText: 'Chapter 2 The Middle.zip' })).toBeVisible();
  await expect(page.locator('.library-row', { hasText: 'Chapter 1 The Beginning.zip' })).toHaveCount(0);

  // Back to All, run the rescan: the report shows the re-link…
  await page.getByTestId('library-filter-all').click();
  await page.getByTestId('library-rescan').click();
  const report = page.getByTestId('rescan-report');
  await expect(report).toBeVisible();
  await expect(report.getByTestId('rescan-relink')).toContainText('imported/Chapter 3 The Finale.zip');
  await expect(report.getByTestId('rescan-relink')).toContainText('Alpha Quest/Chapter 3 The Finale.zip');
  await expect(report.getByTestId('rescan-counts')).toContainText('1 re-linked');
  await expect(report.getByTestId('rescan-counts')).toContainText('1 missing');

  // …and the listing reflects the persisted truth: the moved chapter
  // is downloaded at its NEW path; the deleted chapter stays missing.
  await expect(page.locator('.library-row', { hasText: 'Chapter 3 The Finale.zip' }).getByText('downloaded')).toBeVisible();
  await expect(page.locator('.library-row', { hasText: 'Chapter 3 The Finale.zip' })).toContainText('imported/Chapter 3 The Finale.zip');
  await expect(page.locator('.library-row', { hasText: 'Chapter 2 The Middle.zip' }).getByText('missing')).toBeVisible();

  // The Orphans chip serves the persisted orphan list.
  await page.getByTestId('library-filter-orphans').click();
  await expect(page).toHaveURL(/#\/library\?filter=orphans/);
  await expect(page.locator('.library-row-orphan', { hasText: 'untracked-legacy.zip' })).toBeVisible();
  await expect(page.locator('.library-row-orphan').getByText('orphan')).toBeVisible();
});

test('manga detail: Files section + chapter badges carry the verified truth; per-title rescan lands', async ({ page }: {
  page: Page;
}): Promise<void> => {
  await page.goto(
    `/#/manga?catalog=${CATALOG_ID}&module=${MODULE_ID}&url=${encodeURIComponent(MANGA_URL)}&title=${encodeURIComponent('Alpha Quest')}`,
  );
  await expect(page.getByRole('heading', { name: 'Alpha Quest' })).toBeVisible();

  // Chapter list: downloaded badge on ch-1, missing badge on ch-2
  // (ledger truth, file gone), nothing on undownloaded chapters.
  await expect(page.locator('.chapter-list [data-file-state="downloaded"]')).toBeVisible();
  await expect(page.locator('.chapter-list [data-file-state="missing"]')).toBeVisible();

  // Files section: verified age visible, per-chapter rows with badges,
  // copy-path present.
  const files = page.getByTestId('files-section');
  await expect(files.getByText(/Verified/)).toBeVisible();
  await expect(files.locator('.files-row', { hasText: 'Chapter 1 The Beginning.zip' }).getByText('downloaded')).toBeVisible();
  await expect(files.locator('.files-row', { hasText: 'Chapter 2 The Middle.zip' }).getByText('missing')).toBeVisible();
  await expect(files.getByRole('button', { name: /Copy path/ }).first()).toBeVisible();

  // Per-title rescan: the summary line lands (moved file re-linked).
  await files.getByTestId('files-rescan').click();
  await expect(files.getByTestId('title-rescan-summary')).toContainText('1 re-linked');
  // The orphan surfaces under the title's directory after the rescan.
  await expect(files.locator('.files-row-orphan', { hasText: 'untracked-legacy.zip' })).toBeVisible();
});

test('library: copy-path copies the recorded absolute path', async ({ page, context }: {
  page: Page;
  context: import('@playwright/test').BrowserContext;
}): Promise<void> => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('#/library');
  await expect(page.locator('.library-row', { hasText: 'Chapter 1 The Beginning.zip' })).toBeVisible();
  await page.locator('.library-row', { hasText: 'Chapter 1 The Beginning.zip' }).getByTestId('library-copy-path').click();
  await expect(page.getByText('Path copied')).toBeVisible();
});
