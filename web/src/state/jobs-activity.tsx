/**
 * JobsActivityProvider (R5 arrival): the ONE app-level WS jobs feed
 * plus the nav-surface signals derived from it.
 *
 * The Downloads page used to own the only /ws connection — away from
 * it nothing was live. The feed moves HERE (single connection for the
 * whole app; Downloads consumes the same context), and the provider
 * derives:
 *
 *   activeCount   — running+queued jobs, from a ['jobs', …] query the
 *                   feed patches in place (WS events only, never
 *                   polling); a resync/reconnect invalidates it, so
 *                   the count is reconnect-safe by construction.
 *   completionDot — set when a job completes LIVE while the app is
 *                   open (backfill replays never re-set it — the away
 *                   summary owns offline gaps), cleared by the shell
 *                   when the user VISITS Downloads.
 *
 * Completion also fires the toast path (sonner) — 'the app tells you
 * what happened' while you watch, not only after you return.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { unwrap, type JobsPageT, type JobT } from '../api/hooks';
import { useApiClient } from '../api/context';
import { ApiError } from '../api/errors';
import { useJobsFeed, type JobsFeed } from './use-jobs-feed';

export interface JobsActivity {
  readonly feed: JobsFeed;
  /** running+queued count (live, reconnect-safe; caps at 99+ display). */
  readonly activeCount: number;
  /** A completion happened while open and Downloads is unvisited since. */
  readonly completionDot: boolean;
  /** Shell hook: clear the dot (the user visited Downloads). */
  readonly clearCompletionDot: () => void;
}

const JobsActivityContext = createContext<JobsActivity | undefined>(undefined);

/** Badge label — 99+ keeps the chip inside the tab's rhythm. */
export function badgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function jobLabel(job: JobT): string {
  const payload = job.payload as Record<string, unknown>;
  const title = typeof payload['mangaTitle'] === 'string' ? payload['mangaTitle'] : '';
  const chapter = typeof payload['chapterName'] === 'string' ? payload['chapterName'] : '';
  if (title !== '' && chapter !== '') {
    return `${title} · ${chapter}`;
  }
  return title !== '' ? title : chapter !== '' ? chapter : `job ${job.id}`;
}

export function JobsActivityProvider(props: { readonly children: ReactNode }): ReactNode {
  const [completionDot, setCompletionDot] = useState(false);

  // Completion toasts fire once per live done transition (the phase
  // tap suppresses reconnect backfill replays).
  const toastIds = useRef(new Set<string>());
  const onJobEvent = useCallback(
    (job: JobT, phase: 'live' | 'backfill'): void => {
      if (job.state !== 'done' || phase !== 'live') {
        return;
      }
      // One toast per terminal attempt: chained re-downloads produce a
      // NEW done event for the same id, so the key includes updatedAt.
      const key = `${job.id}:${job.updatedAt}`;
      if (toastIds.current.has(key)) {
        return;
      }
      toastIds.current.add(key);
      toast.success(`Downloaded: ${jobLabel(job)}`, { description: 'Finished while you were away from the Downloads tab.' });
      setCompletionDot(true);
    },
    [],
  );

  const feed = useJobsFeed({ enabled: true, onJobEvent });

  // The badge count rides the standard ['jobs', *] cache family: the
  // feed patches it on every event and a resync invalidates it —
  // WS-driven, never polled. One page of 100 covers any realistic
  // active queue; the client re-filters defensively.
  const client = useApiClient();
  const activity = useInfiniteQuery<JobsPageT, ApiError, InfiniteData<JobsPageT, { cursor?: string }>, readonly unknown[], { cursor?: string }>({
    queryKey: ['jobs', 'activity', JSON.stringify({ states: ['queued', 'running'] })],
    initialPageParam: {},
    queryFn: async ({ pageParam }): Promise<JobsPageT> =>
      unwrap(
        client.GET('/api/jobs', {
          params: {
            query: {
              limit: 100,
              states: 'queued,running',
              ...(pageParam.cursor !== undefined ? { cursor: pageParam.cursor } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage): { cursor?: string } | undefined =>
      lastPage.nextCursor !== undefined ? { cursor: lastPage.nextCursor } : undefined,
  });

  const activeCount = useMemo((): number => {
    const rows = activity.data?.pages.flatMap((page): JobT[] => [...page.jobs]) ?? [];
    return rows.filter((job): boolean => job.state === 'queued' || job.state === 'running').length;
  }, [activity.data]);

  const clearCompletionDot = useCallback((): void => {
    setCompletionDot(false);
  }, []);

  const value = useMemo<JobsActivity>(
    (): JobsActivity => ({ feed, activeCount, completionDot, clearCompletionDot }),
    [feed, activeCount, completionDot, clearCompletionDot],
  );

  return <JobsActivityContext.Provider value={value}>{props.children}</JobsActivityContext.Provider>;
}

export function useJobsActivity(): JobsActivity {
  const context = useContext(JobsActivityContext);
  if (context === undefined) {
    throw new Error('useJobsActivity requires JobsActivityProvider (the app shell mounts it)');
  }
  return context;
}
