/**
 * Favorites (§7.2): the favorites listing with new-chapter badges, the
 * per-favorite auto-download toggle, the manual check-now trigger and
 * deletion. The badge (`new-chapter-badge`) renders `newChapterCount`
 * from the last check; every mutation invalidates the `['favorites']`
 * query so the rows re-render from server state.
 */
import { type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCheckFavoriteNow,
  useDeleteFavorite,
  useFavorites,
  useUpdateFavorite,
  type FavoriteT,
} from '../api/hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';

function NewChapterBadge(props: { count: number }): ReactElement | null {
  if (props.count <= 0) {
    return null;
  }
  return (
    <span className="badge new-chapter-badge" data-testid="new-chapter-badge">
      {props.count} new
    </span>
  );
}

function FavoriteRow(props: { favorite: FavoriteT }): ReactElement {
  const favorite = props.favorite;
  const queryClient = useQueryClient();
  const update = useUpdateFavorite();
  const checkNow = useCheckFavoriteNow();
  const remove = useDeleteFavorite();

  const pending = update.isPending || checkNow.isPending || remove.isPending;
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['favorites'] });
  };
  const label = favorite.title ?? favorite.url;

  return (
    <li className="favorite-row" data-favorite-id={favorite.id}>
      <span className="favorite-title">{label}</span>{' '}
      <NewChapterBadge count={favorite.newChapterCount} />{' '}
      <span className="favorite-status">{favorite.status ?? '—'}</span>{' '}
      <span className="favorite-count">
        {favorite.currentChapter === null ? 'no check yet' : `${favorite.currentChapter} chapters`}
      </span>
      <label className="favorite-autodownload">
        <input
          type="checkbox"
          checked={favorite.autoDownload}
          disabled={pending}
          data-testid={`autodownload-${label}`}
          aria-label={`Auto-download new chapters for ${label}`}
          onChange={(event): void => {
            update.mutate(
              { id: favorite.id, autoDownload: event.target.checked },
              { onSuccess: refresh },
            );
          }}
        />
        auto-download
      </label>
      <button
        type="button"
        className="favorite-check"
        disabled={pending}
        aria-label={`Check ${label} for new chapters now`}
        onClick={(): void => {
          checkNow.mutate(favorite.id, { onSuccess: refresh });
        }}
      >
        {checkNow.isPending ? 'Checking…' : 'Check now'}
      </button>
      <button
        type="button"
        className="favorite-delete"
        disabled={pending}
        aria-label={`Remove favorite ${label}`}
        onClick={(): void => {
          remove.mutate(favorite.id, { onSuccess: refresh });
        }}
      >
        Remove
      </button>
    </li>
  );
}

export function FavoritesPage(): ReactElement {
  const favorites = useFavorites();

  if (favorites.isPending) {
    return (
      <main>
        <h1>Favorites</h1>
        <p role="status">Loading favorites…</p>
      </main>
    );
  }
  if (favorites.isError) {
    return (
      <main>
        <h1>Favorites</h1>
        <ErrorBanner error={favorites.error} />
      </main>
    );
  }
  const rows = favorites.data.favorites;
  if (rows.length === 0) {
    return (
      <main>
        <h1>Favorites</h1>
        <EmptyState title="No favorites yet">
          <p>
            Add favorites from a manga page — the favorites engine checks
            them on schedule (bounded concurrency, per-favorite interval +
            jitter) and badges the new chapters it finds.
          </p>
        </EmptyState>
      </main>
    );
  }
  return (
    <main>
      <h1>Favorites</h1>
      <ul className="favorite-list">
        {rows.map((favorite): ReactElement => (
          <FavoriteRow key={favorite.id} favorite={favorite} />
        ))}
      </ul>
    </main>
  );
}
