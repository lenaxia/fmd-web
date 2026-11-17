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
export type LibraryPageT = operations['listLibrary']['responses'][200]['content']['application/json'];
export type LibraryFileT = components['schemas']['LibraryFile'];
export type ModuleListT = operations['listModules']['responses'][200]['content']['application/json'];
export type SettingsT = operations['getSettings']['responses'][200]['content']['application/json'];
export type ProxySettingsT = components['schemas']['ProxySettings'];
export type SyncModulesT = operations['syncModules']['responses'][200]['content']['application/json'];
export type SyncAllT = operations['syncAllCatalogs']['responses'][200]['content']['application/json'];
export type CatalogSyncOneT = operations['syncCatalog']['responses'][200]['content']['application/json'];

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
  /** Per-module proxy override; null = inherit the global config. */
  readonly proxy?: ProxySettingsT | null;
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
            ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
          },
        }),
      ),
  });
}

// ── settings (global proxy + §5.11 browser profile) ─────────────────

export function useSettings(): UseQueryResult<SettingsT, ApiError> {
  const client = useApiClient();
  return useQuery<SettingsT, ApiError>({
    queryKey: ['settings'],
    queryFn: (): Promise<SettingsT> => unwrap(client.GET('/api/settings')),
  });
}

export function useUpdateProxy(): UseMutationResult<SettingsT, ApiError, ProxySettingsT> {
  const client = useApiClient();
  return useMutation<SettingsT, ApiError, ProxySettingsT>({
    mutationFn: async (proxy): Promise<SettingsT> =>
      unwrap(client.PUT('/api/settings/proxy', { body: proxy })),
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

// ── single-catalog provisioning (site-first browse) ─────────────────

export interface ProvisionCatalogInput {
  readonly moduleId: string;
}

/**
 * POST /api/sync/catalog/:id for the auto-provision flow (site-first
 * browse). Progress streams over WS (`sync` frames, see
 * useSyncCatalogProgress); THIS promise's resolution is the REST
 * terminal truth (state updated|unchanged|failed + error taxonomy via
 * the `no-catalog:` error prefix). Cancel is UX-level (the provision
 * view is withdrawn): the sync itself is one idempotent request, and a
 * late completion merely flips the site's chip — never a partial state.
 */
export function useProvisionCatalog(): UseMutationResult<CatalogSyncOneT, ApiError, ProvisionCatalogInput> {
  const client = useApiClient();
  return useMutation<CatalogSyncOneT, ApiError, ProvisionCatalogInput>({
    mutationFn: (input): Promise<CatalogSyncOneT> =>
      unwrap(
        client.POST('/api/sync/catalog/{id}', {
          params: { path: { id: input.moduleId } },
          body: {},
        }),
      ),
  });
}

// ── catalog browse/search (§6.6, cursor pagination) ─────────────────

export type CatalogMode = 'latest' | 'title' | 'search';

/** All-sites union search page (GET /api/search). */
export type AllSitesSearchPageT = operations['allSitesSearch']['responses'][200]['content']['application/json'];
export type SearchEntryT = AllSitesSearchPageT['entries'][number];
export type SearchFacetT = NonNullable<AllSitesSearchPageT['facets']>[number];
export type SiteSearchFailureT = NonNullable<AllSitesSearchPageT['warnings']>[number];
export type ExcludedSiteT = NonNullable<AllSitesSearchPageT['excluded']>[number];

export interface AllSitesSearchInput {
  readonly q?: string;
  readonly status?: string;
  readonly authors?: string;
  readonly genres?: readonly string[];
  readonly genresMode?: 'all' | 'any';
  readonly newDays?: number;
  readonly limit: number;
  readonly enabled: boolean;
}

/**
 * GET /api/search — the FMD2 cbSearchFromAllSites union: fans out over
 * every installed catalog server-side; `warnings` carry typed partial
 * failures (a broken catalog never fails the page) and `excluded`
 * names enabled sites without a catalog (installed-only semantics).
 */
export function useAllSitesSearch(
  input: AllSitesSearchInput,
): UseInfiniteQueryResult<InfiniteData<AllSitesSearchPageT, { cursor?: string }>, ApiError> {
  const client = useApiClient();
  const q = input.q ?? '';
  const status = input.status ?? '';
  const authors = input.authors ?? '';
  const genres = input.genres ?? [];
  const genresMode = input.genresMode ?? 'all';
  const newDays = input.newDays;
  return useInfiniteQuery<AllSitesSearchPageT, ApiError, InfiniteData<AllSitesSearchPageT, { cursor?: string }>, QueryKey, { cursor?: string }>({
    queryKey: ['search-all', q, status, authors, genres, genresMode, newDays, input.limit],
    enabled:
      input.enabled &&
      (q !== '' || status !== '' || authors !== '' || genres.length > 0 || newDays !== undefined),
    initialPageParam: {},
    queryFn: async ({ pageParam, signal }): Promise<AllSitesSearchPageT> => {
      const compatible: AbortSignal | undefined = requestCompatibleSignal(signal);
      return unwrap(
        client.GET('/api/search', {
          params: {
            query: {
              ...(q !== '' ? { q } : {}),
              limit: input.limit,
              ...(status !== '' ? { status } : {}),
              ...(authors !== '' ? { authors } : {}),
              ...(genres.length > 0 ? { genres: [...genres] } : {}),
              genresMode,
              ...(newDays !== undefined ? { newDays } : {}),
              ...(pageParam.cursor !== undefined ? { cursor: pageParam.cursor } : {}),
            },
          },
          ...(compatible !== undefined ? { signal: compatible } : {}),
        }),
      );
    },
    getNextPageParam: (lastPage): { cursor?: string } | undefined =>
      lastPage.nextCursor !== undefined ? { cursor: lastPage.nextCursor } : undefined,
  });
}

/** Page cursor: page number for latest/title, opaque cursor for search. */
export interface CatalogPageParam {
  readonly page: number;
  readonly cursor?: string;
}

export interface CatalogQueryInput {
  readonly catalogId: string;
  readonly mode: CatalogMode;
  readonly q?: string;
  /** FMD2 filter-panel params (additive search extension). */
  readonly status?: string;
  readonly authors?: string;
  readonly genres?: readonly string[];
  readonly genresMode?: 'all' | 'any';
  readonly newDays?: number;
  readonly limit: number;
  readonly enabled: boolean;
}

/**
 * Realm-guarded AbortSignal pass-through. openapi-fetch constructs
 * `new Request(url, { signal })`, which validates the signal against
 * the CURRENT realm's AbortSignal — under jsdom (vitest) the queryFn
 * signal can come from a different realm than the undici `Request`
 * and the constructor rejects it ("Expected signal … to be an instance
 * of AbortSignal"), breaking every catalog query in the unit suite.
 * Probe compatibility: pass the signal through when the realms match
 * (browsers — true network aborts reach fetch); drop it when they
 * don't (react-query's own cancellation still rejects the queryFn
 * promise, so superseded queries never land).
 */
export function requestCompatibleSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (signal === undefined || typeof Request === 'undefined') {
    return undefined;
  }
  try {
    new Request('about:blank', { signal });
    return signal;
  } catch {
    return undefined;
  }
}

export function useCatalogEntries(
  input: CatalogQueryInput,
): UseInfiniteQueryResult<InfiniteData<CatalogPageT, CatalogPageParam>, ApiError> {
  const client = useApiClient();
  const { catalogId, mode, limit } = input;
  const q = input.q ?? '';
  const status = input.status ?? '';
  const authors = input.authors ?? '';
  const genres = input.genres ?? [];
  const genresMode = input.genresMode ?? 'all';
  const newDays = input.newDays;
  return useInfiniteQuery<CatalogPageT, ApiError, InfiniteData<CatalogPageT, CatalogPageParam>, QueryKey, CatalogPageParam>({
    queryKey: ['catalog', catalogId, mode, q, status, authors, genres, genresMode, newDays, limit],
    enabled: input.enabled && catalogId !== '' && (mode !== 'search' || q !== '' || status !== '' || authors !== '' || genres.length > 0 || newDays !== undefined),
    initialPageParam: { page: 1 },
    queryFn: async ({ pageParam, signal }): Promise<CatalogPageT> => {
      // exactOptionalPropertyTypes: never pass an explicit undefined
      // signal — spread it in only when the realm guard returns one.
      const compatible: AbortSignal | undefined = requestCompatibleSignal(signal);
      if (mode === 'search') {
        return unwrap(
          client.GET('/api/catalog/{id}/search', {
            params: {
              path: { id: catalogId },
              query: {
                ...(q !== '' ? { q } : {}),
                limit,
                ...(status !== '' ? { status } : {}),
                ...(authors !== '' ? { authors } : {}),
                ...(genres.length > 0 ? { genres: [...genres] } : {}),
                genresMode,
                ...(newDays !== undefined ? { newDays } : {}),
                ...(pageParam.cursor !== undefined ? { cursor: pageParam.cursor } : {}),
              },
            },
            ...(compatible !== undefined ? { signal: compatible } : {}),
          }),
        );
      }
      const path = mode === 'latest' ? '/api/catalog/{id}/latest' : '/api/catalog/{id}/title';
      return unwrap(
        client.GET(path, {
          params: { path: { id: catalogId }, query: { page: pageParam.page, limit } },
          ...(compatible !== undefined ? { signal: compatible } : {}),
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

/** §7.1 user cancel (queued/running/retry → cancelled; terminal 409s). */
export function useCancelJob(): UseMutationResult<{ job: JobT }, ApiError, string> {
  const client = useApiClient();
  return useMutation<{ job: JobT }, ApiError, string>({
    mutationFn: async (jobId): Promise<{ job: JobT }> =>
      unwrap(client.POST('/api/jobs/{id}/cancel', { params: { path: { id: jobId } }, body: {} })),
  });
}

// ── library (§7.1 listing) ───────────────────────────────────────────

export function useLibrary(): UseInfiniteQueryResult<InfiniteData<LibraryPageT, { cursor?: string }>, ApiError> {
  const client = useApiClient();
  return useInfiniteQuery<LibraryPageT, ApiError, InfiniteData<LibraryPageT, { cursor?: string }>, QueryKey, { cursor?: string }>({
    queryKey: ['library'],
    initialPageParam: {},
    queryFn: async ({ pageParam }): Promise<LibraryPageT> =>
      unwrap(
        client.GET('/api/library', {
          params: {
            query: {
              limit: 50,
              ...(pageParam.cursor !== undefined ? { cursor: pageParam.cursor } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage): { cursor?: string } | undefined =>
      lastPage.nextCursor !== undefined ? { cursor: lastPage.nextCursor } : undefined,
  });
}

// ── readiness / D20 bootstrap banner ─────────────────────────────────

export interface BootstrapStatusT {
  ready: boolean;
  reason?: string;
}

/**
 * Poll /readyz until the server reports ready. While the D20 first-run
 * bootstrap runs, /readyz answers 503 with the current stage as
 * `reason` — that stage is what the App shell banner surfaces.
 */
export function useBootstrapStatus(): UseQueryResult<BootstrapStatusT, ApiError> {
  const client = useApiClient();
  return useQuery<BootstrapStatusT, ApiError>({
    queryKey: ['readyz'],
    refetchInterval: (query): number | false => (query.state.data?.ready === true ? false : 1000),
    refetchOnWindowFocus: false,
    staleTime: 0,
    queryFn: async (): Promise<BootstrapStatusT> => {
      let readyzBody: { ready: boolean; reason?: string } | undefined;
      let readyzError: unknown;
      let readyzStatus = 0;
      try {
        const result = await client.GET('/readyz');
        readyzBody = result.data;
        readyzError = result.error;
        readyzStatus = result.response.status;
      } catch (cause: unknown) {
        throwNetwork(cause); // server not listening yet (bootstrap early)
      }
      if (readyzBody !== undefined) {
        return {
          ready: readyzBody.ready,
          ...(readyzBody.reason !== undefined ? { reason: readyzBody.reason } : {}),
        };
      }
      // 503 while bootstrapping: the body IS the status shape, but
      // openapi-fetch files non-2xx under `error`.
      if (readyzError !== null && typeof readyzError === 'object' && 'ready' in readyzError) {
        const status = readyzError as { ready: boolean; reason?: string };
        return {
          ready: status.ready,
          ...(status.reason !== undefined ? { reason: status.reason } : {}),
        };
      }
      throw new ApiError('readyz answered without a status body', 'internal_error', readyzStatus);
    },
  });
}

// ── favorites (§7.2 DoCheck engine + scheduler) ──────────────────────

export type FavoriteT = components['schemas']['Favorite'];
export type FavoritesListT = operations['listFavorites']['responses'][200]['content']['application/json'];
export type FavoriteResponseT = operations['createFavorite']['responses'][201]['content']['application/json'];
export type FavoriteCheckT = operations['checkFavoriteNow']['responses'][200]['content']['application/json'];

export function useFavorites(): UseQueryResult<FavoritesListT, ApiError> {
  const client = useApiClient();
  return useQuery<FavoritesListT, ApiError>({
    queryKey: ['favorites'],
    queryFn: (): Promise<FavoritesListT> => unwrap(client.GET('/api/favorites')),
  });
}

export interface FavoriteCreateInput {
  readonly moduleId: string;
  readonly url: string;
  readonly title?: string;
  readonly autoDownload?: boolean;
}

export function useCreateFavorite(): UseMutationResult<FavoriteT, ApiError, FavoriteCreateInput> {
  const client = useApiClient();
  return useMutation<FavoriteT, ApiError, FavoriteCreateInput>({
    mutationFn: async (input): Promise<FavoriteT> => {
      const result = await unwrap(
        client.POST('/api/favorites', {
          body: {
            moduleId: input.moduleId,
            url: input.url,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.autoDownload !== undefined ? { autoDownload: input.autoDownload } : {}),
          },
        }),
      );
      return result.favorite;
    },
  });
}

/** D4 import path — the tag-100 transfer-favorite bulk-ingest. */
export function useImportFavorite(): UseMutationResult<FavoriteT, ApiError, FavoriteCreateInput> {
  const client = useApiClient();
  return useMutation<FavoriteT, ApiError, FavoriteCreateInput>({
    mutationFn: async (input): Promise<FavoriteT> => {
      const result = await unwrap(
        client.POST('/api/favorites/import', {
          body: {
            moduleId: input.moduleId,
            url: input.url,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.autoDownload !== undefined ? { autoDownload: input.autoDownload } : {}),
          },
        }),
      );
      return result.favorite;
    },
  });
}

export interface FavoriteUpdateInput {
  readonly id: string;
  readonly title?: string;
  readonly autoDownload?: boolean;
}

export function useUpdateFavorite(): UseMutationResult<FavoriteT, ApiError, FavoriteUpdateInput> {
  const client = useApiClient();
  return useMutation<FavoriteT, ApiError, FavoriteUpdateInput>({
    mutationFn: async (input): Promise<FavoriteT> => {
      const result = await unwrap(
        client.PUT('/api/favorites/{id}', {
          params: { path: { id: input.id } },
          body: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.autoDownload !== undefined ? { autoDownload: input.autoDownload } : {}),
          },
        }),
      );
      return result.favorite;
    },
  });
}

export function useDeleteFavorite(): UseMutationResult<{ ok: true }, ApiError, string> {
  const client = useApiClient();
  return useMutation<{ ok: true }, ApiError, string>({
    mutationFn: async (id): Promise<{ ok: true }> =>
      unwrap(client.DELETE('/api/favorites/{id}', { params: { path: { id } } })),
  });
}

export function useCheckFavoriteNow(): UseMutationResult<FavoriteCheckT, ApiError, string> {
  const client = useApiClient();
  return useMutation<FavoriteCheckT, ApiError, string>({
    mutationFn: async (id): Promise<FavoriteCheckT> =>
      unwrap(client.POST('/api/favorites/{id}/check', { params: { path: { id } } })),
  });
}
