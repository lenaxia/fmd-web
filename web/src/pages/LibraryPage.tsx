/**
 * Library (§7.1): the finalized chapter artifacts — newest-first
 * listing with cursor pagination and a download link per entry (the
 * file streams from `GET /api/library/:id/file`).
 *
 * Design-system retrofit: PageHeader + ListPanel + EntryRow rows;
 * the `.library-row` hook (with `data-file-id`) lives on the inner FileRow ONLY — the ListPanel wrapper carries no row class (double-stamping made text locators strict-violate: nested duplicates).
 */
import type { ReactElement } from 'react';
import { Download } from 'lucide-react';
import { useLibrary, type LibraryFileT } from '../api/hooks';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { EntryRow } from '@/components/patterns/EntryRow';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatPill } from '@/components/patterns/StatPill';
import { Button } from '@/components/ui/button';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function FileRow(props: { file: LibraryFileT }): ReactElement {
  const file = props.file;
  return (
    <EntryRow
      data={{ 'data-file-id': file.id }}
      className="library-row"
      title={<span className="library-title">{file.manga}</span>}
      meta={
        <span className="library-meta">
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{file.fileName}</code>{' '}
          {formatBytes(file.bytes)} · {new Date(file.createdAt).toISOString()}
        </span>
      }
      trailing={
        <Button type="button" variant="outline" size="sm" className="library-download h-7" asChild>
          <a href={`/api/library/${file.id}/file`} download>
            <Download aria-hidden="true" />
            Download
          </a>
        </Button>
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
