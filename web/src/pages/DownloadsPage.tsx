/**
 * Downloads (§7.1 + downloads parity, tsk-retro-fountain-tasks): the
 * FMD2 tsDownload tab, web-adapted — toolbar (Resume all / Pause all /
 * Delete completed + search), state-chip + date-window filters
 * (URL-synced), and rows with a REAL progress bar (images done/total
 * from the WS payload), FMD2-palette status badges, transfer rate and
 * the full pmDownload action set. Live progress rides `WS /ws` with
 * reconnect/backfill (D19); the WS feed patches the React Query caches.
 *
 * Intentionally-different from FMD2 (docs/UX-PARITY.md): no drag/Del/
 * Ctrl-arrow reordering — queue priority is server-ordered; the
 * stable-ordered cursor pagination below never shifts rows under
 * inserts. One job = one chapter stays.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useDeleteJob,
  useJobAction,
  useJobBulkAction,
  useJobsList,
  type JobT,
} from '../api/hooks';
import { useJobsActivity } from '../state/jobs-activity';
import {
  dateWindowToRange,
  downloadsFiltersToQuery,
  parseDownloadsFilters,
} from '../state/downloads-filter-state';
import { navigateToManga, replaceRoute, type Route } from '../router';
import { useRoute } from '../state/use-route';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
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
import { JobFilters } from '@/components/downloads/JobFilters';
import { JobRow } from '@/components/downloads/JobRow';
import { JobsToolbar } from '@/components/downloads/JobsToolbar';

const DOWNLOADS_ROUTE: Route = { name: 'downloads', query: {} };

function WsStatusLine(props: {
  status: 'idle' | 'connecting' | 'open' | 'backfilling' | 'reconnecting';
  reconnectAttempt: number;
  resyncCount: number;
}): ReactElement {
  const label =
    props.status === 'open'
      ? 'Live'
      : props.status === 'backfilling'
        ? 'Backfilling missed events…'
        : props.status === 'reconnecting'
          ? `Reconnecting (attempt ${props.reconnectAttempt + 1})…`
          : props.status === 'connecting'
            ? 'Connecting…'
            : 'Offline';
  return (
    <p className="ws-status mb-4 text-sm text-muted-foreground" aria-live="polite">
      <StatPill className="mb-0">
        Event stream: <strong className="font-semibold text-foreground">{label}</strong>
        {props.resyncCount > 0 ? ' · resynced after missed-event window' : ''}
      </StatPill>
    </p>
  );
}

interface DeleteTarget {
  readonly job: JobT;
  readonly data: boolean;
}

export function DownloadsPage(): ReactElement {
  // URL-synced filters (hash query): parse on every hash mutation,
  // serialize back via replaceRoute on every edit.
  const route: Route = useRoute(DOWNLOADS_ROUTE);
  const filters = useMemo((): ReturnType<typeof parseDownloadsFilters> => {
    return parseDownloadsFilters(route.query);
  }, [route.query]);
  const setFilters = (next: ReturnType<typeof parseDownloadsFilters>): void => {
    replaceRoute('downloads', downloadsFiltersToQuery(next));
  };

  // Search commits to the URL debounced (typing replaces state per key).
  const [qDraft, setQDraft] = useState(filters.q);
  useEffect((): void => {
    setQDraft(filters.q);
  }, [filters.q]);
  useEffect((): () => void => {
    const timer = setTimeout((): void => {
      if (qDraft !== filters.q) {
        setFilters({ ...filters, q: qDraft });
      }
    }, 300);
    return (): void => {
      clearTimeout(timer);
    };
    // Deps are deliberate: qDraft + filters.q only (filters.q is the commit
    // marker; a stale filters object would re-fire the debounce).
  }, [qDraft, filters.q]);

  const range = useMemo((): ReturnType<typeof dateWindowToRange> => {
    return dateWindowToRange(filters);
  }, [filters]);
  const jobs = useJobsList({
    states: filters.states,
    q: filters.q,
    ...range,
  });
  // R5 arrival: the /ws connection is app-level (JobsActivityProvider)
  // — one socket serves the nav badge AND this page's live rows.
  const { feed } = useJobsActivity();

  const queryClient = useQueryClient();
  const invalidateJobs = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
  };
  const action = useJobAction();
  const removeJob = useDeleteJob();
  const bulk = useJobBulkAction();

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const rows = jobs.data?.pages.flatMap((page): JobT[] => [...page.jobs]) ?? [];
  const hasCompleted = rows.some((job): boolean => job.state === 'done');
  // [UX-AUDIT D-3] the bulk-delete confirm names the exact row count.
  const completedCount = rows.filter((job): boolean => job.state === 'done').length;

  const onAction = (jobId: string, type: Parameters<typeof action.mutate>[0]['type']): void => {
    void action
      .mutateAsync({ jobId, type })
      .catch((): void => undefined)
      .finally(invalidateJobs);
  };
  const onBulk = (bulkAction: 'pause' | 'resume' | 'delete'): void => {
    void bulk
      .mutateAsync({ action: bulkAction, scope: bulkAction === 'delete' ? 'completed' : 'all' })
      .catch((): void => undefined)
      .finally(invalidateJobs);
  };

  return (
    <section aria-label="Downloads">
      <PageHeader
        title="Downloads"
        description="Job queue with live progress over the event stream."
      />

      <WsStatusLine status={feed.status} reconnectAttempt={feed.reconnectAttempt} resyncCount={feed.resyncCount} />

      <JobsToolbar
        q={qDraft}
        onQ={setQDraft}
        onBulk={onBulk}
        bulkPending={bulk.isPending}
        hasCompleted={hasCompleted}
        completedCount={completedCount}
        confirmOpen={confirmBulkDelete}
        onConfirmOpen={setConfirmBulkDelete}
      />

      <JobFilters filters={filters} onChange={setFilters} />

      {jobs.isError ? <ErrorBanner error={jobs.error} /> : null}
      {action.isError ? <ErrorBanner error={action.error} /> : null}
      {removeJob.isError ? <ErrorBanner error={removeJob.error} /> : null}
      {bulk.isError ? <ErrorBanner error={bulk.error} /> : null}
      {jobs.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading jobs…</p> : null}

      {rows.length > 0 ? (
        <>
          <ListPanel
            className="job-list"
            ariaLabel="Download jobs"
            items={rows}
            itemKey={(job): string => job.id}
            rowClassName="job-row"
            liProps={(job): { className: string; 'data-job-id': string } => ({
              className: 'job-row',
              'data-job-id': job.id,
            })}
            renderItem={(job): ReactElement => (
              <JobRow
                job={job}
                actionPending={action.isPending}
                deletePending={removeJob.isPending}
                onAction={onAction}
                onDelete={(target, data): void => {
                  setDeleteTarget({ job: target, data });
                }}
                onViewInfo={(target): void => {
                  const payload = target.payload as Record<string, unknown>;
                  const module = typeof payload['moduleId'] === 'string' ? payload['moduleId'] : target.moduleId;
                  const url = typeof payload['mangaUrl'] === 'string' ? payload['mangaUrl'] : '';
                  const title = typeof payload['mangaTitle'] === 'string' ? payload['mangaTitle'] : '';
                  navigateToManga({ module, url, title });
                }}
              />
            )}
          />
          {jobs.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={(): void => {
                jobs.fetchNextPage();
              }}
              disabled={jobs.isFetchingNextPage}
            >
              {jobs.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </>
      ) : null}

      {!jobs.isPending && rows.length === 0 && !jobs.isError ? (
        <EmptyState title="No download jobs">
          <p>
            Nothing{filters.states.length > 0 ? ` in state “${filters.states.join(', ')}”` : ''} matches the
            current filters. Enqueue chapters from a manga page (Browse → pick a title → select
            chapters → Enqueue).
          </p>
          <p>
            The <a className="underline underline-offset-4 max-md:inline-flex max-md:min-h-touch-target max-md:items-center" href="docs/USER-GUIDE.md#downloading">downloading guide</a> covers progress, pause/resume/retry and where files land.
          </p>
        </EmptyState>
      ) : null}

      <Dialog open={deleteTarget !== null} onOpenChange={(next): void => { if (!next) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm" data-testid="delete-job-dialog">
          <DialogHeader>
            <DialogTitle>{deleteTarget?.data === true ? 'Delete job + downloaded file?' : 'Delete job?'}</DialogTitle>
            <DialogDescription>
              {deleteTarget === null
                ? ''
                : deleteTarget.data
                  ? 'The job row AND its finalized library file are removed. This cannot be undone.'
                  : 'The job row is removed; the downloaded file stays in the library (delete + file is the other choice).'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={(): void => { setDeleteTarget(null); }}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="delete-job-confirm"
              disabled={deleteTarget === null || removeJob.isPending}
              onClick={(): void => {
                if (deleteTarget === null) {
                  return;
                }
                const target = deleteTarget;
                setDeleteTarget(null);
                void removeJob
                  .mutateAsync({
                    jobId: target.job.id,
                    ...(target.data === true ? { data: true } : {}),
                  })
                  .catch((): void => undefined)
                  .finally(invalidateJobs);
              }}
            >
              {removeJob.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
