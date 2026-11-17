/**
 * Favorites (§7.2 + favorites-parity): the full FMD2 favorites-tab
 * surface — the column listing (Website / Current chapter / Save to /
 * Date added / Last checked / Last updated, responsive secondary line
 * on narrow), the toolbar batch check with scopes (All / Enabled /
 * Disabled) + cancel + the list import, the per-row Check now, the
 * row overflow menu (View info / Download all new / Rename / Transfer
 * website / Change save-to / Enable-Disable / Delete with confirm) and
 * the NewChaptersSheet decision UI after every check with results.
 *
 * Design-system retrofit: PageHeader + ListPanel + EntryRow rows with
 * token-styled controls; testids, aria-labels and texts stable.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MoreVertical, RefreshCw, Trash2 } from 'lucide-react';
import {
  useCancelFavoritesCheck,
  useCheckFavoriteNow,
  useCreateDownloadJob,
  useFavorites,
  useFavoritesCheckBatch,
  useModules,
  useUpdateFavorite,
  type FavoriteCheckBatchItemT,
  type FavoriteT,
} from '../api/hooks';
import type { ModuleSummaryT } from '../api/hooks';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  FavoriteColumnHeader,
  FavoriteColumnMeta,
  FavoriteGridRow,
} from '../components/favorites/FavoritesColumns';
import {
  NewChaptersSheet,
  type NewChapterRow,
} from '../components/favorites/NewChaptersSheet';
import { TransferDialog } from '../components/favorites/TransferDialog';
import { ImportFavoritesDialog } from '../components/favorites/ImportFavoritesDialog';
import { SaveToDialog } from '../components/favorites/SaveToDialog';
import { DeleteFavoriteDialog } from '../components/favorites/DeleteFavoriteDialog';

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

/** One batch/single check result row translated for the sheet. */
export function toSheetRows(results: readonly FavoriteCheckBatchItemT[]): NewChapterRow[] {
  return results
    .filter((result): boolean => result.newChapters.length > 0)
    .map((result): NewChapterRow => ({
      favoriteId: result.favorite.id,
      title: result.favorite.title ?? result.favorite.url,
      website: result.favorite.moduleId,
      count: result.newChapters.length,
      autoDownload: result.favorite.autoDownload,
      preQueued: result.queuedDownloads > 0,
      newChapters: result.newChapters.map((chapter): { position: number; link: string; name: string } => ({
        ...chapter,
      })),
    }));
}

interface RowDialogsState {
  readonly saveTo: FavoriteT | null;
  readonly transfer: FavoriteT | null;
  readonly remove: FavoriteT | null;
}

function FavoriteListRow(props: {
  readonly index: number;
  readonly favorite: FavoriteT;
  readonly website: string;
  readonly renaming: boolean;
  readonly onStartRename: (id: string) => void;
  readonly onCheckNow: (favorite: FavoriteT) => void;
  readonly onDownloadAllNew: (favorite: FavoriteT) => void;
  readonly onOpenDialogs: (state: Partial<RowDialogsState>) => void;
  readonly pending: boolean;
}): ReactElement {
  const { favorite, website, index } = props;
  const update = useUpdateFavorite();
  const [renameDraft, setRenameDraft] = useState(favorite.title ?? favorite.url);

  const label = favorite.title ?? favorite.url;
  const pending = props.pending || update.isPending;

  const titleCell = props.renaming ? (
    <span className="flex min-w-0 flex-1 flex-col gap-1 md:col-span-6 md:row-span-1">
      <span className="flex w-full items-center gap-2">
        <input
          className="favorite-rename-input h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
          aria-label={`Rename favorite ${label}`}
          data-testid={`favorite-rename-input-${favorite.id}`}
          value={renameDraft}
          autoFocus
          disabled={update.isPending}
          onChange={(event): void => setRenameDraft(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          className="h-7"
          data-testid={`favorite-rename-save-${favorite.id}`}
          disabled={update.isPending || renameDraft.trim() === ''}
          onClick={(): void => {
            update.mutate(
              { id: favorite.id, title: renameDraft.trim() },
              { onSuccess: (): void => props.onStartRename('') },
            );
          }}
        >
          Save
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={(): void => props.onStartRename('')}
        >
          Cancel
        </Button>
      </span>
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex w-full flex-wrap items-center gap-2">
        <span className="favorite-index hidden w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums md:inline">
          {index + 1}
        </span>
        <span className="favorite-title min-w-0 truncate text-sm font-medium">{label}</span>
        <NewChapterBadge count={favorite.newChapterCount} />
        <Badge variant="outline" className="favorite-status">{favorite.status ?? '—'}</Badge>
        {favorite.enabled ? null : (
          <Badge variant="secondary" data-testid={`favorite-disabled-${favorite.id}`}>
            disabled
          </Badge>
        )}
      </span>
      <FavoriteColumnMeta favorite={favorite} website={website} />
    </span>
  );

  const actionsCell = (
    <div className="flex shrink-0 items-center gap-2">
      <label className="favorite-autodownload flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="size-4 accent-(--primary)"
          checked={favorite.autoDownload}
          disabled={pending}
          data-testid={`autodownload-${label}`}
          aria-label={`Auto-download new chapters for ${label}`}
          title="auto-download"
          onChange={(event): void => {
            update.mutate({ id: favorite.id, autoDownload: event.target.checked });
          }}
        />
        <span className="hidden 2xl:inline">auto-download</span>
      </label>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="favorite-check h-7"
        disabled={pending}
        aria-label={`Check ${label} for new chapters now`}
        onClick={(): void => props.onCheckNow(favorite)}
      >
        <RefreshCw aria-hidden="true" />
        <span className="hidden 2xl:inline">Check now</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="favorite-delete h-7 text-destructive hover:bg-destructive/10"
        disabled={pending}
        aria-label={`Remove favorite ${label}`}
        onClick={(): void => props.onOpenDialogs({ remove: favorite })}
      >
        <Trash2 aria-hidden="true" />
        <span className="hidden 2xl:inline">Remove</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="favorite-menu h-7 w-8 p-0"
            aria-label={`Actions for ${label}`}
            data-testid={`favorite-menu-${favorite.id}`}
          >
            <MoreVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid={`favorite-menu-content-${favorite.id}`}>
          <DropdownMenuItem
            data-testid={`favorite-menu-view-info-${favorite.id}`}
            onSelect={(): void => {
              globalThis.location.hash = `#/manga?module=${encodeURIComponent(favorite.moduleId)}&url=${encodeURIComponent(favorite.url)}`;
            }}
          >
            View manga info
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`favorite-menu-download-new-${favorite.id}`}
            disabled={pending}
            onSelect={(): void => props.onDownloadAllNew(favorite)}
          >
            Download all new
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`favorite-menu-rename-${favorite.id}`}
            onSelect={(): void => props.onStartRename(favorite.id)}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`favorite-menu-transfer-${favorite.id}`}
            onSelect={(): void => props.onOpenDialogs({ transfer: favorite })}
          >
            Transfer website
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`favorite-menu-saveto-${favorite.id}`}
            onSelect={(): void => props.onOpenDialogs({ saveTo: favorite })}
          >
            Change save-to
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`favorite-menu-toggle-${favorite.id}`}
            disabled={pending}
            onSelect={(): void => {
              update.mutate({ id: favorite.id, enabled: !favorite.enabled });
            }}
          >
            {favorite.enabled ? 'Disable' : 'Enable'}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            data-testid={`favorite-menu-delete-${favorite.id}`}
            onSelect={(): void => props.onOpenDialogs({ remove: favorite })}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <FavoriteGridRow
      favorite={favorite}
      website={website}
      titleCell={titleCell}
      actionsCell={actionsCell}
    />
  );
}

export function FavoritesPage(): ReactElement {
  const favorites = useFavorites();
  const modules = useModules();
  const queryClient = useQueryClient();
  const batch = useFavoritesCheckBatch();
  const cancelBatch = useCancelFavoritesCheck();
  const checkNow = useCheckFavoriteNow();
  const createDownload = useCreateDownloadJob();
  const [sheetRows, setSheetRows] = useState<NewChapterRow[] | null>(null);
  const [renamingId, setRenamingId] = useState('');
  const [dialogs, setDialogs] = useState<RowDialogsState>({
    saveTo: null,
    transfer: null,
    remove: null,
  });
  const [importOpen, setImportOpen] = useState(false);

  const moduleNames = useMemo((): Map<string, string> => {
    const map = new Map<string, string>();
    for (const module of modules.data?.modules ?? []) {
      map.set(module.id, module.name);
    }
    return map;
  }, [modules.data]);
  const enabledModules: readonly ModuleSummaryT[] = useMemo(
    (): readonly ModuleSummaryT[] => (modules.data?.modules ?? []).filter((m): boolean => m.enabled),
    [modules.data],
  );

  const refreshFavorites = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['favorites'] });
  };

  /** Enqueue one favorite's new chapters (Download or Add-to-queue). */
  const enqueue = (
    favoriteId: string,
    moduleId: string,
    mangaUrl: string,
    title: string | null,
    saveTo: string | null,
    chapters: ReadonlyArray<{ link: string; name: string }>,
    paused: boolean,
  ): void => {
    for (const chapter of chapters) {
      createDownload.mutate({
        moduleId,
        mangaUrl,
        chapterLink: chapter.link,
        ...(title !== null ? { mangaTitle: title } : {}),
        ...(chapter.name !== '' ? { chapterName: chapter.name } : {}),
        ...(saveTo !== null && saveTo !== '' ? { saveTo } : {}),
        idempotencyKey: `fav:${favoriteId}:${chapter.link}`,
        ...(paused ? { paused: true } : {}),
      });
    }
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
  };

  const runCheckNow = (favorite: FavoriteT): void => {
    checkNow.mutate(favorite.id, {
      onSuccess: (result): void => {
        refreshFavorites();
        if (result.newChapters.length > 0 || result.favorite.newChapterCount > 0) {
          const sheet = toSheetRows([
            {
              favorite: result.favorite,
              status: 'checked',
              newChapters: result.newChapters,
              queuedDownloads: result.queuedDownloads,
            },
          ]);
          setSheetRows(sheet.length > 0 ? sheet : null);
        }
      },
    });
  };

  /** Row menu: check now, then immediately download what the check found. */
  const downloadAllNew = (favorite: FavoriteT): void => {
    checkNow.mutate(favorite.id, {
      onSuccess: (result): void => {
        refreshFavorites();
        if (result.queuedDownloads === 0 && result.newChapters.length > 0) {
          enqueue(
            result.favorite.id,
            result.favorite.moduleId,
            result.favorite.url,
            result.favorite.title,
            result.favorite.saveTo,
            result.newChapters,
            false,
          );
        }
      },
    });
  };

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

  const body = rows.length === 0
    ? (
        <EmptyState title="No favorites yet">
          <p>
            Add favorites from a manga page or import a list — the
            favorites engine checks them on schedule (bounded concurrency,
            per-favorite interval + jitter) and badges the new chapters it
            finds.
          </p>
        </EmptyState>
      )
    : (
        <ListPanel
          className="favorite-list rounded-lg border"
          ariaLabel="Favorites"
          items={rows}
          itemKey={(favorite): string => favorite.id}
          rowClassName="favorite-row"
          renderItem={(favorite): ReactElement => (
            <FavoriteListRow
              index={rows.indexOf(favorite)}
              favorite={favorite}
              website={moduleNames.get(favorite.moduleId) ?? favorite.moduleId}
              renaming={renamingId === favorite.id}
              onStartRename={setRenamingId}
              onCheckNow={runCheckNow}
              onDownloadAllNew={downloadAllNew}
              onOpenDialogs={(next): void =>
                setDialogs((current): RowDialogsState => ({ ...current, ...next }))
              }
              pending={checkNow.isPending}
            />
          )}
        />
      );

  return (
    <section aria-label="Favorites">
      <PageHeader title="Favorites" description="Tracked titles with new-chapter checks on schedule." />
      <div className="favorites-toolbar mb-4 flex flex-wrap items-center gap-2" data-testid="favorites-toolbar">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                className="favorite-check-all h-8"
                disabled={batch.isPending}
                data-testid="check-all-button"
              >
                <RefreshCw aria-hidden="true" />
                {batch.isPending ? 'Checking…' : 'Check for new chapters'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" data-testid="check-scope-menu">
              <DropdownMenuItem data-testid="check-scope-all" onSelect={(): void => {
                batch.mutate('all', { onSuccess: (result): void => {
                  refreshFavorites();
                  const sheet = toSheetRows(result.results);
                  setSheetRows(sheet.length > 0 ? sheet : null);
                } });
              }}>
                All favorites
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="check-scope-enabled" onSelect={(): void => {
                batch.mutate('enabled', { onSuccess: (result): void => {
                  refreshFavorites();
                  const sheet = toSheetRows(result.results);
                  setSheetRows(sheet.length > 0 ? sheet : null);
                } });
              }}>
                Enabled only
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="check-scope-disabled" onSelect={(): void => {
                batch.mutate('disabled', { onSuccess: (result): void => {
                  refreshFavorites();
                  const sheet = toSheetRows(result.results);
                  setSheetRows(sheet.length > 0 ? sheet : null);
                } });
              }}>
                Disabled only
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {batch.isPending ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              data-testid="cancel-check-button"
              onClick={(): void => cancelBatch.mutate()}
            >
              Stop check
            </Button>
          ) : null}
          {batch.isError ? <ErrorBanner error={batch.error} /> : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="favorite-import h-8"
            data-testid="import-list-button"
            onClick={(): void => setImportOpen(true)}
          >
            Import list
          </Button>
      </div>
      {rows.length > 0 ? <FavoriteColumnHeader /> : null}
      {body}

      <NewChaptersSheet
        open={sheetRows !== null}
        onClose={(): void => setSheetRows(null)}
        rows={sheetRows ?? []}
        onDownload={(row): void => {
          const favorite = rows.find((f): boolean => f.id === row.favoriteId) ?? null;
          enqueue(
            row.favoriteId,
            favorite?.moduleId ?? '',
            favorite?.url ?? '',
            row.title,
            favorite?.saveTo ?? null,
            row.newChapters,
            false,
          );
          refreshFavorites();
        }}
        onQueue={(row): void => {
          const favorite = rows.find((f): boolean => f.id === row.favoriteId) ?? null;
          enqueue(
            row.favoriteId,
            favorite?.moduleId ?? '',
            favorite?.url ?? '',
            row.title,
            favorite?.saveTo ?? null,
            row.newChapters,
            true,
          );
          refreshFavorites();
        }}
      />

      <SaveToDialog
        open={dialogs.saveTo !== null}
        favorite={dialogs.saveTo}
        onClose={(): void => setDialogs((c): RowDialogsState => ({ ...c, saveTo: null }))}
      />
      <TransferDialog
        open={dialogs.transfer !== null}
        favorite={dialogs.transfer}
        modules={enabledModules}
        onClose={(): void => setDialogs((c): RowDialogsState => ({ ...c, transfer: null }))}
        onTransferred={refreshFavorites}
      />
      <DeleteFavoriteDialog
        favorite={dialogs.remove}
        onClose={(): void => setDialogs((c): RowDialogsState => ({ ...c, remove: null }))}
      />
      <ImportFavoritesDialog
        open={importOpen}
        onClose={(): void => setImportOpen(false)}
        modules={modules.data?.modules ?? []}
        onImported={refreshFavorites}
      />
    </section>
  );
}
