/**
 * Downloads (§7.1): job list with cursor pagination + live progress
 * over `WS /ws` with reconnect/backfill (D19). The WS feed patches
 * the React Query caches; a `resync` hint invalidates them.
 */
import { useState, type ReactElement } from 'react';
import { useCancelJob, useJobsList, type JobStateT, type JobT } from '../api/hooks';
import { useJobsFeed } from '../state/use-jobs-feed';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';

const STATES: readonly (JobStateT | '')[] = ['', 'queued', 'running', 'retry', 'done', 'failed', 'cancelled'];

const CANCELLABLE: readonly JobStateT[] = ['queued', 'running', 'retry'];

function StatusBadge(props: { state: JobStateT }): ReactElement {
  return <span className={`badge job-${props.state}`}>{props.state}</span>;
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
    <p className="ws-status" aria-live="polite">
      Event stream: <strong>{label}</strong>
      {props.resyncCount > 0 ? ' · resynced after missed-event window (D19)' : ''}
    </p>
  );
}

function JobRow(props: { job: JobT; onCancel: (jobId: string) => void; cancelPending: boolean }): ReactElement {
  const job = props.job;
  const cancellable = CANCELLABLE.includes(job.state);
  return (
    <li className="job-row" data-job-id={job.id}>
      <StatusBadge state={job.state} /> <code>{job.id.slice(0, 8)}</code>{' '}
      <span className="job-title">
        {job.payload['mangaTitle'] !== undefined ? String(job.payload['mangaTitle']) : job.moduleId}
        {job.payload['chapterName'] !== undefined ? ` — ${String(job.payload['chapterName'])}` : ''}
      </span>
      {job.progress !== undefined ? (
        <span className="job-progress"> {JSON.stringify(job.progress)}</span>
      ) : null}
      {job.error !== undefined ? <span className="job-error"> error: {job.error}</span> : null}
      {cancellable ? (
        <button
          type="button"
          className="job-cancel"
          aria-label={`Cancel job ${job.id}`}
          disabled={props.cancelPending}
          onClick={(): void => {
            props.onCancel(job.id);
          }}
        >
          {props.cancelPending ? 'Cancelling…' : 'Cancel'}
        </button>
      ) : null}
    </li>
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
      <WsStatusLine status={feed.status} reconnectAttempt={feed.reconnectAttempt} resyncCount={feed.resyncCount} />

      <div className="toolbar">
        <label htmlFor="job-state-filter">Filter by state</label>
        <select
          id="job-state-filter"
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
        </select>
      </div>

      {jobs.isError ? <ErrorBanner error={jobs.error} /> : null}
      {cancelJob.isError ? <ErrorBanner error={cancelJob.error} /> : null}
      {jobs.isPending ? <p role="status">Loading jobs…</p> : null}

      {rows.length > 0 ? (
        <>
          <ul className="job-list">
            {rows.map((job): ReactElement => (
              <JobRow
                key={job.id}
                job={job}
                cancelPending={cancelJob.isPending}
                onCancel={(jobId): void => {
                  void cancelJob.mutateAsync(jobId);
                }}
              />
            ))}
          </ul>
          {jobs.hasNextPage ? (
            <button
              type="button"
              onClick={(): void => {
                jobs.fetchNextPage();
              }}
              disabled={jobs.isFetchingNextPage}
            >
              {jobs.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
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
