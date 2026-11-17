/**
 * Playwright e2e — [parity-sweep]:
 * 1. Open-by-URL (M14, FMD2 edURL parity): paste-and-go resolves the
 *    module by host (url-only POST /api/info), navigates to the manga
 *    page; unknown host surfaces the typed no-site error; Ctrl+Shift+V
 *    reads the clipboard and goes.
 * 2. Genre `!`-exclude (audit (b)2): typing `!Ecchi` in the custom
 *    genres EXCLUDES it — the applied chip renders distinctly
 *    (strikethrough, data-excluded) and the exclude rides the URL.
 * Fully offline: loopback + intercepted routes.
 */
import { test, expect } from '@playwright/test';
import { CATALOG_ID, installMockApi, module, type ModuleSummaryT } from './fixtures';

const SITE_ID = 'f'.repeat(32);

const siteModule: ModuleSummaryT = {
  ...module,
  options: [],
  id: SITE_ID,
  name: 'HostSite',
  rootURL: 'https://hostsite.example',
  catalogInstalled: true,
};

test.beforeEach(({ page }): void => {
  installMockApi(page);
  void page.route('**/api/modules', (route): void => {
    void route.fulfill({ contentType: 'application/json', body: JSON.stringify({ modules: [siteModule], count: 1 }) });
  });
});

test.describe('open-by-URL (M14)', (): void => {
  test.beforeEach(({ page }): void => {
    void page.route('**/api/info', (route): void => {
      const body = route.request().postDataJSON() as { moduleId?: string; url: string };
      // The url-only wire form carries NO moduleId (the server resolves
      // by host); the manga page then refetches WITH the resolved id —
      // both forms are served here.
      const urlOnly = body.moduleId === undefined;
      const known = (urlOnly || body.moduleId === SITE_ID) && body.url.includes('hostsite.example');
      if (known) {
        void route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            moduleId: SITE_ID,
            title: 'Hosted Manga',
            url: body.url,
            altTitles: '', authors: '', artists: '', genres: '', status: '', summary: '',
            coverLink: '', link: '', chapterLinks: [], chapterNames: [], numChapter: 0, downloaded: [],
          }),
        });
      } else {
        void route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'no_site_match', message: 'no site matches this URL' } }),
        });
      }
    });
  });

  test('paste-and-go resolves by host and navigates to the manga page', async ({ page }): Promise<void> => {
    await page.goto('/#/browse');
    await page.getByRole('textbox', { name: 'Open by URL' }).fill('https://hostsite.example/manga/hosted');
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(new RegExp(`#/manga\\?module=${SITE_ID}&url=`));
    await expect(page.getByText('Hosted Manga')).toBeVisible();
  });

  test('unknown host surfaces the typed no-site error, no navigation', async ({ page }): Promise<void> => {
    await page.goto('/#/browse');
    await page.getByRole('textbox', { name: 'Open by URL' }).fill('https://nowhere.example/manga/x');
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByTestId('open-by-url-error')).toHaveText(/No site matches this URL/);
    await expect(page).toHaveURL(/#\/browse$/);
  });

  test('Ctrl+Shift+V paste-and-go reads the clipboard and navigates', async ({ page, context }): Promise<void> => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/#/browse');
    await page.evaluate((): Promise<void> => globalThis.navigator.clipboard.writeText('https://hostsite.example/manga/clip'));
    const input = page.getByRole('textbox', { name: 'Open by URL' });
    await input.click();
    await input.press('Control+Shift+V');
    await expect(page).toHaveURL(new RegExp(`#/manga\\?module=${SITE_ID}&url=`));
  });
});

test.describe('genre !-exclude chips (audit (b)2)', (): void => {
  test('`!Ecchi` renders a distinct excluded chip and round-trips the URL', async ({ page }): Promise<void> => {
    await page.goto(`/#/browse?site=${CATALOG_ID}`);
    await page.getByRole('button', { name: /Filters/ }).click();
    await page.getByLabel('Custom genres').fill('!Ecchi');
    // The applied chip: None-of label + strikethrough/muted styling.
    const chip = page.locator('[data-testid="applied-filters"] [data-excluded="true"]');
    await expect(chip).toHaveText(/None of: Ecchi/);
    await expect(chip).toHaveClass(/line-through/);
    // The URL carries the exclude via the cgenres ! grammar.
    await expect(page).toHaveURL(/cgenres=%21Ecchi/);
    // Removing the chip clears the exclude (and the URL param).
    await chip.getByRole('button', { name: /Remove filter: None of: Ecchi/ }).click();
    await expect(page.locator('[data-testid="applied-filters"] [data-excluded="true"]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/cgenres/);
  });
});
