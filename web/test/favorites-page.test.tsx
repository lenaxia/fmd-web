// @vitest-environment jsdom
/**
 * Favorites page (§7.2 + favorites-parity): the listing with new-chapter
 * badges, the auto-download toggle (PUT + refetch), the manual check-now
 * trigger (POST + refetch) + the new-chapter sheet it opens, deletion
 * with confirm, the FMD2 columns (website/saveTo/dates), the toolbar
 * batch check scopes, the row-menu surface (rename / save-to /
 * enable-disable / transfer / view-info) and the list import — fully
 * offline via the recorded mock fetch.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FavoritesPage, toSheetRows } from '../src/pages/FavoritesPage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { favoriteFixture, moduleFixture } from './fixtures';
import type { FavoriteT } from '../src/api/hooks';

autoCleanup();

const FAV = favoriteFixture();
const FAV_ID = FAV.id;
const FAV_MODULE = FAV.moduleId;
const ENC_ID = encodeURIComponent(FAV_ID);

function favoritesState(rows: FavoriteT[]): { state: FavoriteT[] } {
  return { state: [...rows] };
}

function listRoute(state: { state: FavoriteT[] }): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/favorites',
    respond: (): { body: object } => ({ body: { favorites: state.state } }),
  };
}

/** The modules join: the fixture site carries the FAVORITE's module id. */
function modulesRoute(extra: readonly { id: string; name: string }[] = []): MockRoute {
  return {
    method: 'GET',
    match: (url): boolean => url.pathname === '/api/modules',
    respond: (): { body: object } => ({
      body: {
        modules: [
          moduleFixture({ id: FAV_MODULE, name: 'FixtureSite' }),
          ...extra.map((site): FavoriteT | ReturnType<typeof moduleFixture> =>
            moduleFixture({ id: site.id, name: site.name }),
          ),
        ],
        count: 1 + extra.length,
      },
    }),
  };
}

const downloadRoute: MockRoute = {
  method: 'POST',
  match: (url): boolean => url.pathname === '/api/jobs/download',
  respond: (): { body: object; status?: number } => ({ body: { job: { id: 'j1' } }, status: 201 }),
};

const NEW_CHAPTERS = [
  { position: 12, link: 'https://ex.org/manga/fav/ch-13', name: 'Chapter 13' },
  { position: 13, link: 'https://ex.org/manga/fav/ch-14', name: 'Chapter 14' },
];

describe('FavoritesPage', (): void => {
  it('renders the listing with title, status and chapter count', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const { fetch } = mockFetch([listRoute(state)]);
    renderWithProviders(<FavoritesPage />, { fetch });

    expect(await screen.findByText('Fixture Favorite')).toBeInTheDocument();
    expect(screen.getByText('Ongoing')).toBeInTheDocument();
    expect(screen.getByText(/12 chapters/u)).toBeInTheDocument();
  });

  it('shows the new-chapter badge only when newChapterCount > 0', async (): Promise<void> => {
    const state = favoritesState([
      // distinct ids — both rows otherwise share the default fixture id
      favoriteFixture({ id: 'f'.repeat(32) + 'https://ex.org/manga/fresh', title: 'Fresh', newChapterCount: 3 }),
      favoriteFixture({ id: '0'.repeat(32) + 'https://ex.org/manga/quiet', title: 'Quiet', newChapterCount: 0 }),
    ]);
    const { fetch } = mockFetch([listRoute(state)]);
    renderWithProviders(<FavoritesPage />, { fetch });

    const badges = await screen.findAllByTestId('new-chapter-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('3 new');
    // the zero-count favorite renders without a badge but with its row
    expect(screen.getByText('Quiet')).toBeInTheDocument();
  });

  it('renders the FMD2 columns: website name (modules join), save-to and the three dates', async (): Promise<void> => {
    const state = favoritesState([
      favoriteFixture({
        saveTo: '/custom/dir',
        dateAdded: '2026-02-03T04:05:00Z',
        lastCheck: '2026-03-04T05:06:00Z',
        lastUpdated: '2026-04-05T06:07:00Z',
      }),
    ]);
    const { fetch } = mockFetch([listRoute(state), modulesRoute()]);
    renderWithProviders(<FavoritesPage />, { fetch });

    // The modules join resolves the website name (not the raw hex id).
    const meta = await screen.findByText(/12 chapters/u);
    expect(meta).toHaveTextContent('FixtureSite');
    expect(meta).toHaveTextContent('save to: /custom/dir');
    expect(meta).toHaveTextContent('added 2026-02-03 04:05');
    expect(meta).toHaveTextContent('checked 2026-03-04 05:06');
    expect(meta).toHaveTextContent('updated 2026-04-05 06:07');
    // The wide-grid header row carries the FMD2 column names (the
    // Added date deliberately rides the always-on meta line instead of
    // a grid column — asserted above via `added 2026-02-03 04:05`).
    expect(screen.getByText('Website')).toBeInTheDocument();
    expect(screen.getByText('Save to')).toBeInTheDocument();
    expect(screen.getByText('Checked')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('the auto-download toggle PUTs the flag and refetches', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture({ autoDownload: false })]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      {
        method: 'PUT',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}`,
        respond: (_url, body): { body: object } => {
          const patch = body as { autoDownload?: boolean };
          state.state = [favoriteFixture({ autoDownload: patch.autoDownload === true })];
          return { body: { favorite: state.state[0] } };
        },
      },
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    const toggle = await screen.findByTestId('autodownload-Fixture Favorite');
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await waitFor((): void => {
      expect(screen.getByTestId('autodownload-Fixture Favorite')).toBeChecked();
    });
    const put = requests.find((r) => r.method === 'PUT');
    expect(put?.body).toEqual({ autoDownload: true });
    // the invalidate refetch happened
    const gets = requests.filter((r) => r.method === 'GET' && r.path === '/api/favorites');
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it('check-now POSTs the check trigger and the badge updates from the refetch', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture({ newChapterCount: 0 })]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      {
        method: 'POST',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}/check`,
        respond: (): { body: object } => {
          state.state = [favoriteFixture({ newChapterCount: 5, currentChapter: 14 })];
          return {
            body: {
              favorite: state.state[0],
              queuedDownloads: 5,
              newChapters: [],
            },
          };
        },
      },
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Check Fixture Favorite for new chapters now' }),
    );

    const badge = await screen.findByTestId('new-chapter-badge');
    expect(badge).toHaveTextContent('5 new');
    expect(
      requests.some((r) => r.method === 'POST' && r.path === `/api/favorites/${ENC_ID}/check`),
    ).toBe(true);
  });

  it('check-now with new chapters opens the sheet and Download enqueues active jobs', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture({ newChapterCount: 0, autoDownload: false })]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      {
        method: 'POST',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}/check`,
        respond: (): { body: object } => {
          state.state = [favoriteFixture({ newChapterCount: 2, currentChapter: 14 })];
          return {
            body: {
              favorite: state.state[0],
              queuedDownloads: 0,
              newChapters: NEW_CHAPTERS,
            },
          };
        },
      },
      downloadRoute,
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Check Fixture Favorite for new chapters now' }),
    );

    const sheet = await screen.findByTestId('new-chapters-sheet');
    expect(within(sheet).getByText(/Fixture Favorite/u)).toBeInTheDocument();
    expect(within(sheet).getByTestId(`newchapter-count-${FAV_ID}`)).toHaveTextContent('2');
    await userEvent.click(within(sheet).getByTestId(`newchapter-download-${FAV_ID}`));
    await userEvent.click(within(sheet).getByTestId('newchapter-dismiss-all'));

    const downloads = requests.filter(
      (r): boolean => r.method === 'POST' && r.path === '/api/jobs/download',
    );
    expect(downloads).toHaveLength(2);
    expect(downloads[0]?.body).toMatchObject({ moduleId: FAV_MODULE });
    expect((downloads[0]?.body as { paused?: boolean }).paused).toBeUndefined();
  });

  it('remove asks for confirmation, then DELETEs the favorite and the row disappears', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      {
        method: 'DELETE',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}`,
        respond: (): { body: object } => {
          state.state = [];
          return { body: { ok: true } };
        },
      },
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await userEvent.click(await screen.findByRole('button', { name: 'Remove favorite Fixture Favorite' }));
    // The confirm dialog gates the DELETE (FMD2 asks before removing).
    expect(screen.getByTestId('delete-favorite-dialog')).toBeInTheDocument();
    expect(requests.filter((r): boolean => r.method === 'DELETE')).toHaveLength(0);
    await userEvent.click(screen.getByTestId('delete-favorite-confirm'));

    await waitFor((): void => {
      expect(screen.getByText('No favorites yet')).toBeInTheDocument();
    });
    expect(requests.filter((r): boolean => r.method === 'DELETE')).toHaveLength(1);
  });

  it('an empty list renders the explicit empty state', async (): Promise<void> => {
    const state = favoritesState([]);
    const { fetch } = mockFetch([listRoute(state)]);
    renderWithProviders(<FavoritesPage />, { fetch });
    expect(await screen.findByText('No favorites yet')).toBeInTheDocument();
  });
});

describe('FavoritesPage toolbar — batch check scopes + sheet', (): void => {
  function batchRoute(
    state: { state: FavoriteT[] },
    capture: { scope?: unknown },
  ): MockRoute {
    return {
      method: 'POST',
      match: (url): boolean => url.pathname === '/api/favorites/check',
      respond: (_url, body): { body: object } => {
        capture.scope = (body as { scope?: unknown })?.scope;
        return {
          body: {
            scope: capture.scope,
            cancelled: false,
            checked: state.state.length,
            failed: 0,
            queuedDownloads: 2,
            results: state.state.map((favorite): object => ({
              favorite,
              status: 'checked',
              // Real batch shape: auto rows carry their new chapters TOO
              // — already enqueued server-side (queuedDownloads > 0).
              newChapters: NEW_CHAPTERS,
              queuedDownloads: favorite.autoDownload ? NEW_CHAPTERS.length : 0,
            })),
          },
        };
      },
    };
  }

  it('Check for new chapters → scope menu → sheet lists results with auto rows pre-queued', async (): Promise<void> => {
    const capture: { scope?: unknown } = {};
    const manual = favoriteFixture({ newChapterCount: 0, autoDownload: false });
    const auto = favoriteFixture({
      id: 'b'.repeat(32) + 'https://ex.org/manga/auto',
      title: 'Auto Row',
      autoDownload: true,
      newChapterCount: 2,
    });
    const state = favoritesState([manual, auto]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      batchRoute(state, capture),
      downloadRoute,
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await screen.findByText('Fixture Favorite');
    await userEvent.click(screen.getByTestId('check-all-button'));
    await userEvent.click(screen.getByTestId('check-scope-enabled'));

    expect(capture.scope).toBe('enabled');
    const sheet = await screen.findByTestId('new-chapters-sheet');
    // The manual row is pending with per-row actions.
    expect(within(sheet).getByTestId(`newchapter-download-${manual.id}`)).toBeEnabled();
    // The auto row is pre-queued by the check — shown as such, no actions.
    expect(within(sheet).getByText('auto-queued (auto-download)')).toBeInTheDocument();
    expect(within(sheet).getByTestId(`newchapter-download-${auto.id}`)).toBeDisabled();

    // Global Download all starts the pending row's jobs (auto row untouched).
    await userEvent.click(within(sheet).getByTestId('newchapter-download-all'));
    const downloads = requests.filter(
      (r): boolean => r.method === 'POST' && r.path === '/api/jobs/download',
    );
    expect(downloads).toHaveLength(NEW_CHAPTERS.length);
  });

  it('Add all to queue creates PAUSED jobs (cbAddAsStopped parity)', async (): Promise<void> => {
    const capture: { scope?: unknown } = {};
    const manual = favoriteFixture({ newChapterCount: 0, autoDownload: false });
    const state = favoritesState([manual]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      batchRoute(state, capture),
      downloadRoute,
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await screen.findByText('Fixture Favorite');
    await userEvent.click(screen.getByTestId('check-all-button'));
    await userEvent.click(screen.getByTestId('check-scope-all'));
    const sheet = await screen.findByTestId('new-chapters-sheet');
    await userEvent.click(within(sheet).getByTestId('newchapter-queue-all'));

    const downloads = requests.filter(
      (r): boolean => r.method === 'POST' && r.path === '/api/jobs/download',
    );
    expect(downloads).toHaveLength(2);
    for (const download of downloads) {
      expect((download.body as { paused?: boolean }).paused).toBe(true);
    }
  });
});

describe('FavoritesPage row menu (pmFavorites parity)', (): void => {
  async function openMenu(): Promise<void> {
    await screen.findByText('Fixture Favorite');
    await userEvent.click(screen.getByTestId(`favorite-menu-${FAV_ID}`));
    await screen.findByTestId(`favorite-menu-content-${FAV_ID}`);
  }

  it('Rename edits inline and PUTs the new title', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      {
        method: 'PUT',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}`,
        respond: (_url, body): { body: object } => {
          const patch = body as { title?: string };
          state.state = [favoriteFixture({ title: patch.title ?? 'Fixture Favorite' })];
          return { body: { favorite: state.state[0] } };
        },
      },
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await openMenu();
    await userEvent.click(screen.getByTestId(`favorite-menu-rename-${FAV_ID}`));
    const input = screen.getByTestId(`favorite-rename-input-${FAV_ID}`);
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed Favorite');
    await userEvent.click(screen.getByTestId(`favorite-rename-save-${FAV_ID}`));

    const put = requests.find(
      (r): boolean => r.method === 'PUT' && (r.body as { title?: string }).title === 'Renamed Favorite',
    );
    expect(put).toBeDefined();
  });

  it('Change save-to opens the dialog and PUTs the directory', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      {
        method: 'PUT',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}`,
        respond: (_url, body): { body: object } => {
          const patch = body as { saveTo?: string };
          state.state = [favoriteFixture({ saveTo: patch.saveTo ?? null })];
          return { body: { favorite: state.state[0] } };
        },
      },
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await openMenu();
    await userEvent.click(screen.getByTestId(`favorite-menu-saveto-${FAV_ID}`));
    const input = screen.getByTestId('saveto-input');
    await userEvent.type(input, '/new/dir');
    await userEvent.click(screen.getByTestId('saveto-save'));

    const put = requests.find(
      (r): boolean => r.method === 'PUT' && (r.body as { saveTo?: string }).saveTo === '/new/dir',
    );
    expect(put).toBeDefined();
  });

  it('Disable PUTs enabled:false and the row badges as disabled', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      {
        method: 'PUT',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}`,
        respond: (): { body: object } => {
          state.state = [favoriteFixture({ enabled: false })];
          return { body: { favorite: state.state[0] } };
        },
      },
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await openMenu();
    await userEvent.click(screen.getByTestId(`favorite-menu-toggle-${FAV_ID}`));

    expect(requests.some((r): boolean => r.method === 'PUT' && (r.body as { enabled?: boolean }).enabled === false)).toBe(true);
    expect(await screen.findByTestId(`favorite-disabled-${FAV_ID}`)).toBeInTheDocument();
  });

  it('View manga info navigates to the manga route', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const { fetch } = mockFetch([listRoute(state)]);
    const originalHash = globalThis.location.hash;
    renderWithProviders(<FavoritesPage />, { fetch });

    await openMenu();
    await userEvent.click(screen.getByTestId(`favorite-menu-view-info-${FAV_ID}`));

    expect(globalThis.location.hash).toBe(
      `#/manga?module=${encodeURIComponent(FAV_MODULE)}&url=${encodeURIComponent(FAV.url)}`,
    );
    globalThis.location.hash = originalHash;
  });

  it('Transfer website: picker → valid preview → apply POSTs the transfer', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const TARGET = 'b'.repeat(32);
    const TARGET_URL = 'https://ex.org/target/match';
    const { fetch, requests } = mockFetch([
      listRoute(state),
      modulesRoute([{ id: TARGET, name: 'BetaSite' }]),
      {
        method: 'POST',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}/transfer/preview`,
        respond: (): { body: object } => ({
          body: {
            targetModuleId: TARGET,
            valid: true,
            targetUrl: TARGET_URL,
            matchedTitle: 'Fixture Favorite',
          },
        }),
      },
      {
        method: 'POST',
        match: (url): boolean => url.pathname === `/api/favorites/${ENC_ID}/transfer`,
        respond: (): { body: object } => {
          state.state = [
            favoriteFixture({ id: `${TARGET}${TARGET_URL}`.toLowerCase(), moduleId: TARGET, url: TARGET_URL }),
          ];
          return {
            body: { favorite: state.state[0], reloadedFromServer: false },
          };
        },
      },
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });

    await openMenu();
    await userEvent.click(screen.getByTestId(`favorite-menu-transfer-${FAV_ID}`));
    const dialog = await screen.findByTestId('transfer-dialog');
    await userEvent.selectOptions(within(dialog).getByTestId('transfer-target-select'), TARGET);
    expect(await within(dialog).findByTestId('transfer-preview-valid')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByTestId('transfer-apply'));

    await waitFor((): void => {
      expect(
        requests.some(
          (r): boolean =>
            r.method === 'POST' &&
            r.path === `/api/favorites/${ENC_ID}/transfer` &&
            (r.body as { clearDownloadedList?: boolean }).clearDownloadedList === false,
        ),
      ).toBe(true);
    });
  });
});

describe('FavoritesPage — import list (frmImportFavorites ADAPT)', (): void => {
  it('round-trips the existing /api/favorites/import with a per-row result report', async (): Promise<void> => {
    const state = favoritesState([]);
    const { fetch, requests } = mockFetch([
      listRoute(state),
      modulesRoute(),
      {
        method: 'POST',
        match: (url): boolean => url.pathname === '/api/favorites/import',
        respond: (_url, body): { body: object; status?: number } => {
          const input = body as { moduleId?: string; url?: string; title?: string };
          state.state = [
            favoriteFixture({
              id: `${input?.moduleId ?? ''}${input?.url ?? ''}`.toLowerCase(),
              moduleId: input?.moduleId ?? FAV_MODULE,
              url: input?.url ?? '',
              title: input?.title ?? null,
            }),
          ];
          return { body: { favorite: state.state[0] }, status: 201 };
        },
      },
    ]);
    renderWithProviders(<FavoritesPage />, { fetch });
    await screen.findByText('No favorites yet');

    await userEvent.click(screen.getByTestId('import-list-button'));
    const dialog = await screen.findByTestId('import-favorites-dialog');
    const listFile = new File(
      [
        JSON.stringify([
          { moduleId: FAV_MODULE, url: 'https://ex.org/manga/one', title: 'Imported One' },
          { website: 'NotInstalledSite', link: 'https://x.org/manga/two', title: 'Broken Two' },
        ]),
      ],
      'favorites.json',
      { type: 'application/json' },
    );
    await userEvent.upload(within(dialog).getByTestId('import-file-input'), listFile);

    const report = await within(dialog).findByTestId('import-report');
    expect(within(report).getAllByText(/pending/u)).toHaveLength(1);
    expect(within(report).getAllByText(/failed/u)).toHaveLength(1);

    await userEvent.click(within(dialog).getByTestId('import-run'));
    expect(await within(dialog).findByText(/1 imported · 1 failed · 0 pending/u)).toBeInTheDocument();
    const imports = requests.filter(
      (r): boolean => r.method === 'POST' && r.path === '/api/favorites/import',
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]?.body).toMatchObject({ moduleId: FAV_MODULE, url: 'https://ex.org/manga/one' });
    // The listing refetch shows the imported row.
    await screen.findByText('Imported One');
  });
});

describe('toSheetRows (check result → sheet rows)', (): void => {
  it('keeps only rows with new chapters; preQueued rides the queued count', (): void => {
    const rows = toSheetRows([
      {
        favorite: favoriteFixture(),
        status: 'checked',
        newChapters: NEW_CHAPTERS,
        queuedDownloads: 0,
      },
      {
        favorite: favoriteFixture({ id: 'c'.repeat(32) + 'x', autoDownload: true }),
        status: 'checked',
        newChapters: [],
        queuedDownloads: 3,
      },
      {
        favorite: favoriteFixture({ id: 'd'.repeat(32) + 'x', autoDownload: true }),
        status: 'checked',
        newChapters: [{ position: 1, link: '/l', name: 'N' }],
        queuedDownloads: 1,
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.preQueued).toBe(false);
    expect(rows[1]?.preQueued).toBe(true);
    expect(rows[1]?.autoDownload).toBe(true);
  });
});
