/**
 * Inbox (D1 §2 INBOX — tsk-acidic-oxbow-waits): Home as a feed of
 * WHAT ARRIVED, not a favorites list. Reverse-chronological arrivals
 * the check engine detected, one row per chapter, each row
 * individually acknowledged; the shared "Caught up" bulk action
 * stamps everything visible. Seen state is server-side per chapter
 * (chapterKey), so caught-up-on-one-device is caught-up-everywhere —
 * the documented single-user posture (D1 §4/R2).
 *
 * URL-as-truth: the ?view= param IS the view ('new' default,
 * 'archive'); the tabs are plain links, so every view is shareable,
 * reloadable and back-navigable — no component state to drift.
 *
 * The archive serves acknowledged entries for a rolling 30 days (a
 * feed, not a ledger — the downloaded-truth ledger is the Library).
 * Webhook notifications (p2) complement this surface; they never gate
 * it — the inbox is the source of truth (D1 §1).
 */
import { useMemo, type ReactElement } from 'react';
import { Archive, Check, CheckCheck, Coffee } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '../components/patterns/PageHeader';
import { EmptyState } from '../components/patterns/EmptyState';
import { CoverImage } from '../components/manga/CoverImage';
import { WebsiteBadge } from '../components/catalog/WebsiteBadge';
import { formatCheckedAgo as formatAgo } from '../components/AvailabilityChip';
import { coverSrc } from '../api/cover';
import {
  useAckInboxChapters,
  useInbox,
  useInboxCaughtUp,
  useModules,
  type InboxEntryT,
  type InboxViewT,
} from '../api/hooks';
import { routeToHash, type Route } from '../router';
import { Button } from '@/components/ui/button';
import { cn } from 'cn';

/** The one ?view= vocabulary — anything else falls back to 'new'. */
function viewFromRoute(route: Route): InboxViewT {
  return route.query['view'] === 'archive' ? 'archive' : 'new';
}

/** Segmented view tabs — plain links so the URL stays the truth. */
function ViewTabs(props: { readonly view: InboxViewT; readonly newCount: number }): ReactElement {
  const tabs: readonly { readonly view: InboxViewT; readonly label: string }[] = [
    { view: 'new', label: 'New' },
    { view: 'archive', label: 'Archive' },
  ];
  return (
    <nav aria-label="Inbox view" className="flex w-fit gap-1 rounded-lg border border-border bg-surface p-1">
      {tabs.map((tab): ReactElement => {
        const active = props.view === tab.view;
        return (
          <a
            key={tab.view}
            href={routeToHash('inbox', tab.view === 'new' ? {} : { view: tab.view })}
            data-testid={`inbox-tab-${tab.view}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-touch-target items-center gap-1.5 rounded-md px-3 text-sm font-medium',
              'text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground',
              active && 'bg-surface text-foreground',
              tab.view === 'new' && 'max-md:px-2.5',
            )}
          >
            {tab.view === 'new' ? <Check aria-hidden="true" className="size-4" /> : <Archive aria-hidden="true" className="size-4" />}
            {tab.label}
            {tab.view === 'new' && props.newCount > 0 ? (
              <span
                data-testid="inbox-tab-new-count"
                className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[11px] leading-none font-semibold text-primary-foreground"
              >
                {props.newCount > 99 ? '99+' : String(props.newCount)}
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

/** One arrival row: cover thumb (the coverSrc proxy), title, chapter
 * label, site badge, arrival time — and, in the new view, the
 * per-chapter acknowledge button. Mobile-first: the row is a
 * full-width flex, every control on the touch token. */
function InboxRow(props: {
  readonly entry: InboxEntryT;
  readonly siteName: string;
  readonly view: InboxViewT;
  readonly onAcknowledge: (chapterKey: string, label: string) => void;
  readonly ackPending: boolean;
}): ReactElement {
  const entry = props.entry;
  const mangaHref = routeToHash('manga', { module: entry.moduleId, url: entry.mangaUrl });
  const title = entry.mangaTitle ?? 'Unknown title';
  return (
    <li
      className="flex items-stretch gap-3 border-b border-border/60 px-3 py-3 last:border-b-0"
      data-testid={`inbox-entry-${entry.chapterKey}`}
    >
      <a
        href={mangaHref}
        className="flex min-h-touch-target shrink-0 items-center"
        aria-label={`Open ${title}`}
      >
        <CoverImage
          src={coverSrc(entry.moduleId, entry.coverLink ?? undefined) ?? ''}
          alt={`${title} cover`}
          testId={`inbox-cover-${entry.chapterKey}`}
          className="size-16 rounded-md sm:size-20"
        />
      </a>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <a
          href={mangaHref}
          className="min-w-0 truncate text-sm font-semibold underline-offset-2 hover:underline"
          data-testid={`inbox-title-${entry.chapterKey}`}
        >
          {title}
        </a>
        <span className="min-w-0 truncate text-sm text-muted-foreground" data-testid={`inbox-chapter-${entry.chapterKey}`}>
          {entry.chapterLabel !== '' ? entry.chapterLabel : entry.chapterLink}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <WebsiteBadge siteName={props.siteName} siteId={entry.moduleId} />
          <span className="text-xs text-muted-foreground">
            {props.view === 'archive' && entry.seenAt !== null
              ? `seen ${formatAgo(entry.seenAt)}`
              : formatAgo(entry.detectedAt)}
          </span>
        </div>
      </div>
      {props.view === 'new' ? (
        <div className="flex shrink-0 items-start">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-md:min-h-touch-target max-md:min-w-touch-target"
            aria-label={`Acknowledge ${title} — ${entry.chapterLabel}`}
            disabled={props.ackPending}
            onClick={(): void => {
              props.onAcknowledge(entry.chapterKey, entry.chapterLabel);
            }}
            data-testid={`inbox-ack-${entry.chapterKey}`}
          >
            <Check aria-hidden="true" />
            <span className="max-md:hidden">Seen</span>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** The healthy state: explicit, and it celebrates being caught up. */
function CaughtUpEmpty(): ReactElement {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface px-6 py-14 text-center"
      data-testid="inbox-empty"
    >
      <span className="text-muted-foreground" aria-hidden="true">
        <Coffee className="size-10" />
      </span>
      <h3 className="text-lg font-semibold">You're all caught up.</h3>
      <p className="max-w-md text-sm text-muted-foreground">
        Nothing new has arrived since you last looked. The scheduler keeps checking whether or not
        this page is open — new chapters will land here the moment the pipe finds them.
      </p>
    </div>
  );
}

export function InboxPage(props: { readonly route: Route }): ReactElement {
  const view = viewFromRoute(props.route);
  const inbox = useInbox(view);
  const modules = useModules();
  const ack = useAckInboxChapters();
  const caughtUp = useInboxCaughtUp();

  const moduleNames = useMemo((): Map<string, string> => {
    const map = new Map<string, string>();
    for (const module of modules.data?.modules ?? []) {
      map.set(module.id, module.name);
    }
    return map;
  }, [modules.data]);

  const onAcknowledge = (chapterKey: string, label: string): void => {
    ack.mutate([chapterKey], {
      onSuccess: (result): void => {
        if (result.acknowledged === 0) {
          // raced away (already seen elsewhere/another device) — the
          // feed refresh makes the row vanish; no error posture.
          return;
        }
        toast.success(`Marked ${label !== '' ? label : 'chapter'} as seen.`);
      },
      onError: (): void => {
        toast.error('Acknowledging the chapter failed; try again in a moment.');
      },
    });
  };

  const onCaughtUp = (): void => {
    caughtUp.mutate(undefined, {
      onSuccess: (result): void => {
        toast.success(
          result.acknowledged === 0
            ? 'Already caught up — nothing new to mark.'
            : `Caught up — ${String(result.acknowledged)} ${result.acknowledged === 1 ? 'chapter' : 'chapters'} marked as seen.`,
        );
      },
      onError: (): void => {
        toast.error('Caught-up failed; try again in a moment.');
      },
    });
  };

  const newCount = inbox.data?.newCount ?? 0;
  const entries = inbox.data?.entries ?? [];

  return (
    <>
      <PageHeader
        title="Inbox"
        description="What arrived — new chapters the pipe found, one row per chapter. Caught up here is caught up on every device."
        actions={
          view === 'new' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-md:min-h-touch-target"
              disabled={caughtUp.isPending || newCount === 0}
              onClick={onCaughtUp}
              data-testid="inbox-caught-up"
            >
              <CheckCheck aria-hidden="true" className={caughtUp.isPending ? 'animate-pulse' : undefined} />
              Caught up
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4">
        <ViewTabs view={view} newCount={newCount} />
      </div>
      {inbox.isPending ? (
        <p className="text-sm text-muted-foreground" data-testid="inbox-loading">Loading the feed…</p>
      ) : inbox.isError ? (
        <div
          className="rounded-lg border border-border bg-surface p-5 text-sm text-muted-foreground"
          data-testid="inbox-error"
        >
          <p>The inbox could not be loaded ({inbox.error.message}).</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={(): void => { void inbox.refetch(); }}>
            Try again
          </Button>
        </div>
      ) : entries.length === 0 && view === 'new' ? (
        <CaughtUpEmpty />
      ) : entries.length === 0 ? (
        <EmptyState title="Nothing in the archive.">
          <p>
            Acknowledged chapters stay here for 30 days — mark arrivals as seen and they will
            collect on this tab.
          </p>
        </EmptyState>
      ) : (
        <ul
          className="list-none m-0 p-0 rounded-lg border border-border bg-surface"
          aria-label={view === 'new' ? 'New arrivals' : 'Acknowledged arrivals'}
          data-testid="inbox-feed"
        >
          {entries.map((entry): ReactElement => (
            <InboxRow
              key={entry.chapterKey}
              entry={entry}
              siteName={moduleNames.get(entry.moduleId) ?? entry.moduleId}
              view={view}
              onAcknowledge={onAcknowledge}
              ackPending={ack.isPending}
            />
          ))}
        </ul>
      )}
      {view === 'new' && entries.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {newCount === 1
            ? '1 chapter waiting — acknowledge it individually or catch up in one go.'
            : `${String(newCount)} chapters waiting — acknowledge individually or catch up in one go.`}
        </p>
      ) : null}
    </>
  );
}
