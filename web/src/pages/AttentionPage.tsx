/**
 * Attention (D1 §2 TRIAGE — the one attention surface,
 * tsk-granite-crown-orders): ONE screen answering "what needs me".
 * Failed downloads arrive GROUPED BY CAUSE — site dead (the
 * [site-availability] record join), anti-bot / bypass-unavailable,
 * rate-limited, other — never per-chapter noise. Each group carries a
 * paced retry-all (per-host pacing applies server-side exactly as to
 * fresh work: the re-enqueued rows re-enter the download lane, never
 * a burst), the dead-site group cross-links into the Settings
 * registry availability column, and availability NEVER gates an
 * action: an unreachable record dims its rows and explains itself
 * while every retry stays clickable (D1 §3 "hints never block").
 *
 * The healthy state is explicit and celebrates doing nothing — the
 * pipe-with-an-inbox identity's whole point (§1: the happy path is
 * hands-off; the UI exists for exceptions and oversight only).
 */
import type { ReactElement } from 'react';
import { CircleAlert, Coffee, Gauge, LibraryBig, RotateCw, ShieldAlert, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { AvailabilityChip, formatCheckedAgo as formatAgo } from '../components/AvailabilityChip';
import { PageHeader } from '../components/patterns/PageHeader';
import { Button } from '@/components/ui/button';
import { cn } from 'cn';
import { useTriage, useTriageRetry, type TriageCauseT, type TriageSnapshotT } from '../api/hooks';
import { routeToHash } from '../router';

/** The Settings Websites section anchor — the availability column home. */
const REGISTRY_LINK: string = routeToHash('settings', { section: 'websites' });

/** Per-cause presentation (fixed order mirrors the server's TRIAGE_CAUSES). */
const CAUSE_SHAPES: Readonly<Record<TriageCauseT, {
  readonly label: string;
  readonly icon: ReactElement;
  readonly blurb: string;
  /** The dead-site explanation: dim + explain, never block (D1 §3). */
  readonly hint: string;
}>> = {
  site_dead: {
    label: 'Site down',
    icon: <WifiOff aria-hidden="true" />,
    blurb: 'The site-availability record says unreachable — the pipe already observed origin trouble.',
    hint:
      'Recorded unreachable at the last check. The record dims this group and explains it — it never blocks a retry you explicitly make.',
  },
  antibot: {
    label: 'Anti-bot',
    icon: <ShieldAlert aria-hidden="true" />,
    blurb: 'The site is blocking automated access (anti-bot page, bypass unavailable).',
    hint: 'The origin is alive but challenging traffic — spacing retries per host is the honest pace.',
  },
  throttled: {
    label: 'Rate limited',
    icon: <Gauge aria-hidden="true" />,
    blurb: 'The site is throttling requests (HTTP 429).',
    hint: 'Retries re-enter the pipe paced per host — one request per site per interval, never a burst.',
  },
  other: {
    label: 'Other failures',
    icon: <CircleAlert aria-hidden="true" />,
    blurb: 'Everything else — engine, packing and unclassified network faults.',
    hint: 'Worth a look when the named groups are quiet.',
  },
};

/** One failed chapter row (aggregated attention row, not a queue row). */
function FailureJobRow(props: { readonly jobId: string; readonly row: TriageSnapshotT['groups'][number]['sites'][number]['jobs'][number]; readonly dimmed: boolean }): ReactElement {
  const title = props.row.mangaTitle ?? 'Unknown title';
  const chapter = props.row.chapterName ?? props.row.id;
  return (
    <li
      className={cn('flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-sm', props.dimmed && 'opacity-60')}
      data-testid={`attention-job-${props.jobId}`}
    >
      <span className="min-w-0 truncate font-medium">{title}</span>
      <span className="text-muted-foreground">·</span>
      <span className="min-w-0 truncate text-muted-foreground">{chapter}</span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={props.row.error ?? undefined}>
        {props.row.error === null ? formatAgo(props.row.updatedAt) : `${props.row.error.slice(0, 120)} · ${formatAgo(props.row.updatedAt)}`}
      </span>
    </li>
  );
}

/** One cause group: header (count + paced retry-all) + per-site buckets. */
function CauseGroup(props: { readonly group: TriageSnapshotT['groups'][number] }): ReactElement {
  const retry = useTriageRetry();
  const shape = CAUSE_SHAPES[props.group.cause];
  const dimmed = props.group.cause === 'site_dead';
  const onRetryAll = (): void => {
    retry.mutate({ cause: props.group.cause }, {
      onSuccess: (result): void => {
        toast.success(
          result.affected === 0
            ? 'Nothing to retry — the group is already clear.'
            : `Retry-all queued ${String(result.affected)} ${result.affected === 1 ? 'chapter' : 'chapters'} — the pipe paces them per host.`,
        );
      },
      onError: (error): void => {
        toast.error(`Retry-all failed: ${error.message}`);
      },
    });
  };
  return (
    <section
      className="rounded-lg border border-border bg-surface p-4 sm:p-5"
      aria-labelledby={`attention-heading-${props.group.cause}`}
      data-testid={`attention-group-${props.group.cause}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground" aria-hidden="true">{shape.icon}</span>
        <h3 id={`attention-heading-${props.group.cause}`} className="text-base font-semibold">
          {shape.label}
        </h3>
        <span className="rounded-full bg-surface-hover px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {String(props.group.count)} {props.group.count === 1 ? 'chapter' : 'chapters'}
        </span>
        {/* The paced retry-all: enabled ALWAYS — availability dims and
         * explains elsewhere on the card, it never disables this. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto max-md:min-h-touch-target"
          disabled={retry.isPending}
          onClick={onRetryAll}
          data-testid={`attention-retry-${props.group.cause}`}
        >
          <RotateCw aria-hidden="true" className={retry.isPending ? 'animate-spin' : undefined} />
          Retry all
        </Button>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{shape.blurb}</p>
      {dimmed ? <p className="mt-1 text-xs text-muted-foreground">{shape.hint}</p> : null}
      {props.group.sites.map((site): ReactElement => (
        <div
          key={site.moduleId}
          className={cn('mt-3 rounded-md border border-border/60 p-3', dimmed && 'opacity-80')}
          data-testid={`attention-site-${site.moduleId}`}
        >
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <span className="min-w-0 truncate text-sm font-medium">{site.siteName ?? site.moduleId}</span>
            <AvailabilityChip availability={site.availability} />
            {/* The dead-site cross-link: the registry availability
             * column is one tap away (Settings → Websites, deep-linked). */}
            <a
              href={REGISTRY_LINK}
              className="ml-auto text-xs font-medium text-(--primary) underline-offset-2 hover:underline"
              data-testid={`attention-registry-link-${site.moduleId}`}
            >
              Availability in the registry
            </a>
          </div>
          <ul className="mt-1.5 list-none p-0">
            {site.jobs.map((row): ReactElement => (
              <FailureJobRow key={row.id} jobId={row.id} row={row} dimmed={dimmed} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The healthy state: explicit, and it celebrates doing nothing (§1). */
function HealthyEmpty(): ReactElement {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface px-6 py-14 text-center"
      data-testid="attention-empty"
    >
      <span className="text-muted-foreground" aria-hidden="true">
        <Coffee className="size-10" />
      </span>
      <h3 className="text-lg font-semibold">Nothing needs you.</h3>
      <p className="max-w-md text-sm text-muted-foreground">
        Every download the pipe attempted is accounted for — nothing failed, nothing is waiting on a
        decision. The scheduler keeps running with no screen open; go enjoy the backlog instead of
        watching it.
      </p>
      <a
        href={routeToHash('library')}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
      >
        <LibraryBig aria-hidden="true" className="size-4" />
        Browse the library
      </a>
    </div>
  );
}

export function AttentionPage(): ReactElement {
  const triage = useTriage();

  return (
    <>
      <PageHeader
        title="Attention"
        description="What needs you — failed downloads grouped by cause, each group with a paced retry-all."
      />
      {triage.isPending ? (
        <p className="text-sm text-muted-foreground" data-testid="attention-loading">Checking the pipe…</p>
      ) : triage.isError ? (
        <div
          className="rounded-lg border border-border bg-surface p-5 text-sm text-muted-foreground"
          data-testid="attention-error"
        >
          <p>The attention snapshot could not be loaded ({triage.error.message}).</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={(): void => { void triage.refetch(); }}>
            Try again
          </Button>
        </div>
      ) : triage.data !== undefined && triage.data.failedTotal === 0 ? (
        <HealthyEmpty />
      ) : (
        <div className="flex flex-col gap-4">
          {triage.data?.groups
            .filter((group): boolean => group.count > 0)
            .map((group): ReactElement => (
              <CauseGroup key={group.cause} group={group} />
            ))}
        </div>
      )}
    </>
  );
}
