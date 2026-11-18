/**
 * AwaySummaryCard (R5 arrival — 'While you were away'): the landing
 * view's return-visit greeting. When the previous visit stamp is
 * >= 1 h stale AND the server has news since then, a dismissible card
 * summarizes what the server-side queue did unsupervised:
 *
 *   downloads  — jobs that FINISHED since (state=done + `since` floor
 *                on updatedAt), grouped per manga, each row a deep
 *                link to the manga page
 *   favorites  — favorites a check touched since with new chapters
 *                (additive `newsSince` flag, each row a deep link to
 *                the Favorites page)
 *
 * 'Nothing new' renders NOTHING (no empty card, ever). Card states:
 * has-downloads / has-new-chapters / both. Dismissal persists per NEWS
 * BATCH — the batch id is the newest item timestamp, so the same batch
 * never nags again while a newer batch may.
 *
 * Data is WS-events-compatible by construction: the jobs query rides
 * the standard ['jobs', *] cache the app-level feed patches, and a
 * resync invalidates it like any jobs query (no polling anywhere).
 */
import { useMemo, useState, type ReactElement } from 'react';
import { CalendarClock, Download as DownloadIcon, Heart, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from 'cn';
import { useFavoritesNews, useJobsList, type FavoriteT, type JobT } from '../../api/hooks';
import { navigateToManga, routeToHash } from '../../router';
import {
  beginVisit,
  isStaleVisit,
  readAwayDismissed,
  writeAwayDismissed,
} from '../../state/last-visit';

/** One manga group of finished-since downloads (deep-linkable). */
export interface AwayDownloadGroup {
  readonly moduleId: string;
  readonly mangaUrl: string;
  readonly title: string;
  readonly count: number;
  readonly latest: string;
}

/** Group finished jobs by their manga (moduleId + mangaUrl). */
export function groupDoneByManga(jobs: readonly JobT[]): AwayDownloadGroup[] {
  const groups = new Map<string, AwayDownloadGroup>();
  for (const job of jobs) {
    const payload = job.payload as Record<string, unknown>;
    const mangaUrl = typeof payload['mangaUrl'] === 'string' ? payload['mangaUrl'] : '';
    const title =
      typeof payload['mangaTitle'] === 'string' && payload['mangaTitle'] !== ''
        ? payload['mangaTitle']
        : 'Untitled manga';
    if (mangaUrl === '') {
      continue; // not a chapter-shaped download payload — nothing to deep-link
    }
    const key = `${job.moduleId}|${mangaUrl}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        moduleId: job.moduleId,
        mangaUrl,
        title,
        count: 1,
        latest: job.updatedAt,
      });
    } else {
      groups.set(key, {
        ...existing,
        count: existing.count + 1,
        latest: existing.latest < job.updatedAt ? job.updatedAt : existing.latest,
      });
    }
  }
  return [...groups.values()].sort((a, b): number => (a.latest < b.latest ? 1 : -1));
}

/** The news-batch id: the newest item timestamp across both halves. */
export function awayBatchId(
  groups: readonly AwayDownloadGroup[],
  newsy: readonly FavoriteT[],
): string | undefined {
  const stamps = [
    ...groups.map((group): string => group.latest),
    ...newsy.map((favorite): string => favorite.lastCheck ?? ''),
  ].filter((stamp): boolean => stamp !== '');
  if (stamps.length === 0) {
    return undefined;
  }
  return stamps.reduce((newest, stamp): string => (stamp > newest ? stamp : newest));
}

export function AwaySummaryCard(): ReactElement | null {
  // One-shot visit evaluation (the app shell already ran it on mount;
  // idempotent here so the card is self-contained under tests).
  const { previous } = beginVisit();
  const stale = isStaleVisit(previous);

  const downloads = useJobsList(
    { states: ['done'], q: '', ...(previous !== undefined ? { since: previous } : {}) },
    stale && previous !== undefined,
  );
  const favorites = useFavoritesNews(previous, stale && previous !== undefined);

  const [dismissed, setDismissed] = useState<string | undefined>(readAwayDismissed());

  const groups = useMemo(
    (): AwayDownloadGroup[] =>
      groupDoneByManga(downloads.data?.pages.flatMap((page): JobT[] => [...page.jobs]) ?? []),
    [downloads.data],
  );
  const newsy = useMemo(
    (): FavoriteT[] =>
      (favorites.data?.favorites ?? []).filter((favorite): boolean => favorite.newsSince === true),
    [favorites.data],
  );

  // Nothing to summarize → nothing rendered (loading included — the
  // card appears only with news, never as an empty shell).
  if (!stale || !downloads.isSuccess || !favorites.isSuccess) {
    return null;
  }
  if (groups.length === 0 && newsy.length === 0) {
    return null;
  }
  const batchId = awayBatchId(groups, newsy);
  if (batchId === undefined || dismissed === batchId) {
    return null;
  }

  const dismiss = (): void => {
    writeAwayDismissed(batchId);
    setDismissed(batchId);
  };

  return (
    <section
      aria-label="While you were away"
      data-testid="away-summary"
      className="mb-6 rounded-lg border bg-surface/40 p-4"
    >
      <div className="mb-3 flex items-center gap-2">
        <CalendarClock aria-hidden="true" className="size-4 text-primary" />
        <h2 className="m-0 text-sm font-semibold">While you were away</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          aria-label="Dismiss the away summary"
          data-testid="away-summary-dismiss"
          onClick={dismiss}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <div className="flex flex-col gap-4">
        {groups.length > 0 ? (
          <div data-testid="away-summary-downloads">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <DownloadIcon aria-hidden="true" className="size-3.5" />
              Chapters downloaded
            </h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {groups.map((group): ReactElement => (
                <li key={`${group.moduleId}|${group.mangaUrl}`}>
                  <a
                    data-testid="away-summary-download"
                    href="#"
                    onClick={(event): void => {
                      event.preventDefault();
                      navigateToManga({
                        module: group.moduleId,
                        url: group.mangaUrl,
                        ...(group.title !== '' ? { title: group.title } : {}),
                      });
                    }}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm',
                      'transition-colors hover:bg-surface-hover',
                    )}
                  >
                    <span className="min-w-0 truncate font-medium">{group.title}</span>
                    <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
                      {group.count === 1 ? '1 chapter' : `${String(group.count)} chapters`}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {newsy.length > 0 ? (
          <div data-testid="away-summary-favorites">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Heart aria-hidden="true" className="size-3.5" />
              New chapters for favorites
            </h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {newsy.map((favorite): ReactElement => (
                <li key={favorite.id}>
                  <a
                    data-testid="away-summary-favorite"
                    href={routeToHash('favorites', {})}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm',
                      'transition-colors hover:bg-surface-hover',
                    )}
                  >
                    <span className="min-w-0 truncate font-medium">{favorite.title ?? favorite.url}</span>
                    <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
                      {favorite.newChapterCount === 1
                        ? '1 new chapter'
                        : `${String(favorite.newChapterCount)} new chapters`}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
