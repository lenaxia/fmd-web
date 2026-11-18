/**
 * R5 ARRIVAL EXPERIENCE E2E (tsk-insular-verdict-ambles):
 *
 *   - 'While you were away' summary: stale-visit + news renders the
 *     card (downloads grouped + deep links, favorites news); all card
 *     states (downloads-only / favorites-only / both); dismiss
 *     persists per news batch (a NEWER batch re-shows); no-news and
 *     fresh-visit render nothing.
 *   - Downloads nav activity badge: running+queued count from the
 *     queue (REST seed), a LIVE WS event updates it, a completion
 *     fires the toast + dot and VISITING Downloads clears the dot,
 *     and a reconnect+resync round-trip re-derives the count
 *     (backfill-safe).
 *   - PWA: /manifest.webmanifest serves valid JSON with the required
 *     fields incl. a maskable icon, and the icon assets resolve.
 *   - Install surfaces: hidden without beforeinstallprompt, shown
 *     (and functional) once the browser fires it.
 *
 * Desktop project: full matrix. Mobile project (390x844): the badge
 * on the bottom tab bar + the card at the mobile viewport.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installMockApi, MODULE_ID } from './fixtures';
import type { FavoriteT, JobT } from '../src/api/hooks';

// ── fixtures ─────────────────────────────────────────────────────────

/** Two days before 'today' — comfortably past the 1 h stale floor. */
const STALE_VISIT = '2026-11-15T00:00:00.000Z';

function doneJob(id: string, title: string, chapter: string, finished: string): JobT {
  return {
    id,
    type: 'download',
    moduleId: MODULE_ID,
    payload: {
      mangaUrl: `https://fixtures.example/manga/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      mangaTitle: title,
      chapterLink: `https://fixtures.example/manga/x/${id}`,
      chapterName: chapter,
    },
    state: 'done',
    priority: 0,
    createdAt: STALE_VISIT,
    updatedAt: finished,
  };
}

function newsyFavorite(title: string, chapters: number, checked: string): FavoriteT {
  const id = `${MODULE_ID}https://fixtures.example/manga/${encodeURIComponent(title)}`.toLowerCase();
  return {
    id,
    moduleId: MODULE_ID,
    url: `https://fixtures.example/manga/${encodeURIComponent(title)}`,
    title,
    status: 'Ongoing',
    currentChapter: 12,
    newChapterCount: chapters,
    autoDownload: false,
    lastCheck: checked,
    lastUpdated: checked,
    saveTo: null,
    enabled: true,
    dateAdded: STALE_VISIT,
    coverLink: null,
    ...(checked >= STALE_VISIT ? { newsSince: true } : {}),
  };
}

function activeJob(id: string, state: 'queued' | 'running', title: string): JobT {
  return {
    id,
    type: 'download',
    moduleId: MODULE_ID,
    payload: { mangaTitle: title, chapterName: 'Ch. 1' },
    state,
    priority: 0,
    createdAt: STALE_VISIT,
    updatedAt: STALE_VISIT,
  };
}

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * Seed a STALE last-visit stamp on every load (the away card's gate is
 * previous-stamp >= 1 h; the init script re-seeds it before app code
 * each navigation, so a reload still exercises the stale path).
 */
async function seedStaleVisit(page: Page): Promise<void> {
  await page.addInitScript((stamp: string): void => {
    try {
      window.localStorage.setItem('fmd-web-last-visit', stamp);
    } catch {
      /* storage unavailable */
    }
  }, STALE_VISIT);
}

/** Intercept the away-summary's two data calls (registered AFTER
 * installMockApi — Playwright matches in reverse registration order,
 * so these win over the generic fixtures). */
async function installAwayNews(
  page: Page,
  news: { readonly doneJobs?: readonly JobT[]; readonly favorites?: readonly FavoriteT[] },
): Promise<void> {
  await page.route(/\/api\/jobs\?/, (route): void => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('states') === 'done' && url.searchParams.get('since') === STALE_VISIT) {
      void route.fulfill(json({ jobs: [...(news.doneJobs ?? [])] }));
      return;
    }
    // Any other jobs listing (the activity badge query included).
    void route.fulfill(json({ jobs: [] }));
  });
  await page.route(/\/api\/favorites\?/, (route): void => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('since')).toBe(STALE_VISIT);
    void route.fulfill(json({ favorites: [...(news.favorites ?? [])] }));
  });
}

// ── away summary (desktop matrix) ────────────────────────────────────

test.describe('away summary', (): void => {
  test.skip((): boolean => false, '');

  test('downloads-only card: grouped rows, deep links, count chips', async ({
    page,
  }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop matrix');
    await seedStaleVisit(page);
    await installMockApi(page);
    await installAwayNews(page, {
      doneJobs: [
        doneJob('41', 'Alpha Quest', 'Ch. 1', '2026-11-16T08:00:00.000Z'),
        doneJob('42', 'Alpha Quest', 'Ch. 2', '2026-11-16T09:00:00.000Z'),
        doneJob('43', 'Beta Trails', 'Ch. 9', '2026-11-16T10:00:00.000Z'),
      ],
    });

    await page.goto('/');
    const card = page.getByTestId('away-summary');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('away-summary-downloads')).toBeVisible();
    await expect(page.getByTestId('away-summary-favorites')).toHaveCount(0);

    const rows = page.getByTestId('away-summary-download');
    await expect(rows).toHaveCount(2); // grouped per manga
    // Newest manga first; the grouped count chip reads chapters.
    await expect(rows.first()).toContainText('Beta Trails');
    await expect(rows.first()).toContainText('1 chapter');
    await expect(rows.nth(1)).toContainText('Alpha Quest');
    await expect(rows.nth(1)).toContainText('2 chapters');

    // Deep links navigate to the manga page with module+url (the row
    // anchors are preventDefault + navigateToManga since M-1 back-context).
    await rows.first().click();
    await expect(page).toHaveURL(/#\/manga\?module=/u);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent('https://fixtures.example/manga/beta-trails')));
  });

  test('favorites-only and both card states', async ({ page }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop matrix');

    // favorites-only
    await seedStaleVisit(page);
    await installMockApi(page);
    await installAwayNews(page, {
      favorites: [newsyFavorite('Gamma Saga', 2, '2026-11-16T12:00:00.000Z')],
    });
    await page.goto('/');
    await expect(page.getByTestId('away-summary')).toBeVisible();
    await expect(page.getByTestId('away-summary-downloads')).toHaveCount(0);
    await expect(page.getByTestId('away-summary-favorites')).toBeVisible();
    const favRow = page.getByTestId('away-summary-favorite');
    await expect(favRow).toHaveCount(1);
    await expect(favRow).toContainText('Gamma Saga');
    await expect(favRow).toContainText('2 new chapters');
    await expect(favRow).toHaveAttribute('href', '#/favorites');

    // both (a fresh context per state keeps caches independent)
    const both = await page.context().browser()?.newContext();
    expect(both).not.toBeNull();
    const page2 = await both!.newPage();
    await seedStaleVisit(page2);
    await installMockApi(page2);
    await installAwayNews(page2, {
      doneJobs: [doneJob('51', 'Delta Tales', 'Ch. 4', '2026-11-16T11:00:00.000Z')],
      favorites: [newsyFavorite('Gamma Saga', 2, '2026-11-16T12:00:00.000Z')],
    });
    await page2.goto('/');
    await expect(page2.getByTestId('away-summary')).toBeVisible();
    await expect(page2.getByTestId('away-summary-downloads')).toBeVisible();
    await expect(page2.getByTestId('away-summary-favorites')).toBeVisible();
    await both!.close();
  });

  test('dismiss persists per batch; a newer batch re-shows', async ({
    page,
  }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop matrix');
    await seedStaleVisit(page);
    await installMockApi(page);
    await installAwayNews(page, {
      doneJobs: [doneJob('61', 'Alpha Quest', 'Ch. 1', '2026-11-16T08:00:00.000Z')],
    });

    await page.goto('/');
    await expect(page.getByTestId('away-summary')).toBeVisible();
    await page.getByTestId('away-summary-dismiss').click();
    await expect(page.getByTestId('away-summary')).toHaveCount(0);

    // Reload: same batch (same newest timestamp) → still dismissed.
    await page.reload();
    await expect(page.getByTestId('away-summary')).toHaveCount(0);

    // A NEWER batch (newest item timestamp moved) → the card returns.
    await installAwayNews(page, {
      doneJobs: [doneJob('62', 'Alpha Quest', 'Ch. 2', '2026-11-16T15:00:00.000Z')],
    });
    await page.unroute(/\/api\/jobs\?/);
    await page.unroute(/\/api\/favorites\?/);
    await installAwayNews(page, {
      doneJobs: [doneJob('62', 'Alpha Quest', 'Ch. 2', '2026-11-16T15:00:00.000Z')],
    });
    await page.reload();
    await expect(page.getByTestId('away-summary')).toBeVisible();
    await expect(page.getByTestId('away-summary-download').first()).toContainText('1 chapter');
  });

  test('no news renders nothing; a fresh visit renders nothing', async ({
    page,
  }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop matrix');

    // Stale visit, zero news.
    await seedStaleVisit(page);
    await installMockApi(page);
    await installAwayNews(page, {});
    await page.goto('/');
    await expect(page.getByTestId('away-summary')).toHaveCount(0);

    // Fresh visit (no stamp at all): even with news on the server the
    // card stays hidden — beginVisit records this as a first run.
    const fresh = await page.context().browser()?.newContext();
    expect(fresh).not.toBeNull();
    const page2 = await fresh!.newPage();
    await installMockApi(page2);
    await installAwayNews(page2, {
      doneJobs: [doneJob('71', 'Alpha Quest', 'Ch. 1', '2026-11-16T08:00:00.000Z')],
    });
    await page2.goto('/');
    await expect(page2.getByTestId('away-summary')).toHaveCount(0);
    await fresh!.close();
  });
});

// ── nav activity badge + completion (desktop) ────────────────────────

test.describe('downloads activity badge', (): void => {
  async function installQueue(page: Page, active: readonly JobT[]): Promise<void> {
    await page.route(/\/api\/jobs\?/, (route): void => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('states') === 'queued,running') {
        void route.fulfill(json({ jobs: active.map((job): JobT => ({ ...job })) }));
        return;
      }
      void route.fulfill(json({ jobs: [] }));
    });
  }

  test('live count from REST, WS update, completion toast + dot clears on visit', async ({
    page,
  }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop matrix');
    await installMockApi(page);
    const running = activeJob('81', 'running', 'Alpha Quest');
    const queued = activeJob('82', 'queued', 'Beta Trails');
    const active = [running, queued];
    await installQueue(page, active);

    // Capture the mock event stream. The holder keeps the NEWEST
    // connection (dev StrictMode double-mounts the provider — its
    // first socket is closed by cleanup; the last one is live).
    const holder: { ws?: { send(data: string): void } } = {};
    await page.routeWebSocket(/^ws:\/\/[^/]+\/ws$/, (ws): void => {
      holder.ws = ws as unknown as { send(data: string): void };
      ws.onMessage((): void => {
        /* hello acknowledged; events are pushed by the test */
      });
    });

    await page.goto('/');
    const badge = page.getByTestId('nav-downloads-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('2');

    // LIVE WS event: the running job completes → count drops, toast
    // fires, the dot appears (Downloads not yet visited).
    const doneEvent = { type: 'event', id: '201', job: { ...running, state: 'done', updatedAt: '2026-11-17T11:00:00.000Z' } };
    holder.ws?.send(JSON.stringify(doneEvent));
    await expect(badge).toHaveText('1');
    await expect(page.getByText(/Downloaded: Alpha Quest/)).toBeVisible();
    await expect(page.getByTestId('nav-downloads-dot')).toBeVisible();

    // VISITING Downloads clears the dot (the count badge stays live).
    await page.goto('#/downloads');
    await expect(page.getByTestId('nav-downloads-dot')).toHaveCount(0);
    await expect(badge).toHaveText('1');
    void active;
  });

  test('reconnect + resync re-derives the count (backfill-safe)', async ({
    page,
  }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop matrix');
    await installMockApi(page);
    const running = activeJob('91', 'running', 'Alpha Quest');
    const queued = activeJob('92', 'queued', 'Beta Trails');
    await installQueue(page, [running, queued]);

    let connections = 0;
    // StrictMode's double-mount adds one extra (dead) initial socket;
    // baseline marks the live set so ONLY post-close reconnects get
    // the resync answer.
    let baseline = Number.MAX_SAFE_INTEGER;
    const live: { close(): void }[] = [];
    await page.routeWebSocket(/^ws:\/\/[^/]+\/ws$/, (ws): void => {
      connections += 1;
      live.push(ws as unknown as { close(): void });
      ws.onMessage((): void => {
        if (connections > baseline) {
          // The RECONNECTED socket answers backfill with a resync
          // hint: the client must refetch full state and reset its
          // cursor (D19).
          ws.send(JSON.stringify({ type: 'resync' }));
        }
      });
    });

    await page.goto('/');
    await expect(page.getByTestId('nav-downloads-badge')).toHaveText('2');

    // The queue drained while the socket drops → after the reconnect
    // + resync the refetched count reflects the drained queue.
    await installQueue(page, [running]);
    baseline = connections;
    live[live.length - 1]?.close();
    await expect(page.getByTestId('nav-downloads-badge')).toHaveText('1');
  });
});

// ── PWA (desktop) ────────────────────────────────────────────────────

test.describe('PWA installability', (): void => {
  test('manifest serves valid JSON with required fields incl. maskable icon', async ({
    page,
  }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop matrix');
    const response = await page.request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      background_color?: string;
      theme_color?: string;
      icons?: { src?: string; sizes?: string; purpose?: string }[];
    };
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toMatch(/^#/);
    expect(manifest.theme_color).toMatch(/^#/);
    const icons = manifest.icons ?? [];
    expect(icons.some((icon): boolean => icon.sizes === '192x192' && icon.purpose === 'any')).toBe(true);
    expect(icons.some((icon): boolean => icon.sizes === '512x512' && icon.purpose === 'maskable')).toBe(true);
    // The declared icon assets actually resolve.
    for (const icon of icons) {
      const iconResponse = await page.request.get(icon.src ?? '/');
      expect(iconResponse.status()).toBe(200);
    }
    // The SPA shell links the manifest + the iOS meta pair.
    const shell = await page.goto('/');
    const html = await shell?.text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('apple-touch-icon');
  });

  test('install surfaces hidden without beforeinstallprompt, shown when it fires', async ({
    page,
  }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop matrix');
    await installMockApi(page);

    await page.goto('/#/settings');
    await expect(page.getByTestId('about-section')).toBeVisible();
    await expect(page.getByTestId('install-app-action')).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette-input')).toBeVisible();
    await expect(page.getByTestId('palette-action-install-app')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Fire the browser event: the surfaces appear and the prompt runs.
    await page.evaluate((): void => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.defineProperty(event, 'prompt', {
        value: (): Promise<{ outcome: 'accepted' | 'dismissed' }> =>
          Promise.resolve({ outcome: 'accepted' }),
      });
      window.dispatchEvent(event);
    });
    await expect(page.getByTestId('install-app-action')).toBeVisible();
    await page.getByTestId('install-app-action').click();
    await expect(page.getByText(/installed: find it/)).toBeVisible();
    // Consumed (accepted): the surface hides again.
    await expect(page.getByTestId('install-app-action')).toHaveCount(0);
  });
});

// ── mobile project (390x844) ─────────────────────────────────────────

test.describe('arrival experience (mobile)', (): void => {
  test('badge renders on the bottom tab bar and updates over WS; card renders at 390x844', async ({
    page,
  }, testInfo: TestInfo): Promise<void> => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile project');
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });

    await seedStaleVisit(page);
    await installMockApi(page);
    const running = activeJob('a1', 'running', 'Alpha Quest');
    const queued = activeJob('a2', 'queued', 'Beta Trails');
    await page.route(/\/api\/jobs\?/, (route): void => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('states') === 'done' && url.searchParams.get('since') === STALE_VISIT) {
        void route.fulfill(
          json({ jobs: [doneJob('a3', 'Alpha Quest', 'Ch. 1', '2026-11-16T08:00:00.000Z')] }),
        );
        return;
      }
      if (url.searchParams.get('states') === 'queued,running') {
        void route.fulfill(json({ jobs: [running, queued] }));
        return;
      }
      void route.fulfill(json({ jobs: [] }));
    });
    await page.route(/\/api\/favorites\?/, (route): void => {
      void route.fulfill(json({ favorites: [] }));
    });

    const holder: { ws?: { send(data: string): void } } = {};
    await page.routeWebSocket(/^ws:\/\/[^/]+\/ws$/, (ws): void => {
      holder.ws = ws as unknown as { send(data: string): void };
      ws.onMessage((): void => undefined);
    });

    await page.goto('/');
    // The card renders at the mobile viewport.
    await expect(page.getByTestId('away-summary')).toBeVisible();
    await expect(page.getByTestId('away-summary-download')).toHaveCount(1);

    // The badge rides the bottom bar.
    const badge = page.getByTestId('bottom-nav-downloads-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('2');

    // A live completion drops the count and dots the destination.
    holder.ws?.send(
      JSON.stringify({
        type: 'event',
        id: '202',
        job: { ...running, state: 'done', updatedAt: '2026-11-17T11:30:00.000Z' },
      }),
    );
    await expect(badge).toHaveText('1');
    await expect(page.getByText(/Downloaded: Alpha Quest/)).toBeVisible();

    // Tapping through VISITS Downloads — the dot (rendered only while
    // a completion is unacknowledged) clears.
    await page.getByTestId('bottom-nav-downloads').click();
    await expect(page).toHaveURL(/#\/downloads/);
    await expect(page.getByTestId('bottom-nav-downloads-dot')).toHaveCount(0);
    await expect(badge).toHaveText('1');
  });
});
