/**
 * React Query hooks over the GENERATED API client (§10).
 *
 * State-management choice (documented): @tanstack/react-query owns all
 * SERVER state (queries, mutations, cache patching from WS events);
 * local UI state stays in useState/useRef. No other store exists.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { components, operations } from './openapi';
import { ApiError, throwEnvelope, throwNetwork } from './errors';
import { useApiClient } from './context';

// ── wire aliases (all GENERATED — never hand-written) ────────────────
export type ModuleSummaryT = components['schemas']['ModuleSummary'];
export type ModuleOptionDescriptorT = components['schemas']['ModuleOptionDescriptor'];
export type OptionValueT = boolean | string | number;
export type CatalogEntryT = components['schemas']['CatalogEntry'];
export type InfoResponseT = components['schemas']['InfoResponse'];
export type JobT = components['schemas']['Job'];
export type JobStateT = JobT['state'];
export type CatalogPageT = operations['catalogLatest']['responses'][200]['content']['application/json'];
export type JobsPageT = operations['listJobs']['responses'][200]['content']['application/json'];
export type ModuleListT = operations['listModules']['responses'][200]['content']['application/json'];
export type SyncModulesT = operations['syncModules']['responses'][200]['content']['application/json'];
export type SyncAllT = operations['syncAllCatalogs']['responses'][200]['content']['application/json'];

type FetchResult<TData> = {
  data?: TData;
  error?: components['schemas']['ApiErrorEnvelope'];
  response: Response;
};

/** Unwrap an openapi-fetch result: envelope errors become ApiError. */
export async function unwrap<TData>(promise: Promise<FetchResult<TData>>): Promise<TData> {
  let result: FetchResult<TData>;
  try {
    result = await promise;
  } catch (cause: unknown) {
    throwNetwork(cause);
  }
  const { data, error, response } = result;
  if (error !== undefined) throwEnvelope(error, response.status);
  if (data === undefined) {
    throw new ApiError('empty response body', 'internal_error', response.status);
  }
  return data;
}

// ── modules / Settings ───────────────────────────────────────────────

export function useModules(): UseQueryResult<ModuleListT, ApiError> {
  const client = useApiClient();
  return useQuery<ModuleListT, ApiError>({
    queryKey: ['modules'],
    queryFn: (): Promise<ModuleListT> =>
      unwrap(client.GET('/api/modules')),
  });
}

export interface ModuleUpdateInput {
  readonly id: string;
  readonly enabled?: boolean;
  readonly options?: Record<string, OptionValueT>;
  readonly cookies?: string;
}

export function useUpdateModule(): UseMutationResult<ModuleSummaryT, ApiError, ModuleUpdateInput> {
  const client = useApiClient();
  return useMutation<ModuleSummaryT, ApiError, ModuleUpdateInput>({
    mutationFn: async (input): Promise<ModuleSummaryT> =>
      unwrap(
        client.PUT('/api/modules/{id}', {
          params: { path: { id: input.id } },
          body: {
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.options !== undefined ? { options: input.options } : {}),
            ...(input.cookies !== undefined ? { cookies: input.cookies } : {}),
          },
        }),
      ),
  });
}

// ── sync (Settings + D20 bootstrap) ──────────────────────────────────

export function useSyncModules(): UseMutationResult<SyncModulesT, ApiError, void> {
  const client = useApiClient();
  return useMutation<SyncModulesT, ApiError, void>({
    mutationFn: (): Promise<SyncModulesT> => unwrap(client.POST('/api/sync/modules', {})),
  });
}

export function useSyncAllCatalogs(): UseMutationResult<SyncAllT, ApiError, void> {
  const client = useApiClient();
  return useMutation<SyncAllT, ApiError, void>({
    mutationFn: (): Promise<SyncAllT> => unwrap(client.POST('/api/sync/catalog/all', { body: {} })),
  });
}

// ── catalog browse/search (§6.6, cursor pagination) ─────────────────

export type CatalogMode = 'latest' | 'title' | 'search';

/** Page cursor: page number for latest/title, opaque cursor for search. */
export interface CatalogPageParam {
  readonly page: number;
  readonly cursor?: string;
}

export interface CatalogQueryInput {
  readonly catalogId: string;
  readonly mode: CatalogMode;
  readonly q?: string;
  readonly limit: number;
  readonly enabled: boolean;
}

export function useCatalogEntries(
  input: CatalogQueryInput,
): UseInfiniteQueryResult<InfiniteData<CatalogPageT, CatalogPageParam>, ApiError> {
  const client = useApiClient();
  const { catalogId, mode, limit } = input;
  const q = input.q ?? '';
  return useInfiniteQuery<CatalogPageT, ApiError, InfiniteData<CatalogPageT, CatalogPageParam>, QueryKey, CatalogPageParam>({
    queryKey: ['catalog', catalogId, mode, q, limit],
    enabled: input.enabled && catalogId !== '' && (mode !== 'search' || q !== ''),
    initialPageParam: { page: 1 },
    queryFn: async ({ pageParam }): Promise<CatalogPageT> => {
      if (mode === 'search') {
        return unwrap(
          client.GET('/api/catalog/{id}/search', {
            params: {
              path: { id: catalogId },
              query: {
                q,
                limit,
                ...(pageParam.cursor !== undefined ? { cursor: pageParam.cursor } : {}),
              },
            },
          }),
        );
      }
      const path = mode === 'latest' ? '/api/catalog/{id}/latest' : '/api/catalog/{id}/title';
      return unwrap(
        client.GET(path, {
          params: { path: { id: catalogId }, query: { page: pageParam.page, limit } },
        }),
      );
    },
    getNextPageParam: (lastPage, allPages, lastPageParam): CatalogPageParam | undefined => {
      if (mode === 'search') {
        return lastPage.nextCursor !== undefined
          ? { page: lastPageParam.page + 1, cursor: lastPage.nextCursor }
          : undefined;
      }
      const loaded = allPages.reduce((count, page): number => count + page.entries.length, 0);
      if (lastPage.total !== undefined) {
        return loaded < lastPage.total ? { page: lastPageParam.page + 1 } : undefined;
      }
      return lastPage.entries.length >= limit ? { page: lastPageParam.page + 1 } : undefined;
    },
  });
}

// ── live info (Manga detail, §5.8) ───────────────────────────────────

export function useLiveInfo(
  moduleId: string | undefined,
  url: string | undefined,
): UseQueryResult<InfoResponseT, ApiError> {
  const client = useApiClient();
  const enabled = moduleId !== undefined && moduleId !== '' && url !== undefined && url !== '';
  return useQuery<InfoResponseT, ApiError>({
    queryKey: ['info', moduleId, url],
    enabled,
    queryFn: (): Promise<InfoResponseT> => {
      if (moduleId === undefined || url === undefined) {
        throw new ApiError('missing moduleId/url', 'bad_request', 0);
      }
      return unwrap(client.POST('/api/info', { body: { moduleId, url } }));
    },
  });
}

// ── jobs (Downloads, §7.1) ───────────────────────────────────────────

export function useJobsList(
  state: JobStateT | '',
): UseInfiniteQueryResult<InfiniteData<JobsPageT, { cursor?: string }>, ApiError> {
  const client = useApiClient();
  return useInfiniteQuery<JobsPageT, ApiError, InfiniteData<JobsPageT, { cursor?: string }>, QueryKey, { cursor?: string }>({
    queryKey: ['jobs', state],
    initialPageParam: {},
    queryFn: async ({ pageParam }): Promise<JobsPageT> =>
      unwrap(
        client.GET('/api/jobs', {
          params: {
            query: {
              limit: 20,
              ...(state !== '' ? { state } : {}),
              ...(pageParam.cursor !== undefined ? { cursor: pageParam.cursor } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage): { cursor?: string } | undefined =>
      lastPage.nextCursor !== undefined ? { cursor: lastPage.nextCursor } : undefined,
  });
}

export interface DownloadJobInput {
  readonly moduleId: string;
  readonly mangaUrl: string;
  readonly mangaTitle?: string;
  readonly chapterLink: string;
  readonly chapterName?: string;
  readonly idempotencyKey?: string;
}

export function useCreateDownloadJob(): UseMutationResult<{ job: JobT }, ApiError, DownloadJobInput> {
  const client = useApiClient();
  return useMutation<{ job: JobT }, ApiError, DownloadJobInput>({
    mutationFn: async (input): Promise<{ job: JobT }> =>
      unwrap(
        client.POST('/api/jobs/download', {
          body: {
            moduleId: input.moduleId,
            mangaUrl: input.mangaUrl,
            chapterLink: input.chapterLink,
            ...(input.mangaTitle !== undefined ? { mangaTitle: input.mangaTitle } : {}),
            ...(input.chapterName !== undefined ? { chapterName: input.chapterName } : {}),
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          },
        }),
      ),
  });
}
