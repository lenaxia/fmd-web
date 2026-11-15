/**
 * Library (§7.1): the finalized chapter artifacts — newest-first
 * listing with cursor pagination and a download link per entry (the
 * file streams from `GET /api/library/:id/file`).
 */
import type { ReactElement } from 'react';
import { useLibrary, type LibraryFileT } from '../api/hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function FileRow(props: { file: LibraryFileT }): ReactElement {
  const file = props.file;
  return (
    <li className="library-row" data-file-id={file.id}>
      <span className="library-title">{file.manga}</span> — <code>{file.fileName}</code>{' '}
      <span className="library-meta">
        {formatBytes(file.bytes)} · {new Date(file.createdAt).toISOString()}
      </span>{' '}
      <a className="library-download" href={`/api/library/${file.id}/file`} download>
        Download
      </a>
    </li>
  );
}

export function LibraryPage(): ReactElement {
  const library = useLibrary();
  const rows = library.data?.pages.flatMap((page) => [...page.files]) ?? [];

  return (
    <section aria-label="Library">
      <h2>Library</h2>
      {library.isError ? <ErrorBanner error={library.error} /> : null}
      {library.isPending ? <p role="status">Loading library…</p> : null}

      {rows.length > 0 ? (
        <>
          <p className="library-count" role="status">
            {rows.length} packed chapter{rows.length === 1 ? '' : 's'}
          </p>
          <ul className="library-list">
            {rows.map((file): ReactElement => <FileRow key={file.id} file={file} />)}
          </ul>
          {library.hasNextPage ? (
            <button
              type="button"
              onClick={(): void => {
                library.fetchNextPage();
              }}
              disabled={library.isFetchingNextPage}
            >
              {library.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </>
      ) : null}

      {!library.isPending && rows.length === 0 && !library.isError ? (
        <EmptyState title="No chapters downloaded yet">
          <p>Finished downloads land here as packed archives (Browse → pick a title → Enqueue).</p>
        </EmptyState>
      ) : null}
    </section>
  );
}
