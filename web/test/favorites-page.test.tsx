// @vitest-environment jsdom
/**
 * Favorites page (§7.2): the listing with new-chapter badges, the
 * auto-download toggle (PUT + refetch), the manual check-now trigger
 * (POST + refetch), deletion and the empty state — fully offline via
 * the recorded mock fetch.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FavoritesPage } from '../src/pages/FavoritesPage';
import { autoCleanup, mockFetch, renderWithProviders, type MockRoute } from './helpers';
import { favoriteFixture } from './fixtures';
import type { FavoriteT } from '../src/api/hooks';

autoCleanup();

const FAV_ID = favoriteFixture().id;
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

describe('FavoritesPage', (): void => {
  it('renders the listing with title, status and chapter count', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const { fetch } = mockFetch([listRoute(state)]);
    renderWithProviders(<FavoritesPage />, { fetch });

    expect(await screen.findByText('Fixture Favorite')).toBeInTheDocument();
    expect(screen.getByText('Ongoing')).toBeInTheDocument();
    expect(screen.getByText('12 chapters')).toBeInTheDocument();
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

  it('remove DELETEs the favorite and the row disappears', async (): Promise<void> => {
    const state = favoritesState([favoriteFixture()]);
    const { fetch } = mockFetch([
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
    await waitFor((): void => {
      expect(screen.getByText('No favorites yet')).toBeInTheDocument();
    });
  });

  it('an empty list renders the explicit empty state', async (): Promise<void> => {
    const state = favoritesState([]);
    const { fetch } = mockFetch([listRoute(state)]);
    renderWithProviders(<FavoritesPage />, { fetch });
    expect(await screen.findByText('No favorites yet')).toBeInTheDocument();
  });
});
