/**
 * Downloads-page live feed (D19/D21): bind the WS backfill controller
 * to the React Query jobs caches. Events patch every `['jobs', …]`
 * cache in place; a `resync` hint or a `gap` marker (D21) invalidates
 * the jobs queries (full refetch) and the connection status is exposed
 * for the UI badge.
 */
import { useEffect, useRef, useState } from 'react';
import type { QueryClient, InfiniteData } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { JobT, JobsPageT } from '../api/hooks';
import { wsEndpointUrl } from '../api/client';
import {
  WsBackfillController,
  type WsStatus,
  type WebSocketFactory,
} from './ws-backfill';
import { eventJobToWire } from './ws-protocol';

/** Apply one job snapshot to a cached jobs page (replace or prepend). */
export function patchJobsPage(page: JobsPageT, job: JobT): JobsPageT {
  const index = page.jobs.findIndex((j): boolean => j.id === job.id);
  if (index === -1) {
    // New job (queued) — prepend; cursor drift is healed by resync.
    return { ...page, jobs: [job, ...page.jobs] };
  }
  const jobs = [...page.jobs];
  jobs[index] = job;
  return { ...page, jobs };
}

export interface JobsFeed {
  readonly status: WsStatus;
  readonly lastEventId: string | undefined;
  readonly reconnectAttempt: number;
  readonly resyncCount: number;
}

export function useJobsFeed(options: {
  enabled: boolean;
  webSocketFactory?: WebSocketFactory;
}): JobsFeed {
  const queryClient: QueryClient = useQueryClient();
  const { enabled } = options;
  const factoryRef = useRef<WebSocketFactory | undefined>(options.webSocketFactory);
  const [feed, setFeed] = useState<JobsFeed>({
    status: enabled ? 'connecting' : 'idle',
    lastEventId: undefined,
    reconnectAttempt: 0,
    resyncCount: 0,
  });

  useEffect((): (() => void) => {
    if (!enabled) return (): void => {};
    const controller = new WsBackfillController({
      url: wsEndpointUrl(),
      ...(factoryRef.current !== undefined ? { webSocketFactory: factoryRef.current } : {}),
      onEvent: (event): void => {
        // Infinite-query caches hold InfiniteData — patch every page.
        queryClient.setQueriesData<InfiniteData<JobsPageT>>({ queryKey: ['jobs'] }, (data) =>
          data === undefined
            ? data
            : { ...data, pages: data.pages.map((page): JobsPageT => patchJobsPage(page, eventJobToWire(event))) },
        );
        setFeed((prev) => ({
          ...prev,
          status: controller.status,
          lastEventId: controller.lastEventId,
          reconnectAttempt: controller.reconnectAttempt,
        }));
      },
      onResync: (): void => {
        void queryClient.invalidateQueries({ queryKey: ['jobs'] });
        setFeed((prev) => ({
          ...prev,
          resyncCount: prev.resyncCount + 1,
          status: controller.status,
          lastEventId: controller.lastEventId,
          reconnectAttempt: controller.reconnectAttempt,
        }));
      },
    });
    controller.start();
    const poll = setInterval((): void => {
      setFeed((prev) => {
        const next: JobsFeed = {
          status: controller.status,
          lastEventId: controller.lastEventId,
          reconnectAttempt: controller.reconnectAttempt,
          resyncCount: prev.resyncCount,
        };
        return prev.status === next.status &&
          prev.lastEventId === next.lastEventId &&
          prev.reconnectAttempt === next.reconnectAttempt
          ? prev
          : next;
      });
    }, 500);
    return (): void => {
      clearInterval(poll);
      controller.stop();
    };
  }, [enabled, queryClient]);

  return feed;
}
