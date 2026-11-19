/**
 * FilesSection (file-state story): the per-title file listing on the
 * manga detail page — the web window onto server storage. Every
 * tracked chapter file with its verified state (badges), human size,
 * UTC date, copy-path action; orphans under the title's directory;
 * lazy verification (stale >15 min re-verified server-side on open)
 * with the verification age visible; explicit refresh + the per-title
 * 'Rescan' variant (moved-file re-linking, missing/orphan report).
 *
 * R1 ruling honored: this is a METADATA listing only — no file bytes,
 * no reader. R3: every action is a visible button (copy-path,
 * refresh, rescan) with touch-target sizing on mobile.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { Check, Copy, RefreshCw, ScanSearch } from 'lucide-react';
import { toast } from 'sonner';
import { useRescanLibrary, useTitleFiles, type RescanReportT, type TitleFileEntryT } from '../../api/hooks';
import { formatFavoriteDate } from '../favorites/FavoritesColumns';
import { formatBytes } from './format';
import { FileStateBadge } from './FileStateBadge';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { ListPanel } from '@/components/patterns/ListPanel';
import { EntryRow } from '@/components/patterns/EntryRow';
import { Button } from '@/components/ui/button';

/** Human verification age (the staleness window is 15 min). */
export function formatVerifiedAge(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  return `${String(Math.floor(hours / 24))} d ago`;
}

function CopyPathButton(props: { path: string; testId?: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="copy-path h-7 max-md:min-h-touch-target max-md:min-w-touch-target"
      aria-label={`Copy path ${props.path}`}
      data-testid={props.testId}
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
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span className="max-md:sr-only">{copied ? 'Copied' : 'Copy path'}</span>
    </Button>
  );
}

function FileRow(props: { entry: TitleFileEntryT; label: string }): ReactElement {
  const entry = props.entry;
  return (
    <EntryRow
      data={{ 'data-file-id': entry.id }}
      className="files-row"
      title={
        <span className="files-title truncate" title={entry.fileName ?? entry.chapterLink ?? undefined}>
          {props.label}
        </span>
      }
      meta={
        <span className="files-meta">
          {/* L-1/L-3 discipline: human size + shared UTC date formatter,
           * muted filename — never the raw machine shapes. */}
          {entry.bytes !== undefined ? formatBytes(entry.bytes) : '—'}
          {entry.mtime !== undefined ? ` · ${formatFavoriteDate(entry.mtime)}` : ''}
          {entry.fileName !== undefined ? <span className="ml-2 text-muted-foreground/70">{entry.fileName}</span> : null}
          {entry.path !== undefined ? <span className="ml-2 text-muted-foreground/70" title={entry.path}>{entry.path}</span> : null}
        </span>
      }
      badges={
        entry.verifiedAt !== undefined ? (
          <span title={`Verified ${formatVerifiedAge(entry.verifiedAt)}`}>
            <FileStateBadge state={entry.state} />
          </span>
        ) : (
          <FileStateBadge state={entry.state} />
        )
      }
      trailing={
        <span className="flex items-center gap-1">
          {entry.absolutePath !== undefined ? <CopyPathButton path={entry.absolutePath} /> : null}
        </span>
      }
    />
  );
}

function OrphanRow(props: { orphan: { path: string; absolutePath: string; bytes: number; mtime: string } }): ReactElement {
  const orphan = props.orphan;
  return (
    <EntryRow
      className="files-row files-row-orphan"
      title={
        <span className="files-title truncate" title={orphan.path}>
          {orphan.path}
        </span>
      }
      meta={
        <span className="files-meta">
          {formatBytes(orphan.bytes)} · {formatFavoriteDate(orphan.mtime)}
        </span>
      }
      badges={<FileStateBadge state="orphan" />}
      trailing={<CopyPathButton path={orphan.absolutePath} />}
    />
  );
}

/** The last rescan outcome, one summary line (moved re-links surface here). */
function RescanSummary(props: { report: RescanReportT }): ReactElement {
  const { counts } = props.report;
  return (
    <p role="status" className="rescan-summary mb-2 text-xs text-muted-foreground" data-testid="title-rescan-summary">
      Rescan: {String(counts.present)} present
      {counts.relinked > 0 ? `, ${String(counts.relinked)} re-linked` : ''}
      {counts.missing > 0 ? `, ${String(counts.missing)} missing` : ''}
      {counts.orphans > 0 ? `, ${String(counts.orphans)} orphans` : ''}.
    </p>
  );
}

export function FilesSection(props: {
  moduleId: string;
  url: string;
  mangaTitle: string;
  /** chapterLink → label (the live chapter list already on the page). */
  chapterLabels: ReadonlyMap<string, string>;
}): ReactElement {
  const [refreshed, setRefreshed] = useState(false);
  const files = useTitleFiles(props.moduleId, props.url, {
    manga: props.mangaTitle,
    ...(refreshed ? { refresh: true } : {}),
  });
  const rescan = useRescanLibrary();
  const [lastReport, setLastReport] = useState<RescanReportT | undefined>(undefined);

  const labelFor = (entry: TitleFileEntryT): string => {
    if (entry.chapterLink !== undefined) {
      const label = props.chapterLabels.get(entry.chapterLink);
      if (label !== undefined) {
        return label;
      }
    }
    return entry.fileName ?? 'Tracked file';
  };

  const rows = useMemo((): readonly TitleFileEntryT[] => files.data?.files ?? [], [files.data]);

  return (
    <section aria-label="Files" className="files-section mt-6" data-testid="files-section">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">Files</h3>
        {files.data !== undefined ? (
          <span className="text-xs text-muted-foreground" data-testid="files-verified-age">
            Verified {formatVerifiedAge(files.data.verifiedAt)}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="files-refresh h-7 max-md:min-h-touch-target"
          data-testid="files-refresh"
          disabled={files.isFetching}
          onClick={(): void => {
            setRefreshed(true);
            files.refetch();
          }}
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="files-rescan h-7 max-md:min-h-touch-target"
          data-testid="files-rescan"
          disabled={rescan.isPending}
          onClick={(): void => {
            rescan.mutate(
              { moduleId: props.moduleId, url: props.url, manga: props.mangaTitle },
              {
                onSuccess: (report): void => {
                  setLastReport(report);
                  const moved = report.counts.relinked;
                  toast.success(
                    moved > 0
                      ? `Rescan: ${String(moved)} moved file${moved === 1 ? '' : 's'} re-linked`
                      : 'Rescan complete',
                  );
                },
              },
            );
          }}
        >
          <ScanSearch aria-hidden="true" />
          {rescan.isPending ? 'Rescanning…' : 'Rescan'}
        </Button>
      </div>

      {files.isError ? <ErrorBanner error={files.error} /> : null}
      {rescan.isError ? <ErrorBanner error={rescan.error} /> : null}
      {lastReport !== undefined ? <RescanSummary report={lastReport} /> : null}
      {files.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Verifying files…
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ListPanel
          className="files-list rounded-lg border"
          ariaLabel="Title files"
          items={rows}
          itemKey={(entry): string => entry.id ?? entry.chapterLink ?? entry.fileName ?? Math.random().toString(36)}
          renderItem={(entry): ReactElement => <FileRow entry={entry} label={labelFor(entry)} />}
        />
      ) : null}
      {(files.data?.orphans ?? []).length > 0 ? (
        <>
          <h4 className="mt-4 mb-2 text-sm font-medium text-muted-foreground">Orphans in this title's directory</h4>
          <ListPanel
            className="files-orphan-list rounded-lg border"
            ariaLabel="Orphan files"
            items={files.data?.orphans ?? []}
            itemKey={(orphan): string => orphan.path}
            renderItem={(orphan): ReactElement => <OrphanRow orphan={orphan} />}
          />
        </>
      ) : null}

      {!files.isPending && rows.length === 0 && (files.data?.orphans ?? []).length === 0 && !files.isError ? (
        <EmptyState title="No tracked files">
          <p>Downloaded chapters land here with their server paths, sizes and verification state.</p>
        </EmptyState>
      ) : null}
    </section>
  );
}
