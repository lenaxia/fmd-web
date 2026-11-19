/**
 * Library (§7.1 + file-state story): the finalized chapter artifacts —
 * newest-first listing with cursor pagination, stat-verified state
 * badges, copy-path actions, and the Library-level filter chips
 * (All / Missing / Orphans — URL-as-truth via ?filter=). 'Rescan
 * library' (toolbar) reconciles the ledger against disk and surfaces
 * the persisted diff report (re-links, missing, orphans).
 *
 * Design-system retrofit: PageHeader + ListPanel + EntryRow rows;
 * the `.library-row` hook (with `data-file-id`) lives on the inner
 * FileRow ONLY — the ListPanel wrapper carries no row class (double-
 * stamping made text locators strict-violate: nested duplicates).
 *
 * R1 ruling: download links are the consumption boundary — no reader,
 * no zip-of-directory, no orphan-file bytes (deferred by design).
 */
import { useState, type ReactElement } from 'react';
import { Download, MoreHorizontal, RefreshCw, ScanSearch, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  useDeleteLibraryFile,
  useLastRescan,
  useLibrary,
  useRescanLibrary,
  type LibraryFileT,
  type LibraryFilterT,
  type LibraryOrphanFileT,
  type RescanReportT,
} from '../api/hooks';
import { useRoute } from '../state/use-route';
import { navigate, replaceRoute, type Route } from '../router';
import { formatBytes } from '../components/library/format';
import { FileStateBadge } from '../components/library/FileStateBadge';
import { formatVerifiedAge } from '../components/library/FilesSection';
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
import { cn } from 'cn';
import { formatFavoriteDate } from '../components/favorites/FavoritesColumns';

const LIBRARY_ROUTE: Route = { name: 'library', query: {} };

/** URL-as-truth: ?filter= is the ONE source of truth for the chips. */
function parseFilter(raw: string | undefined): LibraryFilterT {
  return raw === 'missing' || raw === 'orphans' ? raw : 'all';
}

function CopyPathAction(props: { path: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="library-copy-path h-7 max-md:min-h-touch-target"
      aria-label={`Copy path ${props.path}`}
      data-testid="library-copy-path"
      onClick={(): void => {
        void globalThis.navigator.clipboard
          .writeText(props.path)
          .then((): void => {
            setCopied(true);
            toast.success('Path copied');
            setTimeout((): void => {
              setCopied(false);
            }, 1500);
          })
          .catch((): void => {
            toast.error('Clipboard unavailable — copy it manually');
          });
      }}
    >
      {copied ? 'Copied' : 'Copy path'}
    </Button>
  );
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
            {file.path !== undefined ? (
              <span className="ml-2 text-muted-foreground/70" title={file.path}>
                {file.path}
              </span>
            ) : null}
          </span>
        </span>
      }
      badges={
        file.state !== undefined ? (
          <span
            title={
              file.verifiedAt !== null && file.verifiedAt !== undefined
                ? `Verified ${formatVerifiedAge(file.verifiedAt)}`
                : undefined
            }
          >
            <FileStateBadge state={file.state} />
          </span>
        ) : null
      }
      trailing={
        <span className="flex items-center gap-1">
          {file.absolutePath !== undefined ? <CopyPathAction path={file.absolutePath} /> : null}
          <Button type="button" variant="outline" size="sm" className="library-download h-7" asChild>
            <a href={`/api/library/${file.id}/file`} download>
              <Download aria-hidden="true" />
              <span className="max-md:sr-only">Download</span>
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

function OrphanRow(props: { orphan: LibraryOrphanFileT }): ReactElement {
  return (
    <EntryRow
      data={{ 'data-orphan-path': props.orphan.path }}
      className="library-row library-row-orphan"
      title={
        <span className="library-title" title={props.orphan.path}>
          {props.orphan.path}
        </span>
      }
      meta={
        <span className="library-meta">
          {formatBytes(props.orphan.bytes)} · {formatFavoriteDate(props.orphan.mtime)}
        </span>
      }
      badges={<FileStateBadge state="orphan" />}
      trailing={<CopyPathAction path={props.orphan.absolutePath} />}
    />
  );
}

/** The persisted rescan diff report — counts + moved-file re-links. */
function RescanReportView(props: { report: RescanReportT }): ReactElement {
  const { counts } = props.report;
  return (
    <div className="rescan-report mb-4 rounded-lg border bg-surface p-3 text-sm" data-testid="rescan-report" role="status">
      <p className="font-medium">
        Last rescan{' '}
        <span className="font-normal text-muted-foreground">
          ({formatFavoriteDate(props.report.finishedAt)})
        </span>
      </p>
      <p className="mt-1 text-muted-foreground" data-testid="rescan-counts">
        {String(counts.present)} present
        {counts.relinked > 0 ? `, ${String(counts.relinked)} re-linked` : ''}
        {counts.missing > 0 ? `, ${String(counts.missing)} missing` : ''}
        {counts.orphans > 0 ? `, ${String(counts.orphans)} orphans` : ''}
        {counts.outsideRoot > 0 ? `, ${String(counts.outsideRoot)} outside root (skipped)` : ''}.
      </p>
      {props.report.relinked.length > 0 ? (
        <ul className="rescan-relinks mt-2 space-y-1 text-xs text-muted-foreground">
          {props.report.relinked.map((relink): ReactElement => (
            <li key={relink.id} data-testid="rescan-relink">
              Re-linked <span className="font-mono">{relink.toPath}</span>
              <span className="ml-1">(was {relink.fromPath})</span>
            </li>
          ))}
        </ul>
      ) : null}
      {props.report.missing.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {String(props.report.missing.length)} missing file{props.report.missing.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {props.report.missing.map((missing): ReactElement => (
              <li key={missing.id} data-testid="rescan-missing">
                <span className="font-mono">{missing.path ?? missing.fileName}</span>
                {missing.candidates.length > 0 ? (
                  <span className="ml-1">
                    (ambiguous — {String(missing.candidates.length)} same-name candidates; resolve by
                    deleting the ledger entry or ignoring the orphan)
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

const FILTERS: readonly { readonly key: LibraryFilterT; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'missing', label: 'Missing' },
  { key: 'orphans', label: 'Orphans' },
];

export function LibraryPage(): ReactElement {
  // URL-synced filter (hash query ?filter=): parse on every hash
  // mutation, serialize back via replaceRoute on every chip edit.
  const route: Route = useRoute(LIBRARY_ROUTE);
  const filter = parseFilter(route.query['filter']);
  const setFilter = (next: LibraryFilterT): void => {
    if (next === 'all') {
      navigate('library');
      return;
    }
    replaceRoute('library', { filter: next });
  };

  const library = useLibrary(filter);
  const rows = library.data?.pages.flatMap((page) => [...page.files]) ?? [];
  const orphans = filter === 'orphans' ? (library.data?.pages.at(-1)?.orphans ?? []) : [];
  const rescan = useRescanLibrary();
  const lastRescan = useLastRescan();
  // The just-run rescan's report shows IMMEDIATELY (the operator asked
  // for it); the persisted lastRescan serves the filtered deep-link view.
  const [lastReport, setLastReport] = useState<RescanReportT | undefined>(undefined);

  return (
    <section aria-label="Library">
      <PageHeader title="Library" description="Packed chapter archives, newest first." />
      {library.isError ? <ErrorBanner error={library.error} /> : null}
      {library.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading library…</p> : null}

      <div className="library-toolbar mb-3 flex flex-wrap items-center gap-2">
        <div className="library-filter-chips flex flex-wrap items-center gap-2" role="group" aria-label="Library filter">
          {FILTERS.map((chip): ReactElement => (
            <button
              key={chip.key}
              type="button"
              data-testid={`library-filter-${chip.key}`}
              data-active={filter === chip.key ? 'true' : undefined}
              aria-pressed={filter === chip.key}
              onClick={(): void => {
                setFilter(chip.key);
              }}
              className={cn(
                'library-chip max-md:min-h-touch-target max-md:min-w-touch-target rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filter === chip.key ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="library-rescan max-md:min-h-touch-target"
          data-testid="library-rescan"
          disabled={rescan.isPending}
          onClick={(): void => {
            rescan.mutate(undefined, {
              onSuccess: (report): void => {
                setLastReport(report);
                const moved = report.counts.relinked;
                toast.success(
                  report.counts.missing > 0 || report.counts.orphans > 0
                    ? `Rescan: ${String(report.counts.relinked)} re-linked, ${String(report.counts.missing)} missing, ${String(report.counts.orphans)} orphans`
                    : moved > 0
                      ? `Rescan: ${String(moved)} moved file${moved === 1 ? '' : 's'} re-linked`
                      : 'Rescan complete — library clean',
                );
              },
            });
          }}
        >
          <ScanSearch aria-hidden="true" />
          {rescan.isPending ? 'Rescanning…' : 'Rescan library'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="library-refresh max-md:min-h-touch-target"
          aria-label="Refresh library"
          onClick={(): void => {
            void library.refetch();
          }}
          disabled={library.isFetching}
        >
          <RefreshCw aria-hidden="true" />
          <span className="max-md:sr-only">Refresh</span>
        </Button>
      </div>

      {rescan.isError ? <ErrorBanner error={rescan.error} /> : null}

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

      {filter === 'orphans' && !library.isPending && orphans.length > 0 ? (
        <>
          <h3 className="mt-4 mb-2 text-sm font-medium text-muted-foreground">
            Orphans — files under the downloads root no ledger row claims
          </h3>
          <ListPanel
            className="library-orphan-list"
            ariaLabel="Orphan files"
            items={orphans}
            itemKey={(orphan): string => orphan.path}
            renderItem={(orphan): ReactElement => <OrphanRow orphan={orphan} />}
          />
        </>
      ) : null}

      {lastReport !== undefined ? (
        <RescanReportView report={lastReport} />
      ) : filter !== 'all' && lastRescan.data != null ? (
        <RescanReportView report={lastRescan.data} />
      ) : null}

      {!library.isPending && rows.length === 0 && !library.isError ? (
        filter === 'orphans' && orphans.length === 0 ? (
          <EmptyState title="No orphans recorded">
            <p>
              Orphan detection runs at <strong>Rescan library</strong>
              {lastRescan.data == null ? ' (none has run yet)' : ''} — files on disk that no
              library row claims appear here.
            </p>
          </EmptyState>
        ) : filter === 'missing' ? (
          <EmptyState title="Nothing missing">
            <p>Every tracked file was stat-verified at its recorded path.</p>
          </EmptyState>
        ) : (
          <EmptyState title="No chapters downloaded yet">
            <p>Finished downloads land here as packed archives (Browse → pick a title → Enqueue).</p>
            <p>
              The <a className="underline underline-offset-4 max-md:inline-flex max-md:min-h-touch-target max-md:items-center" href="docs/USER-GUIDE.md#library">library guide</a> explains formats and retrieving files.
            </p>
          </EmptyState>
        )
      ) : null}
    </section>
  );
}
