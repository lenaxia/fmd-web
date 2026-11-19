/**
 * Favorites (§7.2 + favorites-parity): the full FMD2 favorites-tab
 * surface — the column listing (Title primary + Website / Current
 * chapter / Save to / Last checked / Last updated on one shared
 * header/row grid, responsive secondary line on narrow), the toolbar
 * batch check with scopes (All / Enabled / Disabled) + cancel + the
 * list import, every per-row action behind the single kebab column
 * (Check now / Auto-download / Download all new / Rename / Transfer
 * website / Change save-to / Enable-Disable / View info / Delete with
 * confirm) and the NewChaptersSheet decision UI after every check
 * with results.
 *
 * Design-system retrofit: PageHeader + ListPanel + EntryRow rows with
 * token-styled controls; testids, aria-labels and texts stable.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, MoreVertical, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { coverSrc } from '../api/cover';
import { CoverImage } from '@/components/manga/CoverImage';
import {
  useCancelFavoritesCheck,
  useCheckFavoriteMissing,
  useCheckFavoriteNow,
  useCreateDownloadJob,
  useFavorites,
  useFavoritesCheckBatch,
  useModules,
  useUpdateFavorite,
  type FavoriteCheckBatchItemT,
  type FavoriteCheckScopeT,
  type FavoriteMissingChapterT,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  readonly favorite: FavoriteT;
  readonly website: string;
  readonly renaming: boolean;
  readonly onStartRename: (id: string) => void;
  readonly onCheckNow: (favorite: FavoriteT) => void;
  readonly onDownloadAllNew: (favorite: FavoriteT) => void;
  readonly onCheckMissing: (favorite: FavoriteT) => void;
  readonly onOpenDialogs: (state: Partial<RowDialogsState>) => void;
  readonly pending: boolean;
}): ReactElement {
  const { favorite, website } = props;
  const update = useUpdateFavorite();
  const [renameDraft, setRenameDraft] = useState(favorite.title ?? favorite.url);

  const label = favorite.title ?? favorite.url;
  const pending = props.pending || update.isPending;

  // Title = the flexible primary column: the truncating title (the
  // title attr carries the full text on overflow) + the status/new/
  // disabled badges, with the compact meta line underneath.
  const titleCell = props.renaming ? (
    <span className="flex min-w-0 flex-col gap-1 md:col-span-full">
      <span className="flex w-full flex-wrap items-center gap-2">
        <input
          className="favorite-rename-input h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
          aria-label={`Rename favorite ${label}`}
          data-testid={`favorite-rename-input-${favorite.id}`}
          value={renameDraft}
          autoFocus
          disabled={update.isPending}
          onChange={(event): void => setRenameDraft(event.target.value)}
          onKeyDown={(event): void => {
            if (event.key === 'Enter' && renameDraft.trim() !== '' && !update.isPending) {
              update.mutate(
                { id: favorite.id, title: renameDraft.trim() },
                { onSuccess: (): void => props.onStartRename('') },
              );
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              props.onStartRename('');
            }
          }}
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
    <span className="flex min-w-0 flex-1 items-center gap-x-3">
      {/* Covers live-defect: the row cover rides the same-origin proxy
       * off the coverLink the last check persisted (null before the
       * first check — the No-cover placeholder stands, R5 web-native
       * license: FMD2's favorites list is cover-less, the grid is
       * ours to improve). */}
      <CoverImage
        src={coverSrc(favorite.moduleId, favorite.coverLink ?? undefined) ?? ''}
        alt={`${label} cover`}
        className="size-12 shrink-0 rounded-md"
        testId={`favorite-cover-${favorite.id}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="favorite-title min-w-0 truncate text-sm font-medium" title={label}>
          {label}
        </span>
        <NewChapterBadge count={favorite.newChapterCount} />
        {favorite.status !== null && favorite.status !== '' ? (
          <Badge variant="outline" className="favorite-status">{favorite.status}</Badge>
        ) : null}
        {favorite.enabled ? null : (
          <Badge variant="secondary" data-testid={`favorite-disabled-${favorite.id}`}>
            disabled
          </Badge>
        )}
      </span>
      <FavoriteColumnMeta favorite={favorite} website={website} />
      </span>
    </span>
  );

  // ONE narrow right-aligned icon column: every row action (check now,
  // auto-download, download all new, rename, transfer, save-to,
  // enable/disable, view info, delete) lives behind the single kebab.
  const actionsCell = props.renaming ? null : (
    <div className="favorite-actions flex shrink-0 items-center justify-end md:justify-self-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="favorite-menu h-8 w-8 p-0 max-md:min-h-touch-target max-md:min-w-touch-target"
            aria-label={`Actions for ${label}`}
            data-testid={`favorite-menu-${favorite.id}`}
          >
            <MoreVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid={`favorite-menu-content-${favorite.id}`}>
          <DropdownMenuItem
            data-testid={`favorite-menu-check-${favorite.id}`}
            disabled={pending}
            aria-label={`Check ${label} for new chapters now`}
            onSelect={(): void => props.onCheckNow(favorite)}
          >
            <RefreshCw aria-hidden="true" />
            Check now
          </DropdownMenuItem>
          <DropdownMenuCheckboxItem
            data-testid={`favorite-menu-autodownload-${favorite.id}`}
            checked={favorite.autoDownload}
            disabled={pending}
            aria-label={`Auto-download new chapters for ${label}`}
            onSelect={(event): void => event.preventDefault()}
            onCheckedChange={(checked): void => {
              update.mutate({ id: favorite.id, autoDownload: checked === true });
            }}
          >
            Auto-download new chapters
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem
            data-testid={`favorite-menu-download-new-${favorite.id}`}
            disabled={pending}
            onSelect={(): void => props.onDownloadAllNew(favorite)}
          >
            Download all new
          </DropdownMenuItem>
          {/* [pipe-health] FCheckMissing parity, web-adapted: the manual
           * missing-chapter check — report-only, surfaced per favorite. */}
          <DropdownMenuItem
            data-testid={`favorite-menu-check-missing-${favorite.id}`}
            disabled={pending}
            aria-label={`Check ${label} for missing chapters`}
            onSelect={(): void => props.onCheckMissing(favorite)}
          >
            Check missing chapters
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid={`favorite-menu-view-info-${favorite.id}`}
            onSelect={(): void => {
              globalThis.location.hash = `#/manga?module=${encodeURIComponent(favorite.moduleId)}&url=${encodeURIComponent(favorite.url)}`;
            }}
          >
            View manga info
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            data-testid={`favorite-menu-delete-${favorite.id}`}
            aria-label={`Remove favorite ${label}`}
            onSelect={(): void => props.onOpenDialogs({ remove: favorite })}
          >
            <Trash2 aria-hidden="true" />
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
  const checkMissing = useCheckFavoriteMissing();
  const createDownload = useCreateDownloadJob();
  const [sheetRows, setSheetRows] = useState<NewChapterRow[] | null>(null);
  const [renamingId, setRenamingId] = useState('');
  /** [pipe-health] the per-favorite missing-chapter report (report-only). */
  const [missingReport, setMissingReport] = useState<{
    favorite: FavoriteT;
    chapters: readonly FavoriteMissingChapterT[];
  } | null>(null);
  // [UX-AUDIT F-6] the true split-button's default scope — the action
  // half runs THIS; the caret half's menu items re-set it.
  const [checkScope, setCheckScope] = useState<FavoriteCheckScopeT>('all');
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

  /** Shared batch-check wiring — the split-button's action half and
   * every scope-menu item land here (F-5's error toast included). */
  const runBatchCheck = (scope: FavoriteCheckScopeT): void => {
    batch.mutate(scope, {
      onSuccess: (result): void => {
        refreshFavorites();
        const sheet = toSheetRows(result.results);
        setSheetRows(sheet.length > 0 ? sheet : null);
      },
      onError: (): void => {
        toast.error('Checking favorites for new chapters failed; try again in a moment.');
      },
    });
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
      onError: (): void => {
        toast.error(`Checking ${favorite.title ?? favorite.url} for new chapters failed; try again in a moment.`);
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
      onError: (): void => {
        toast.error(`Checking ${favorite.title ?? favorite.url} for new chapters failed; try again in a moment.`);
      },
    });
  };

  /**
   * [pipe-health] The manual missing-chapter check (FCheckMissing
   * parity, web-adapted): fetches the live list and reports the
   * chapters REMOVED from the site since they were recorded — the
   * report dialog is the ENTIRE effect (nothing is deleted, the
   * downloaded list is never rewritten).
   */
  const runCheckMissing = (favorite: FavoriteT): void => {
    checkMissing.mutate(favorite.id, {
      onSuccess: (result): void => {
        refreshFavorites();
        setMissingReport({ favorite: result.favorite, chapters: result.missingChapters });
      },
      onError: (): void => {
        toast.error(`Checking ${favorite.title ?? favorite.url} for missing chapters failed; try again in a moment.`);
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
            Add favorites from a manga page or import a list; the
            favorites engine checks them on schedule (bounded concurrency,
            per-favorite interval + jitter) and badges the new chapters it
            finds.
          </p>
          <p>
            The <a className="underline underline-offset-4 max-md:inline-flex max-md:min-h-touch-target max-md:items-center" href="docs/USER-GUIDE.md#favorites-lifecycle">favorites lifecycle guide</a> walks through checks, the new-chapters sheet, transfers and imports.
          </p>
        </EmptyState>
      )
    : (
        <ListPanel
          className="favorite-list rounded-lg border"
          ariaLabel="Favorites"
          items={rows}
          itemKey={(favorite): string => favorite.id}
          rowClassName="favorite-row px-3"
          header={<FavoriteColumnHeader />}
          renderItem={(favorite): ReactElement => (
            <FavoriteListRow
              favorite={favorite}
              website={moduleNames.get(favorite.moduleId) ?? favorite.moduleId}
              renaming={renamingId === favorite.id}
              onStartRename={setRenamingId}
              onCheckNow={runCheckNow}
              onDownloadAllNew={downloadAllNew}
              onCheckMissing={runCheckMissing}
              onOpenDialogs={(next): void =>
                setDialogs((current): RowDialogsState => ({ ...current, ...next }))
              }
              pending={checkNow.isPending || checkMissing.isPending}
            />
          )}
        />
      );

  return (
    <section aria-label="Favorites">
      <PageHeader title="Favorites" description="Tracked titles with new-chapter checks on schedule." />
      <div className="favorites-toolbar mb-4 flex flex-wrap items-center gap-2" data-testid="favorites-toolbar">
          {/* [UX-AUDIT F-6] TRUE split-button: the label half RUNS the
           * default (last-chosen) scope; the caret half opens the scope
           * menu (each pick re-sets the default and runs). The old
           * single trigger looked like an action but only opened the
           * menu — a disguised split-button. */}
          <div className="flex items-stretch" role="group" aria-label="Check favorites for new chapters">
            <Button
              type="button"
              size="sm"
              className="favorite-check-all h-8 rounded-r-none pr-3"
              disabled={batch.isPending}
              aria-label={`Check ${checkScope === 'all' ? 'all favorites' : `${checkScope} favorites`} for new chapters`}
              data-testid="check-all-button"
              onClick={(): void => {
                runBatchCheck(checkScope);
              }}
            >
              <RefreshCw aria-hidden="true" />
              {batch.isPending ? 'Checking…' : 'Check for new chapters'}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-l-none border-l-0 px-2"
                  aria-label="Choose check scope"
                  aria-haspopup="menu"
                  disabled={batch.isPending}
                  data-testid="check-scope-trigger"
                >
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" data-testid="check-scope-menu">
                <DropdownMenuItem data-testid="check-scope-all" onSelect={(): void => {
                  setCheckScope('all');
                  runBatchCheck('all');
                }}>
                  All favorites
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="check-scope-enabled" onSelect={(): void => {
                  setCheckScope('enabled');
                  runBatchCheck('enabled');
                }}>
                  Enabled only
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="check-scope-disabled" onSelect={(): void => {
                  setCheckScope('disabled');
                  runBatchCheck('disabled');
                }}>
                  Disabled only
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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

      {/* [pipe-health] The missing-chapter report (FCheckMissing parity,
       * web-adapted): report-only — the dialog lists what the site
       * removed; nothing in the app acts on it. */}
      <Dialog
        open={missingReport !== null}
        onOpenChange={(open): void => {
          if (!open) {
            setMissingReport(null);
          }
        }}
      >
        <DialogContent
          className="max-h-[80vh] sm:max-w-lg"
          data-testid="missing-chapters-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              Missing chapters — {missingReport?.favorite.title ?? missingReport?.favorite.url}
            </DialogTitle>
            <DialogDescription>
              Chapters the site’s list no longer contains (removed since they were
              recorded). Reported for your awareness only — nothing was deleted and
              the downloaded list is unchanged.
            </DialogDescription>
          </DialogHeader>
          {missingReport !== null && missingReport.chapters.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground" data-testid="missing-chapters-empty">
              No missing chapters — every recorded chapter is still on the site’s list.
            </p>
          ) : null}
          {missingReport !== null && missingReport.chapters.length > 0 ? (
            <ul
              aria-label="Missing chapter links"
              className="max-h-60 space-y-1 overflow-y-auto text-sm"
              data-testid="missing-chapters-list"
            >
              {missingReport.chapters.map((chapter): ReactElement => (
                <li key={chapter.link} className="break-all text-muted-foreground">
                  {chapter.link}
                </li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="missing-chapters-close"
              onClick={(): void => setMissingReport(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
