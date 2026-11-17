/**
 * JobRow (downloads parity, tsk-retro-fountain-tasks): one download
 * job as a row — FMD2-palette status badge, REAL progress bar
 * (images done/total from the WS progress payload), transfer rate
 * while downloading, and the pmDownload action set (Stop/Resume/
 * Redownload/Enable/Disable + delete with the data choice) behind a
 * primary control + kebab overflow. No raw JSON anywhere.
 */
import type { ReactElement } from 'react';
import { MoreHorizontal, Pause, Play } from 'lucide-react';
import type { JobActionTypeT, JobT } from '../../api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import {
  formatBytesPerSecond,
  jobProgressView,
  jobPercent,
  jobStatus,
  type JobStatus,
} from '../../state/job-status';
import { cn } from 'cn';

/** Token classes per status token (semantic state colors, both themes). */
const TOKEN_CLASSES: Record<JobStatus['token'], string> = {
  queued: 'bg-state-queued text-state-queued-foreground',
  running: 'bg-state-running text-state-running-foreground',
  retry: 'bg-state-retry text-state-retry-foreground',
  done: 'bg-state-done text-state-done-foreground',
  failed: 'bg-state-failed text-state-failed-foreground',
  cancelled: 'bg-state-cancelled text-state-cancelled-foreground',
};

/** Bar-fill color per status kind (FMD2 colors the embedded bar, pas:4516) — full literal classes so the Tailwind scanner sees them. */
const BAR_FILL: Record<JobStatus['kind'], string> = {
  waiting: '[&>[data-slot=progress-indicator]]:bg-state-queued',
  preparing: '[&>[data-slot=progress-indicator]]:bg-state-running',
  downloading: '[&>[data-slot=progress-indicator]]:bg-state-running',
  compressing: '[&>[data-slot=progress-indicator]]:bg-state-running',
  converting: '[&>[data-slot=progress-indicator]]:bg-state-running',
  finishing: '[&>[data-slot=progress-indicator]]:bg-state-done',
  finished: '[&>[data-slot=progress-indicator]]:bg-state-done',
  stopped: '[&>[data-slot=progress-indicator]]:bg-state-cancelled',
  problem: '[&>[data-slot=progress-indicator]]:bg-state-retry',
  failed: '[&>[data-slot=progress-indicator]]:bg-state-failed',
};

export function StatusBadge(props: { status: JobStatus; readonly className?: string }): ReactElement {
  return (
    <Badge
      variant="secondary"
      className={cn('badge max-md:order-2', `job-${props.status.kind}`, TOKEN_CLASSES[props.status.token], props.className)}
      data-status={props.status.kind}
    >
      {props.status.label}
    </Badge>
  );
}

/**
 * The pmDownload state matrix, client mirror (the SERVER enforces the
 * truth; this only gates menu affordances — every illegal hit still
 * surfaces the typed 409 envelope):
 *
 *   queued      → pause(resume-able hold) / disable / resume(-op) / enable(-op)
 *   queued+held → resume / enable (lift)
 *   running     → pause (cancel, markers persist)
 *   retry       → pause (cancel)
 *   done        → redownload
 *   failed      → retry
 *   cancelled   → resume (fresh attempt, markers resume)
 */
export function legalJobActions(job: JobT): readonly JobActionTypeT[] {
  if (job.state === 'queued') {
    return job.paused === true ? ['resume', 'enable'] : ['pause', 'disable', 'resume', 'enable'];
  }
  if (job.state === 'running' || job.state === 'retry') {
    return ['pause'];
  }
  if (job.state === 'done') {
    return ['redownload'];
  }
  if (job.state === 'failed') {
    return ['retry'];
  }
  return ['resume']; // cancelled
}

export function JobRow(props: {
  readonly job: JobT;
  readonly actionPending: boolean;
  readonly deletePending: boolean;
  readonly onAction: (jobId: string, type: JobActionTypeT) => void;
  readonly onDelete: (job: JobT, data: boolean) => void;
  readonly onViewInfo: (job: JobT) => void;
}): ReactElement {
  const { job } = props;
  const status = jobStatus(job);
  const progress = jobProgressView(job);
  const legal = legalJobActions(job);
  const percent = progress !== undefined ? jobPercent(progress) : 0;
  const hasArtifact = progress?.libraryPath !== undefined;
  const primary: JobActionTypeT | undefined =
    job.state === 'queued' && job.paused === true
      ? 'resume'
      : job.state === 'cancelled'
        ? 'resume'
        : job.state === 'failed'
          ? 'retry'
          : job.state === 'done'
            ? 'redownload'
            : job.state === 'queued' || job.state === 'running' || job.state === 'retry'
              ? 'pause'
              : undefined;

  return (
    // R3 responsive data row: >=md the flat wrapped line (badge · id ·
    // title · progress · error · actions — byte-identical to the
    // pre-mobile layout); <md it collapses to title + secondary-line
    // meta via order utilities (line 1: title + actions; line 2:
    // badge + progress + error) with the id chip hidden.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <StatusBadge status={status} />
      <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs max-md:hidden">{job.id.slice(0, 8)}</code>
      <span className="job-title min-w-0 flex-1 truncate font-medium max-md:order-1">
        {job.payload['mangaTitle'] !== undefined ? String(job.payload['mangaTitle']) : job.moduleId}
        {job.payload['chapterName'] !== undefined ? ` — ${String(job.payload['chapterName'])}` : ''}
      </span>

      {progress !== undefined && progress.total > 0 ? (
        <span
          className="job-progress flex w-40 shrink-0 flex-col gap-1 max-md:order-3 max-md:w-full"
          data-done={progress.done}
          data-total={progress.total}
        >
          <Progress
            value={percent}
            aria-label={`Progress ${String(percent)}%`}
            className={cn('job-progress-bar h-2', BAR_FILL[status.kind])}
          />
          <span className="flex items-center justify-between font-mono text-xs text-muted-foreground">
            <span data-testid="job-progress-count">
              {String(progress.done)}/{String(progress.total)}
            </span>
            {progress.rateBytesPerSecond !== undefined && status.kind === 'downloading' ? (
              <span data-testid="job-rate">{formatBytesPerSecond(progress.rateBytesPerSecond)}</span>
            ) : null}
          </span>
        </span>
      ) : null}

      {job.error !== undefined ? (
        <span className="job-error max-w-60 truncate text-xs text-destructive max-md:order-4 max-md:max-w-full" title={job.error}>
          error: {job.error}
        </span>
      ) : null}

      {primary !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="job-primary h-7 max-md:order-1"
          aria-label={`${primary === 'pause' ? 'Pause' : primary === 'resume' ? 'Resume' : primary === 'retry' ? 'Retry' : 'Redownload'} job ${job.id}`}
          disabled={props.actionPending}
          onClick={(): void => {
            props.onAction(job.id, primary);
          }}
        >
          {primary === 'pause' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {props.actionPending ? '…' : primary === 'pause' ? 'Pause' : primary === 'resume' ? 'Resume' : primary === 'retry' ? 'Retry' : 'Redownload'}
        </Button>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="job-menu h-7 w-7 max-md:order-1"
            aria-label={`Actions for job ${job.id}`}
            disabled={props.deletePending}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid={`job-menu-${job.id}`}>
          {(['pause', 'resume', 'retry', 'redownload', 'enable', 'disable'] as const)
            .filter((type): boolean => legal.includes(type) && type !== primary)
            .map((type): ReactElement => (
              <DropdownMenuItem
                key={type}
                data-testid={`job-action-${type}`}
                onSelect={(): void => {
                  props.onAction(job.id, type);
                }}
              >
                {type === 'pause'
                  ? 'Pause (resume-able)'
                  : type === 'resume'
                    ? 'Resume'
                    : type === 'retry'
                      ? 'Retry'
                      : type === 'redownload'
                        ? 'Redownload'
                        : type === 'enable'
                          ? 'Enable'
                          : 'Disable'}
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="job-action-view-info"
            onSelect={(): void => {
              props.onViewInfo(job);
            }}
          >
            View info
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            data-testid="job-action-delete"
            disabled={props.deletePending}
            onSelect={(): void => {
              props.onDelete(job, false);
            }}
          >
            Delete job
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            data-testid="job-action-delete-data"
            disabled={props.deletePending || !hasArtifact}
            onSelect={(): void => {
              props.onDelete(job, true);
            }}
          >
            Delete job + downloaded file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
