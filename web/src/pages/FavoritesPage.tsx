/**
 * Favorites (§7.2): the favorites listing with new-chapter badges, the
 * per-favorite auto-download toggle, the manual check-now trigger and
 * deletion. The badge (`new-chapter-badge`) renders `newChapterCount`
 * from the last check; every mutation invalidates the `['favorites']`
 * query so the rows re-render from server state.
 *
 * Design-system retrofit: PageHeader + ListPanel + EntryRow rows with
 * token-styled controls; testids, aria-labels and texts unchanged.
 */
import { type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2 } from 'lucide-react';
import {
  useCheckFavoriteNow,
  useDeleteFavorite,
  useFavorites,
  useUpdateFavorite,
  type FavoriteT,
} from '../api/hooks';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { EntryRow } from '@/components/patterns/EntryRow';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

function NewChapterBadge(props: { count: number }): ReactElement | null {
  if (props.count <= 0) {
    return null;
  }
  return (
    <Badge variant="success" data-testid="new-chapter-badge" className="new-chapter-badge">
      {props.count} new
    </Badge>
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
    <EntryRow
      data={{ 'data-favorite-id': favorite.id }}
      className="favorite-row"
      title={<span className="favorite-title">{label}</span>}
      badges={
        <>
          <NewChapterBadge count={favorite.newChapterCount} />
          <Badge variant="outline" className="favorite-status">{favorite.status ?? '—'}</Badge>
        </>
      }
      meta={
        <span className="favorite-count">
          {favorite.currentChapter === null ? 'no check yet' : `${favorite.currentChapter} chapters`}
        </span>
      }
      trailing={
        <div className="flex shrink-0 items-center gap-2">
          <label className="favorite-autodownload flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-(--primary)"
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="favorite-check h-7"
            disabled={pending}
            aria-label={`Check ${label} for new chapters now`}
            onClick={(): void => {
              checkNow.mutate(favorite.id, { onSuccess: refresh });
            }}
          >
            <RefreshCw aria-hidden="true" />
            {checkNow.isPending ? 'Checking…' : 'Check now'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="favorite-delete h-7 text-destructive hover:bg-destructive/10"
            disabled={pending}
            aria-label={`Remove favorite ${label}`}
            onClick={(): void => {
              remove.mutate(favorite.id, { onSuccess: refresh });
            }}
          >
            <Trash2 aria-hidden="true" />
            Remove
          </Button>
        </div>
      }
    />
  );
}

export function FavoritesPage(): ReactElement {
  const favorites = useFavorites();

  if (favorites.isPending) {
    return (
      <section aria-label="Favorites">
        <PageHeader title="Favorites" description="Tracked titles with new-chapter checks on schedule." />
        <p role="status" className="text-sm text-muted-foreground">Loading favorites…</p>
      </section>
    );
  }
  if (favorites.isError) {
    return (
      <section aria-label="Favorites">
        <PageHeader title="Favorites" description="Tracked titles with new-chapter checks on schedule." />
        <ErrorBanner error={favorites.error} />
      </section>
    );
  }
  const rows = favorites.data.favorites;
  if (rows.length === 0) {
    return (
      <section aria-label="Favorites">
        <PageHeader title="Favorites" description="Tracked titles with new-chapter checks on schedule." />
        <EmptyState title="No favorites yet">
          <p>
            Add favorites from a manga page — the favorites engine checks
            them on schedule (bounded concurrency, per-favorite interval +
            jitter) and badges the new chapters it finds.
          </p>
        </EmptyState>
      </section>
    );
  }
  return (
    <section aria-label="Favorites">
      <PageHeader title="Favorites" description="Tracked titles with new-chapter checks on schedule." />
      <ListPanel
        className="favorite-list rounded-lg border"
        ariaLabel="Favorites"
        items={rows}
        itemKey={(favorite): string => favorite.id}
        rowClassName="favorite-row"
        renderItem={(favorite): ReactElement => <FavoriteRow favorite={favorite} />}
      />
    </section>
  );
}
