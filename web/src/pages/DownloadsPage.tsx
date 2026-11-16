/**
 * Downloads (§7.1): job list with cursor pagination + live progress
 * over `WS /ws` with reconnect/backfill (D19). The WS feed patches
 * the React Query caches; a `resync` hint invalidates them.
 *
 * Design-system retrofit: FilterBar + NativeSelect (native semantics
 * are pinned by e2e) + ListPanel (virtualized above the threshold).
 * Status badges ride the semantic job-state tokens; the `.job-list` /
 * `.job-row` / `.badge` / `.job-progress` hooks and every status text
 * are unchanged — visual-only.
 */
import { useState, type ReactElement } from 'react';
import { useCancelJob, useJobsList, type JobStateT, type JobT } from '../api/hooks';
import { useJobsFeed } from '../state/use-jobs-feed';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { FilterBar } from '@/components/patterns/FilterBar';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { StatPill } from '@/components/patterns/StatPill';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from 'cn';

const STATES: readonly (JobStateT | '')[] = ['', 'queued', 'running', 'retry', 'done', 'failed', 'cancelled'];

const CANCELLABLE: readonly JobStateT[] = ['queued', 'running', 'retry'];

/** Job-state → token utilities (semantic state colors, both themes). */
const STATE_CLASSES: Record<JobStateT, string> = {
  queued: 'bg-state-queued text-state-queued-foreground',
  running: 'bg-state-running text-state-running-foreground',
  retry: 'bg-state-retry text-state-retry-foreground',
  done: 'bg-state-done text-state-done-foreground',
  failed: 'bg-state-failed text-state-failed-foreground',
  cancelled: 'bg-state-cancelled text-state-cancelled-foreground',
};

function StatusBadge(props: { state: JobStateT }): ReactElement {
  return (
    <Badge variant="secondary" className={cn('badge', `job-${props.state}`, STATE_CLASSES[props.state])}>
      {props.state}
    </Badge>
  );
}

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
        {props.resyncCount > 0 ? ' · resynced after missed-event window (D19)' : ''}
      </StatPill>
    </p>
  );
}

function JobRow(props: { job: JobT; onCancel: (jobId: string) => void; cancelPending: boolean }): ReactElement {
  const job = props.job;
  const cancellable = CANCELLABLE.includes(job.state);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm">
      <StatusBadge state={job.state} />
      <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{job.id.slice(0, 8)}</code>
      <span className="job-title min-w-0 flex-1 truncate font-medium">
        {job.payload['mangaTitle'] !== undefined ? String(job.payload['mangaTitle']) : job.moduleId}
        {job.payload['chapterName'] !== undefined ? ` — ${String(job.payload['chapterName'])}` : ''}
      </span>
      {job.progress !== undefined ? (
        <span className="job-progress font-mono text-xs text-muted-foreground"> {JSON.stringify(job.progress)}</span>
      ) : null}
      {job.error !== undefined ? (
        <span className="job-error text-xs text-destructive"> error: {job.error}</span>
      ) : null}
      {cancellable ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="job-cancel ml-1 h-7"
          aria-label={`Cancel job ${job.id}`}
          disabled={props.cancelPending}
          onClick={(): void => {
            props.onCancel(job.id);
          }}
        >
          {props.cancelPending ? 'Cancelling…' : 'Cancel'}
        </Button>
      ) : null}
    </div>
  );
}

export function DownloadsPage(): ReactElement {
  const [state, setState] = useState<JobStateT | ''>('');
  const jobs = useJobsList(state);
  const feed = useJobsFeed({ enabled: true });
  const cancelJob = useCancelJob();

  const rows = jobs.data?.pages.flatMap((page): JobT[] => [...page.jobs]) ?? [];

  return (
    <section aria-label="Downloads">
      <PageHeader
        title="Downloads"
        description="Job queue with live progress over the event stream."
      />

      <WsStatusLine status={feed.status} reconnectAttempt={feed.reconnectAttempt} resyncCount={feed.resyncCount} />

      <FilterBar ariaLabel="Job filters">
        <div className="flex items-center gap-2">
          <label htmlFor="job-state-filter" className="text-sm font-medium">
            Filter by state
          </label>
          <NativeSelect
            id="job-state-filter"
            className="w-40"
            value={state}
            onChange={(e): void => {
              setState(e.target.value as JobStateT | '');
            }}
          >
            {STATES.map((s): ReactElement => (
              <option key={s} value={s}>
                {s === '' ? 'all states' : s}
              </option>
            ))}
          </NativeSelect>
        </div>
      </FilterBar>

      {jobs.isError ? <ErrorBanner error={jobs.error} /> : null}
      {cancelJob.isError ? <ErrorBanner error={cancelJob.error} /> : null}
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
                cancelPending={cancelJob.isPending}
                onCancel={(jobId): void => {
                  void cancelJob.mutateAsync(jobId);
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
            Nothing queued {state !== '' ? `in state “${state}”` : 'yet'}. Enqueue chapters from a
            manga page (Browse → pick a title → select chapters → Enqueue).
          </p>
        </EmptyState>
      ) : null}
    </section>
  );
}
