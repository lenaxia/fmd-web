/**
 * Library (§7.1): the finalized chapter artifacts — newest-first
 * listing with cursor pagination and a download link per entry (the
 * file streams from `GET /api/library/:id/file`).
 *
 * Design-system retrofit: PageHeader + ListPanel + EntryRow rows;
 * the `.library-row` hook (with `data-file-id`) lives on the inner FileRow ONLY — the ListPanel wrapper carries no row class (double-stamping made text locators strict-violate: nested duplicates).
 */
import { useState, type ReactElement } from 'react';
import { Download, MoreHorizontal, Trash2 } from 'lucide-react';
import { useDeleteLibraryFile, useLibrary, type LibraryFileT } from '../api/hooks';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { EntryRow } from '@/components/patterns/EntryRow';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatPill } from '@/components/patterns/StatPill';
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatFavoriteDate } from '../components/favorites/FavoritesColumns';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function FileRow(props: { file: LibraryFileT }): ReactElement {
  const file = props.file;
  // [UX-AUDIT L-2] file management from the row: delete-with-confirm
  // (previously reachable only through a still-present Downloads job).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useDeleteLibraryFile();
  return (
    <EntryRow
      data={{ 'data-file-id': file.id }}
      className="library-row"
      title={<span className="library-title">{file.manga}</span>}
      meta={
        <span className="library-meta">
          {/* [UX-AUDIT L-3] the filename lost its code-chip styling —
           * muted trailing text, no longer scan noise before size/date
           * (the full name still rides the title tooltip). */}
          {/* Human-readable UTC timestamp (UX audit L-1): the shared
           * Favorites formatter ('YYYY-MM-DD HH:MM'), never the raw
           * toISOString machine format. Pinned by
           * web/test/library-page.test.tsx. */}
          <span title={file.fileName}>
            {formatBytes(file.bytes)} · {formatFavoriteDate(file.createdAt)}
            <span className="ml-2 text-muted-foreground/70">{file.fileName}</span>
          </span>
        </span>
      }
      trailing={
        <span className="flex items-center gap-1">
          <Button type="button" variant="outline" size="sm" className="library-download h-7" asChild>
            <a href={`/api/library/${file.id}/file`} download>
              <Download aria-hidden="true" />
              Download
            </a>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="library-menu h-7 w-7 max-md:min-h-touch-target max-md:min-w-touch-target"
                aria-label={`File actions for ${file.fileName}`}
                disabled={remove.isPending}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid={`library-menu-${file.id}`}>
              <DropdownMenuItem
                variant="destructive"
                data-testid={`library-delete-file-${file.id}`}
                disabled={remove.isPending}
                onSelect={(): void => {
                  setConfirmOpen(true);
                }}
              >
                <Trash2 aria-hidden="true" />
                Delete file…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogContent className="max-w-sm" data-testid={`library-delete-dialog-${file.id}`}>
              <DialogHeader>
                <DialogTitle>Delete this file?</DialogTitle>
                <DialogDescription>
                  <span className="font-mono text-xs">{file.fileName}</span> is removed from disk
                  and the library. Downloaded chapters stay marked; redownload from the manga page
                  if you want it back.
                </DialogDescription>
              </DialogHeader>
              {remove.error !== null ? <ErrorBanner error={remove.error} /> : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={(): void => { setConfirmOpen(false); }}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid={`library-delete-confirm-${file.id}`}
                  disabled={remove.isPending}
                  onClick={(): void => {
                    remove.mutate(file.id, {
                      onSuccess: (): void => {
                        setConfirmOpen(false);
                      },
                    });
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  {remove.isPending ? 'Deleting…' : 'Delete file'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </span>
      }
    />
  );
}

export function LibraryPage(): ReactElement {
  const library = useLibrary();
  const rows = library.data?.pages.flatMap((page) => [...page.files]) ?? [];

  return (
    <section aria-label="Library">
      <PageHeader title="Library" description="Packed chapter archives, newest first." />
      {library.isError ? <ErrorBanner error={library.error} /> : null}
      {library.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading library…</p> : null}

      {rows.length > 0 ? (
        <>
          <p role="status" className="mb-2">
            <StatPill className="library-count">
              {rows.length} packed chapter{rows.length === 1 ? '' : 's'}
            </StatPill>
          </p>
          <ListPanel
            className="library-list"
            ariaLabel="Library files"
            items={rows}
            itemKey={(file): string => file.id}
            renderItem={(file): ReactElement => <FileRow file={file} />}
          />
          {library.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={(): void => {
                library.fetchNextPage();
              }}
              disabled={library.isFetchingNextPage}
            >
              {library.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </>
      ) : null}

      {!library.isPending && rows.length === 0 && !library.isError ? (
        <EmptyState title="No chapters downloaded yet">
          <p>Finished downloads land here as packed archives (Browse → pick a title → Enqueue).</p>
          <p>
            The <a className="underline underline-offset-4 max-md:inline-flex max-md:min-h-touch-target max-md:items-center" href="docs/USER-GUIDE.md#library">library guide</a> explains formats and retrieving files.
          </p>
        </EmptyState>
      ) : null}
    </section>
  );
}
