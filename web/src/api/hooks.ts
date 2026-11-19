/**
 * React Query hooks over the GENERATED API client (§10).
 *
 * State-management choice (documented): @tanstack/react-query owns all
 * SERVER state (queries, mutations, cache patching from WS events);
 * local UI state stays in useState/useRef. No other store exists.
 */
import {
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
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
export type ModuleAvailabilityT = components['schemas']['ModuleAvailability'];
export type ModuleCheckResponseT = operations['checkModuleAvailability']['responses'][200]['content']['application/json'];
export type OptionValueT = boolean | string | number;
export type CatalogEntryT = components['schemas']['CatalogEntry'];
export type InfoResponseT = components['schemas']['InfoResponse'];
export type JobT = components['schemas']['Job'];
export type JobStateT = JobT['state'];
export type CatalogPageT = operations['catalogLatest']['responses'][200]['content']['application/json'];
export type JobsPageT = operations['listJobs']['responses'][200]['content']['application/json'];
export type LibraryPageT = operations['listLibrary']['responses'][200]['content']['application/json'];
export type LibraryFileT = components['schemas']['LibraryFile'];
export type TitleFilesResponseT = operations['listTitleFiles']['responses'][200]['content']['application/json'];
export type TitleFileEntryT = components['schemas']['TitleFileEntry'];
export type LibraryOrphanFileT = components['schemas']['LibraryOrphanFile'];
export type RescanReportT = components['schemas']['RescanReport'];
export type LibraryFilterT = 'all' | 'missing' | 'orphans';
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

// ── preferred sites (D1 §2 ENTER — [fuzzy-javelin-pearls]) ──────────

export type PreferredSitesT = operations['getPreferredSites']['responses'][200]['content']['application/json'];

/**
 * GET /api/preferred-sites — the ordered allowlist (canonical order,
 * D1 §3). Names are NOT carried: the modules registry is the name
 * authority and every consumer joins it (rows read `preferred: true`).
 */
export function usePreferredSites(): UseQueryResult<PreferredSitesT, ApiError> {
  const client = useApiClient();
  return useQuery<PreferredSitesT, ApiError>({
    queryKey: ['preferred-sites'],
    queryFn: (): Promise<PreferredSitesT> =>
      unwrap(client.GET('/api/preferred-sites')),
  });
}

/**
 * PUT /api/preferred-sites — full-list replacement (the one-decision
 * add/remove sent as the next full ordered list). Invalidates the
 * allowlist AND the modules registry (the `preferred` row join) so
 * every affordance flips on refetch.
 */
export function useSetPreferredSites(): UseMutationResult<
  PreferredSitesT,
  ApiError,
  readonly string[]
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<PreferredSitesT, ApiError, readonly string[]>({
    mutationFn: (sites): Promise<PreferredSitesT> =>
      unwrap(client.PUT('/api/preferred-sites', { body: { sites: [...sites] } })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['preferred-sites'] });
      void queryClient.invalidateQueries({ queryKey: ['modules'] });
    },
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

export function useCheckModule(): UseMutationResult<ModuleCheckResponseT, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<ModuleCheckResponseT, ApiError, string>({
    mutationFn: (moduleId): Promise<ModuleCheckResponseT> =>
      unwrap(
        client.POST('/api/modules/{id}/check', {
          params: { path: { id: moduleId } },
        }),
      ),
    onSuccess: (): void => {
      // The availability record rides /api/modules — refresh the
      // registry cache so the status column + facet counts pick the
      // new state up (unknown → reachable/unreachable).
      void queryClient.invalidateQueries({ queryKey: ['modules'] });
    },
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
    mutationFn: (proxy): Promise<SettingsT> =>
      unwrap(client.PUT('/api/settings/proxy', { body: proxy })),
  });
}

// ── R4 single app-wide API token (Settings → API) ────────────────────

export type ApiTokenT = operations['getApiToken']['responses'][200]['content']['application/json'];

/**
 * GET /api/settings/api-token — the ONE token's state. Credential-gated
 * server-side; 401s (and unmocked dev-404s) settle as an error state so
 * the section degrades gracefully instead of retry-storming.
 */
export function useApiToken(): UseQueryResult<ApiTokenT, ApiError> {
  const client = useApiClient();
  return useQuery<ApiTokenT, ApiError>({
    queryKey: ['api-token'],
    queryFn: (): Promise<ApiTokenT> => unwrap(client.GET('/api/settings/api-token')),
    retry: false,
  });
}

/** POST /api/settings/api-token/regenerate — rotate the single value. */
export function useRegenerateApiToken(): UseMutationResult<ApiTokenT, ApiError, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<ApiTokenT, ApiError, void>({
    mutationFn: (): Promise<ApiTokenT> =>
      unwrap(client.POST('/api/settings/api-token/regenerate')),
    onSuccess: (next): void => {
      queryClient.setQueryData(['api-token'], next);
    },
  });
}

// ── output defaults (FMD2 Save-to parity subset, additive) ──────────

export type OutputDefaultsT = components['schemas']['OutputDefaults'];
export type OutputFormatT = OutputDefaultsT['format'];

export interface OutputDefaultsInput {
  readonly format: OutputFormatT;
  readonly chapterNameTemplate: string;
  /** [parity-sweep M8] page-number width inside archives (lfm:4026). */
  readonly digitPadding: number;
  /** [parity-sweep M6] strip a leading manga-title prefix (lfm:4014). */
  readonly removeMangaName: boolean;
  /** [parity-sweep M5] replace non-ASCII filename chars (lfm:3947). */
  readonly unicodeReplacement: boolean;
  readonly unicodeReplacementChar: string;
}

/** PUT /api/settings/output — default archive format + rename template. */
export function useUpdateOutputDefaults(): UseMutationResult<SettingsT, ApiError, OutputDefaultsInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<SettingsT, ApiError, OutputDefaultsInput>({
    mutationFn: (input): Promise<SettingsT> =>
      unwrap(client.PUT('/api/settings/output', { body: input })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

// ── [parity-sweep] settings groups (M10/M2/M4/M13) ─────────────────

export type PerformanceSettingsT = SettingsT['performance'];
export type RetentionSettingsT = SettingsT['retention'];
export type FilenamePolicySettingsT = SettingsT['filenamePolicy'];
export type DiagnosticsSettingsT = SettingsT['diagnostics'];

/** PUT /api/settings/performance — Connections-parity knobs (M10). */
export function useUpdatePerformance(): UseMutationResult<SettingsT, ApiError, PerformanceSettingsT> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<SettingsT, ApiError, PerformanceSettingsT>({
    mutationFn: (input): Promise<SettingsT> =>
      unwrap(client.PUT('/api/settings/performance', { body: input })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

/** PUT /api/settings/retention — job-history retention days (M2; 0 = forever). */
export function useUpdateRetention(): UseMutationResult<SettingsT, ApiError, RetentionSettingsT> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<SettingsT, ApiError, RetentionSettingsT>({
    mutationFn: (input): Promise<SettingsT> =>
      unwrap(client.PUT('/api/settings/retention', { body: input })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

/** PUT /api/settings/filename-policy — D5 mode toggle (M4; env overrides). */
export function useUpdateFilenamePolicy(): UseMutationResult<SettingsT, ApiError, FilenamePolicySettingsT> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<SettingsT, ApiError, FilenamePolicySettingsT>({
    mutationFn: (input): Promise<SettingsT> =>
      unwrap(client.PUT('/api/settings/filename-policy', { body: input })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

/** PUT /api/settings/diagnostics — structured log enable + level (M13). */
export function useUpdateDiagnostics(): UseMutationResult<SettingsT, ApiError, DiagnosticsSettingsT> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<SettingsT, ApiError, DiagnosticsSettingsT>({
    mutationFn: (input): Promise<SettingsT> =>
      unwrap(client.PUT('/api/settings/diagnostics', { body: input })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

// ── [parity-sweep] About (M12) — server version from /healthz ───────

export interface HealthzT {
  readonly status: string;
  readonly version: string;
}

/** GET /healthz — liveness + the server version (About section). */
export function useHealthz(): UseQueryResult<HealthzT, ApiError> {
  const client = useApiClient();
  return useQuery<HealthzT, ApiError>({
    queryKey: ['healthz'],
    queryFn: (): Promise<HealthzT> => unwrap(client.GET('/healthz')),
    staleTime: 300_000,
  });
}

// ── [parity-sweep] open-by-URL (M14, FMD2 edURL parity) ─────────────

export type InfoT = operations['liveInfo']['responses'][200]['content']['application/json'];

/**
 * POST /api/info — url-only bodies resolve the module by host
 * (server-side registry lookup; unknown/ambiguous hosts are typed
 * 400s the caller surfaces). Explicit moduleId still supported.
 */
export function useOpenByUrl(): UseMutationResult<InfoT, ApiError, { url: string; moduleId?: string }> {
  const client = useApiClient();
  return useMutation<InfoT, ApiError, { url: string; moduleId?: string }>({
    mutationFn: (input): Promise<InfoT> =>
      unwrap(
        client.POST('/api/info', {
          body: input.moduleId !== undefined ? { moduleId: input.moduleId, url: input.url } : { url: input.url },
        }),
      ),
  });
}

// ── accounts (§8.6/D4 module accounts — Settings parity) ────────────

export type AccountT = components['schemas']['AccountView'];
export type AccountStatusT = AccountT['status'];
export type AccountListPageT = operations['listAccounts']['responses'][200]['content']['application/json'];

export function useAccounts(): UseQueryResult<AccountListPageT, ApiError> {
  const client = useApiClient();
  return useQuery<AccountListPageT, ApiError>({
    queryKey: ['accounts'],
    queryFn: (): Promise<AccountListPageT> => unwrap(client.GET('/api/accounts')),
  });
}

export interface AccountUpsertInput {
  readonly moduleId: string;
  readonly username: string;
  /** Omitted password/cookies keep the stored (sealed) values. */
  readonly password?: string;
  readonly cookies?: string;
  readonly enabled?: boolean;
}

export function useUpsertAccount(): UseMutationResult<{ account: AccountT }, ApiError, AccountUpsertInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<{ account: AccountT }, ApiError, AccountUpsertInput>({
    mutationFn: (input): Promise<{ account: AccountT }> =>
      unwrap(
        client.PUT('/api/accounts/{moduleId}', {
          params: { path: { moduleId: input.moduleId } },
          body: {
            username: input.username,
            ...(input.password !== undefined && input.password !== '' ? { password: input.password } : {}),
            ...(input.cookies !== undefined ? { cookies: input.cookies } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          },
        }),
      ),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useRemoveAccount(): UseMutationResult<{ ok: true }, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, ApiError, string>({
    mutationFn: (moduleId): Promise<{ ok: true }> =>
      unwrap(
        client.DELETE('/api/accounts/{moduleId}', { params: { path: { moduleId } } }),
      ),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

/**
 * POST /api/accounts/:moduleId/login — run the module OnLogin; the
 * returned account carries the §5.2 status (asValid/asInvalid/…)
 * the card renders as a badge.
 */
export function useCheckAccountLogin(): UseMutationResult<{ account: AccountT; ok: boolean }, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<{ account: AccountT; ok: boolean }, ApiError, string>({
    mutationFn: (moduleId): Promise<{ account: AccountT; ok: boolean }> =>
      unwrap(
        client.POST('/api/accounts/{moduleId}/login', {
          params: { path: { moduleId } },
        }),
      ),
    onSuccess: (): void => {
      // The login run persists status + cookies — refresh the list view.
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

// ── bulk module enable/disable (FMD2 Websites-tree parity) ──────────

export type ModuleBulkUpdatePageT = operations['bulkUpdateModules']['responses'][200]['content']['application/json'];

export interface ModuleBulkUpdateInput {
  readonly enabled: boolean;
  /** Exact category match (the Settings category-header buttons). */
  readonly category?: string;
  /** Explicit module ids; omit with category for EVERY module. */
  readonly ids?: readonly string[];
}

/** POST /api/modules/bulk — one write over many module_state rows. */
export function useBulkUpdateModules(): UseMutationResult<ModuleBulkUpdatePageT, ApiError, ModuleBulkUpdateInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<ModuleBulkUpdatePageT, ApiError, ModuleBulkUpdateInput>({
    mutationFn: (input): Promise<ModuleBulkUpdatePageT> =>
      unwrap(
        client.POST('/api/modules/bulk', {
          body: {
            enabled: input.enabled,
            ...(input.category !== undefined ? { category: input.category } : {}),
            ...(input.ids !== undefined ? { ids: [...input.ids] } : {}),
          },
        }),
      ),
    onSuccess: (): void => {
      // The picker (and every module-derived view) reflects the new
      // enabled set immediately (react-query cache invalidation).
      void queryClient.invalidateQueries({ queryKey: ['modules'] });
    },
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
  readonly artists?: string;
  readonly summary?: string;
  readonly genres?: readonly string[];
  readonly genresMode?: 'all' | 'any';
  readonly newDays?: number;
  /**
   * [fuzzy-javelin-pearls] Scope selector (D1 §2 ENTER): 'all'
   * (default — zero-network local-index union), 'preferred' (the
   * persisted allowlist), or 'specific' (an explicit sites pick —
   * the tightest scope, wins over the named scope server-side).
   */
  readonly scope?: 'all' | 'preferred' | 'specific';
  /** Ordered explicit site ids (the specific multi-select). */
  readonly sites?: readonly string[];
  readonly limit: number;
  readonly enabled: boolean;
}

/**
 * GET /api/search — the FMD2 cbSearchFromAllSites union: fans out over
 * every installed catalog server-side; `warnings` carry typed partial
 * failures (a broken catalog never fails the page) and `excluded`
 * names enabled sites without a catalog (installed-only semantics).
 * Scope: 'preferred' filters participation to the allowlist (server
 * resolves it); 'specific' sends the explicit sites[] list.
 */
export function useAllSitesSearch(
  input: AllSitesSearchInput,
): UseInfiniteQueryResult<InfiniteData<AllSitesSearchPageT, { cursor?: string }>, ApiError> {
  const client = useApiClient();
  const q = input.q ?? '';
  const status = input.status ?? '';
  const authors = input.authors ?? '';
  const artists = input.artists ?? '';
  const summary = input.summary ?? '';
  const genres = input.genres ?? [];
  const genresMode = input.genresMode ?? 'all';
  const newDays = input.newDays;
  const scope = input.scope ?? 'all';
  const sites = input.sites ?? [];
  return useInfiniteQuery<AllSitesSearchPageT, ApiError, InfiniteData<AllSitesSearchPageT, { cursor?: string }>, QueryKey, { cursor?: string }>({
    queryKey: ['search-all', q, status, authors, artists, summary, genres, genresMode, newDays, scope, sites, input.limit],
    enabled:
      input.enabled &&
      (q !== '' || status !== '' || authors !== '' || artists !== '' || summary !== '' || genres.length > 0 || newDays !== undefined),
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
              ...(artists !== '' ? { artists } : {}),
              ...(summary !== '' ? { summary } : {}),
              ...(genres.length > 0 ? { genres: [...genres] } : {}),
              genresMode,
              ...(newDays !== undefined ? { newDays } : {}),
              // 'specific' never goes on the wire — the server derives
              // it from sites[] (the tightest scope wins); only the
              // named 'preferred' scope is a wire value.
              ...(scope === 'preferred' ? { scope } : {}),
              ...(sites.length > 0 ? { sites: [...sites] } : {}),
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

// ── live-scrape search fan-out (D1 §2 — catalog-less scoped sites) ──

/**
 * Concurrent live sites per fan-out ([fuzzy-javelin-pearls]): one
 * request per site (each site = a distinct origin — per-HOST
 * concurrency is 1 by construction; the server-side §6.8 walk behind
 * each request is single-flight per module + update-lane-gated), and
 * this cross-site cap bounds the burst so a scoped search can never
 * shape into the synchronized fan-out D1's killed-ideas ledger bans.
 */
export const LIVE_FANOUT_CONCURRENCY = 3;

export interface LiveSiteSearchInput {
  /** The catalog-less scoped sites to search (scope order = render order). */
  readonly sites: readonly { readonly id: string; readonly name: string }[];
  readonly q: string;
  readonly limit?: number;
  readonly enabled: boolean;
}

export interface LiveSiteResult {
  readonly siteId: string;
  readonly siteName: string;
  readonly status: 'pending' | 'done' | 'failed';
  readonly entries: readonly CatalogEntryT[];
  /** Failure note (status='failed' only). */
  readonly error?: string;
}

export interface LiveSiteSearchState {
  /** Per-site rows in the GIVEN scope order — progressive by design. */
  readonly perSite: readonly LiveSiteResult[];
  readonly anyPending: boolean;
  readonly totalEntries: number;
}

const EMPTY_LIVE_STATE: LiveSiteSearchState = { perSite: [], anyPending: false, totalEntries: 0 };

/**
 * useLiveSiteSearch — the live-scrape leg of search-with-scope
 * ([fuzzy-javelin-pearls], D1 §2): for CATALOG-LESS sites under an
 * EXPLICIT scope (preferred/specific — never the default all-sites
 * firehose, which stays zero-network), fire one per-site
 * GET /api/catalog/{id}/search per site. That route already serves
 * catalog-less modules from the §6.8 live directory walk (TTL-cached,
 * update-lane-gated), so this hook only ORCHESTRATES:
 *
 * - concurrency-capped: at most {@link LIVE_FANOUT_CONCURRENCY} live
 *   site searches in flight at once (per-host is 1 by construction —
 *   one request per distinct origin);
 * - progressive: each site's row flips pending → done/failed the
 *   moment it resolves and its entries render immediately;
 * - cancellable: navigating away (unmount), or the query/scope
 *   changing, ABORTS every in-flight request (AbortController) —
 *   late results never leak into the next view.
 */
export function useLiveSiteSearch(input: LiveSiteSearchInput): LiveSiteSearchState {
  const client = useApiClient();
  const limit = input.limit ?? 20;
  const siteKey = input.sites.map((s): string => s.id).join(',');
  const [state, setState] = useState<LiveSiteSearchState>(EMPTY_LIVE_STATE);
  const generation = useRef(0);

  useEffect((): (() => void) => {
    const sites = input.sites;
    const q = input.q;
    const myGeneration = generation.current + 1;
    generation.current = myGeneration;
    if (!input.enabled || q === '' || sites.length === 0) {
      setState(EMPTY_LIVE_STATE);
      return (): void => undefined;
    }
    const controller = new AbortController();
    const compatible: AbortSignal | undefined = requestCompatibleSignal(controller.signal);
    const seed: LiveSiteResult[] = sites.map((s): LiveSiteResult => ({
      siteId: s.id,
      siteName: s.name,
      status: 'pending',
      entries: [],
    }));
    setState({ perSite: seed, anyPending: true, totalEntries: 0 });

    const patch = (siteId: string, next: Partial<LiveSiteResult>): void => {
      if (controller.signal.aborted || generation.current !== myGeneration) {
        return;
      }
      setState((prev): LiveSiteSearchState => {
        const perSite = prev.perSite.map((row): LiveSiteResult =>
          row.siteId === siteId ? { ...row, ...next } : row,
        );
        return {
          perSite,
          anyPending: perSite.some((row): boolean => row.status === 'pending'),
          totalEntries: perSite.reduce((acc, row): number => acc + row.entries.length, 0),
        };
      });
    };

    const runOne = async (site: { readonly id: string; readonly name: string }): Promise<void> => {
      try {
        const page = await unwrap(
          client.GET('/api/catalog/{id}/search', {
            params: {
              path: { id: site.id },
              query: { q, limit },
            },
            ...(compatible !== undefined ? { signal: compatible } : {}),
          }),
        );
        patch(site.id, { status: 'done', entries: [...page.entries] });
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          return; // cancelled on navigate — swallow, never render stale
        }
        patch(site.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // Bounded worker pool over the scope-ordered queue.
    const queue = [...sites];
    const workers = Array.from(
      { length: Math.min(LIVE_FANOUT_CONCURRENCY, queue.length) },
      async (): Promise<void> => {
        for (;;) {
          if (controller.signal.aborted) {
            return;
          }
          const site = queue.shift();
          if (site === undefined) {
            return;
          }
          await runOne(site);
        }
      },
    );
    void Promise.all(workers).catch((): void => undefined);

    return (): void => {
      controller.abort();
    };
    // Deps: siteKey carries the fan-out identity (ids + order);
    // q/enabled/limit are primitives; client is stable per provider.
  }, [siteKey, input.q, input.enabled, limit, client]);

  return state;
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
  /** `!`-prefixed custom genres — server-side NOT LIKE excludes. */
  readonly genresExclude?: readonly string[];
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
  const genresExclude = input.genresExclude ?? [];
  const genresMode = input.genresMode ?? 'all';
  const newDays = input.newDays;
  return useInfiniteQuery<CatalogPageT, ApiError, InfiniteData<CatalogPageT, CatalogPageParam>, QueryKey, CatalogPageParam>({
    queryKey: ['catalog', catalogId, mode, q, status, authors, genres, genresExclude, genresMode, newDays, limit],
    enabled: input.enabled && catalogId !== '' && (mode !== 'search' || q !== '' || status !== '' || authors !== '' || genres.length > 0 || genresExclude.length > 0 || newDays !== undefined),
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
                ...(genresExclude.length > 0 ? { genresExclude: [...genresExclude] } : {}),
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

// ── jobs (Downloads, §7.1 + downloads parity) ───────────────────────

/** Downloads-parity list filters (FMD2 tsDownload filter tree + search). */
export interface JobsListFilters {
  /** State multi-select (empty = all states). */
  readonly states: readonly JobStateT[];
  /** Title/chapter substring (FMD2 search box). */
  readonly q: string;
  /** created-at window (inclusive YYYY-MM-DD; FMD2 History windows map in). */
  readonly addedFrom?: string;
  readonly addedTo?: string;
  /**
   * R5 arrival: ISO-timestamp floor on the row's LAST TRANSITION
   * (`updatedAt`) — with states ['done'] the finished-since set the
   * away summary renders. Absent on the Downloads page (back-compat).
   */
  readonly since?: string;
}

export const EMPTY_JOBS_FILTERS: JobsListFilters = { states: [], q: '' };

export function useJobsList(
  filters: JobsListFilters,
  enabled: boolean = true,
): UseInfiniteQueryResult<InfiniteData<JobsPageT, { cursor?: string }>, ApiError> {
  const client = useApiClient();
  // Stable, serialized filter key — the WS feed patches every ['jobs', *]
  // query by prefix, so a richer key stays live-patched.
  const filterKey = JSON.stringify(filters);
  return useInfiniteQuery<JobsPageT, ApiError, InfiniteData<JobsPageT, { cursor?: string }>, QueryKey, { cursor?: string }>({
    queryKey: ['jobs', filterKey],
    enabled,
    initialPageParam: {},
    queryFn: async ({ pageParam }): Promise<JobsPageT> =>
      unwrap(
        client.GET('/api/jobs', {
          params: {
            query: {
              limit: 20,
              ...(filters.states.length > 0 ? { states: filters.states.join(',') } : {}),
              ...(filters.q !== '' ? { q: filters.q } : {}),
              ...(filters.addedFrom !== undefined ? { addedFrom: filters.addedFrom } : {}),
              ...(filters.addedTo !== undefined ? { addedTo: filters.addedTo } : {}),
              ...(filters.since !== undefined ? { since: filters.since } : {}),
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
  /** cbAddAsStopped parity: queued but held until POST /api/jobs/:id/resume. */
  readonly paused?: boolean;
  /** edSaveTo parity: custom finalize directory (replaces library/<manga>). */
  readonly saveTo?: string;
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
            ...(input.paused !== undefined ? { paused: input.paused } : {}),
            ...(input.saveTo !== undefined && input.saveTo !== '' ? { saveTo: input.saveTo } : {}),
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

// ── downloads parity: task actions / delete / bulk (FMD2 pmDownload) ──

/** The typed action union from the generated contract (never hand-written). */
export type JobActionTypeT =
  operations['jobAction']['requestBody']['content']['application/json']['type'];
export type JobBulkActionT =
  operations['jobBulkAction']['requestBody']['content']['application/json']['action'];
export type JobDeletedResponseT =
  operations['deleteJob']['responses'][200]['content']['application/json'];
export type JobBulkActionResponseT =
  operations['jobBulkAction']['responses'][200]['content']['application/json'];

export interface JobActionInput {
  readonly jobId: string;
  readonly type: JobActionTypeT;
}

/**
 * FMD2 pmDownload task action (web-adapted): pause/resume/retry/
 * redownload/enable/disable through the single typed-union route.
 * Illegal applications surface the 409 typed envelope (ApiError).
 */
export function useJobAction(): UseMutationResult<{ job: JobT }, ApiError, JobActionInput> {
  const client = useApiClient();
  return useMutation<{ job: JobT }, ApiError, JobActionInput>({
    mutationFn: async (input): Promise<{ job: JobT }> =>
      unwrap(
        client.POST('/api/jobs/{id}/action', {
          params: { path: { id: input.jobId } },
          body: { type: input.type },
        }),
      ),
  });
}

export interface DeleteJobInput {
  readonly jobId: string;
  /** true = also remove the finalized artifact (delete task + data). */
  readonly data?: boolean;
}

/** FMD2 miDownloadDeleteTask | miDownloadDeleteTaskData parity. */
export function useDeleteJob(): UseMutationResult<JobDeletedResponseT, ApiError, DeleteJobInput> {
  const client = useApiClient();
  return useMutation<JobDeletedResponseT, ApiError, DeleteJobInput>({
    mutationFn: async (input): Promise<JobDeletedResponseT> =>
      unwrap(
        client.DELETE('/api/jobs/{id}', {
          params: {
            path: { id: input.jobId },
            ...(input.data === true ? { query: { data: true } } : {}),
          },
        }),
      ),
  });
}

export interface JobBulkActionInput {
  readonly action: JobBulkActionT;
  readonly scope: 'all' | 'completed';
}

/**
 * FMD2 tsDownload toolbar: Resume all / Pause all (scope `all`) and
 * Delete completed (scope `completed`). Idempotent server-side — a
 * settled queue reports affected: 0.
 */
export function useJobBulkAction(): UseMutationResult<JobBulkActionResponseT, ApiError, JobBulkActionInput> {
  const client = useApiClient();
  return useMutation<JobBulkActionResponseT, ApiError, JobBulkActionInput>({
    mutationFn: async (input): Promise<JobBulkActionResponseT> =>
      unwrap(
        client.POST('/api/jobs/bulk-action', {
          body: { action: input.action, scope: input.scope },
        }),
      ),
  });
}

// ── batch download-all (browse row menu, FMD2 miMangaListDownloadAll) ──

export interface DownloadBatchInput {
  readonly moduleId: string;
  readonly mangaUrl: string;
  readonly mangaTitle?: string;
  /** 'all' (server resolves the live chapter list) or an explicit selection. */
  readonly chapters: 'all' | readonly string[];
  readonly paused?: boolean;
  readonly saveTo?: string;
}

export interface DownloadBatchResult {
  readonly jobs: readonly JobT[];
  readonly replayed: boolean;
}

/**
 * Deterministic batch idempotency key per (module, manga) — FNV-1a of
 * the pair (sync, stable across sessions; the server derives
 * `<key>:<index>` per chapter). A double-click on Download all replays
 * the SAME jobs; a later click chains re-downloads like FMD2 re-adding
 * every task.
 */
export function downloadAllBatchKey(moduleId: string, mangaUrl: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < moduleId.length; i += 1) {
    hash ^= moduleId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  for (let i = 0; i < mangaUrl.length; i += 1) {
    hash ^= mangaUrl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `download-all:${hash.toString(16)}`;
}

/** Batch download-all create: one request per manga, whole-batch replay. */
export function useCreateDownloadBatch(): UseMutationResult<
  DownloadBatchResult,
  ApiError,
  DownloadBatchInput
> {
  const client = useApiClient();
  return useMutation<DownloadBatchResult, ApiError, DownloadBatchInput>({
    mutationFn: async (input): Promise<DownloadBatchResult> => {
      const result = await unwrap(
        client.POST('/api/jobs/download/batch', {
          body: {
            moduleId: input.moduleId,
            mangaUrl: input.mangaUrl,
            chapters: input.chapters === 'all' ? 'all' : [...input.chapters],
            idempotencyKey: downloadAllBatchKey(input.moduleId, input.mangaUrl),
            ...(input.mangaTitle !== undefined && input.mangaTitle !== '' ? { mangaTitle: input.mangaTitle } : {}),
            ...(input.paused !== undefined ? { paused: input.paused } : {}),
            ...(input.saveTo !== undefined && input.saveTo !== '' ? { saveTo: input.saveTo } : {}),
          },
        }),
      );
      return {
        jobs: result.jobs,
        replayed: result.replayed,
      };
    },
  });
}

// ── library (§7.1 listing) ───────────────────────────────────────────

export function useLibrary(
  filter: LibraryFilterT = 'all',
): UseInfiniteQueryResult<InfiniteData<LibraryPageT, { cursor?: string }>, ApiError> {
  const client = useApiClient();
  return useInfiniteQuery<LibraryPageT, ApiError, InfiniteData<LibraryPageT, { cursor?: string }>, QueryKey, { cursor?: string }>({
    queryKey: ['library', filter],
    initialPageParam: {},
    queryFn: async ({ pageParam }): Promise<LibraryPageT> =>
      unwrap(
        client.GET('/api/library', {
          params: {
            query: {
              limit: 50,
              ...(filter !== 'all' ? { filter } : {}),
              ...(pageParam.cursor !== undefined ? { cursor: pageParam.cursor } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage): { cursor?: string } | undefined =>
      lastPage.nextCursor !== undefined ? { cursor: lastPage.nextCursor } : undefined,
  });
}

// ── library file-state (title files, rescan) ────────────────────────

/**
 * [file-state] Per-title Files section data (lazy-verified server
 * truth): chapter file entries + scoped orphans. `refresh` forces the
 * server-side re-verification (?refresh=1 — the explicit-refresh leg
 * of the staleness contract).
 */
export function useTitleFiles(
  moduleId: string | undefined,
  url: string | undefined,
  opts?: { manga?: string; refresh?: boolean },
): UseQueryResult<TitleFilesResponseT, ApiError> {
  const client = useApiClient();
  return useQuery<TitleFilesResponseT, ApiError, TitleFilesResponseT, QueryKey>({
    queryKey: ['title-files', moduleId ?? '', url ?? '', opts?.manga ?? '', opts?.refresh === true],
    enabled: moduleId !== undefined && moduleId !== '' && url !== undefined && url !== '',
    queryFn: async (): Promise<TitleFilesResponseT> =>
      unwrap(
        client.GET('/api/library/title-files', {
          params: {
            query: {
              moduleId: moduleId ?? '',
              url: url ?? '',
              ...(opts?.manga !== undefined && opts.manga !== '' ? { manga: opts.manga } : {}),
              ...(opts?.refresh === true ? { refresh: true } : {}),
            },
          },
        }),
      ),
  });
}

export interface RescanInput {
  readonly moduleId?: string;
  readonly url?: string;
  readonly manga?: string;
}

/**
 * [file-state] 'Rescan library' (omit input) or the per-title variant
 * (moduleId+url): reconciles ledger vs disk server-side and returns
 * the persisted diff report; every file-state cache invalidates.
 */
export function useRescanLibrary(): UseMutationResult<RescanReportT, ApiError, RescanInput | undefined> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<RescanReportT, ApiError, RescanInput | undefined>({
    mutationFn: async (input): Promise<RescanReportT> => {
      const result = await unwrap(
        client.POST('/api/library/rescan', {
          params: {
            query: {
              ...(input?.moduleId !== undefined ? { moduleId: input.moduleId } : {}),
              ...(input?.url !== undefined ? { url: input.url } : {}),
              ...(input?.manga !== undefined ? { manga: input.manga } : {}),
            },
          },
        }),
      );
      return result.report;
    },
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['title-files'] });
      void queryClient.invalidateQueries({ queryKey: ['rescan'] });
    },
  });
}

/** [file-state] the last persisted rescan diff report (null = none). */
export function useLastRescan(): UseQueryResult<RescanReportT | null, ApiError> {
  const client = useApiClient();
  return useQuery<RescanReportT | null, ApiError, RescanReportT | null, QueryKey>({
    queryKey: ['rescan', 'last'],
    queryFn: async (): Promise<RescanReportT | null> =>
      (await unwrap(client.GET('/api/library/rescan'))).report,
  });
}

/** [UX-AUDIT L-2] delete one library artifact (file + row). */
export function useDeleteLibraryFile(): UseMutationResult<{ ok: true }, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, ApiError, string>({
    mutationFn: async (id): Promise<{ ok: true }> =>
      unwrap(client.DELETE('/api/library/{id}', { params: { path: { id } } })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['library'] });
    },
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

export function useFavorites(enabled: boolean = true): UseQueryResult<FavoritesListT, ApiError> {
  const client = useApiClient();
  return useQuery<FavoritesListT, ApiError>({
    queryKey: ['favorites'],
    enabled,
    queryFn: (): Promise<FavoritesListT> => unwrap(client.GET('/api/favorites')),
  });
}

/**
 * R5 arrival: the favorites list WITH the additive `newsSince` flag —
 * `?since=<last-visit stamp>` asks the server which favorites a check
 * touched at/after the stamp with new chapters found. Separate cache
 * entry under the SAME ['favorites'] prefix (check mutations still
 * invalidate it); disabled until a stamp exists.
 */
export function useFavoritesNews(
  since: string | undefined,
  enabled: boolean = true,
): UseQueryResult<FavoritesListT, ApiError> {
  const client = useApiClient();
  return useQuery<FavoritesListT, ApiError>({
    queryKey: ['favorites', 'news', since ?? ''],
    enabled: enabled && since !== undefined,
    queryFn: (): Promise<FavoritesListT> => {
      if (since === undefined) {
        throw new ApiError('favorites news requires a since stamp', 'internal_error', 500);
      }
      return unwrap(client.GET('/api/favorites', { params: { query: { since } } }));
    },
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
  /** Custom save-to directory ('' resets to the default layout). */
  readonly saveTo?: string;
  /** Enable/Disable (disabled rows are skipped by the scheduler). */
  readonly enabled?: boolean;
}

export function useUpdateFavorite(): UseMutationResult<FavoriteT, ApiError, FavoriteUpdateInput> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<FavoriteT, ApiError, FavoriteUpdateInput>({
    mutationFn: async (input): Promise<FavoriteT> => {
      const result = await unwrap(
        client.PUT('/api/favorites/{id}', {
          params: { path: { id: input.id } },
          body: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.autoDownload !== undefined ? { autoDownload: input.autoDownload } : {}),
            ...(input.saveTo !== undefined ? { saveTo: input.saveTo } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          },
        }),
      );
      return result.favorite;
    },
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
}

export function useDeleteFavorite(): UseMutationResult<{ ok: true }, ApiError, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<{ ok: true }, ApiError, string>({
    mutationFn: async (id): Promise<{ ok: true }> =>
      unwrap(client.DELETE('/api/favorites/{id}', { params: { path: { id } } })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
}

export function useCheckFavoriteNow(): UseMutationResult<FavoriteCheckT, ApiError, string> {
  const client = useApiClient();
  return useMutation<FavoriteCheckT, ApiError, string>({
    mutationFn: (id): Promise<FavoriteCheckT> =>
      unwrap(client.POST('/api/favorites/{id}/check', { params: { path: { id } } })),
  });
}

// ── favorites batch check + transfer (favorites-parity, additive) ───

export type FavoriteCheckBatchT =
  operations['checkFavoritesBatch']['responses'][200]['content']['application/json'];
export type FavoriteCheckBatchItemT = FavoriteCheckBatchT['results'][number];
export type FavoriteCheckScopeT = FavoriteCheckBatchT['scope'];
export type FavoriteTransferPreviewT =
  operations['previewFavoriteTransfer']['responses'][200]['content']['application/json'];

/**
 * The toolbar batch check (btFavoritesCheckNewChapter parity): one
 * scope-scoped sweep returning per-row DoCheck results — the rows with
 * new chapters feed the NewChaptersSheet decision UI.
 */
export function useFavoritesCheckBatch(): UseMutationResult<
  FavoriteCheckBatchT,
  ApiError,
  FavoriteCheckScopeT
> {
  const client = useApiClient();
  return useMutation<FavoriteCheckBatchT, ApiError, FavoriteCheckScopeT>({
    mutationFn: (scope): Promise<FavoriteCheckBatchT> =>
      unwrap(client.POST('/api/favorites/check', { body: { scope } })),
  });
}

/** miFavoritesStopCheckNewChapter parity — stop the in-flight sweep. */
export function useCancelFavoritesCheck(): UseMutationResult<
  { cancelled: boolean },
  ApiError,
  void
> {
  const client = useApiClient();
  return useMutation<{ cancelled: boolean }, ApiError, void>({
    mutationFn: (): Promise<{ cancelled: boolean }> =>
      unwrap(client.POST('/api/favorites/check/cancel')),
  });
}

/** The transfer dialog's valid/invalid mapping preview. */
export function useTransferPreview(): UseMutationResult<
  FavoriteTransferPreviewT,
  ApiError,
  { id: string; targetModuleId: string }
> {
  const client = useApiClient();
  return useMutation<FavoriteTransferPreviewT, ApiError, { id: string; targetModuleId: string }>({
    mutationFn: async (input): Promise<FavoriteTransferPreviewT> =>
      unwrap(
        client.POST('/api/favorites/{id}/transfer/preview', {
          params: { path: { id: input.id } },
          body: { targetModuleId: input.targetModuleId },
        }),
      ),
  });
}

export interface FavoriteTransferInput {
  readonly id: string;
  readonly targetModuleId: string;
  readonly clearDownloadedList: boolean;
}

/** Apply the website transfer (remap; optional clear-and-reload). */
export function useTransferFavorite(): UseMutationResult<
  { favorite: FavoriteT; reloadedFromServer: boolean },
  ApiError,
  FavoriteTransferInput
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<
    { favorite: FavoriteT; reloadedFromServer: boolean },
    ApiError,
    FavoriteTransferInput
  >({
    mutationFn: async (input): Promise<{ favorite: FavoriteT; reloadedFromServer: boolean }> =>
      unwrap(
        client.POST('/api/favorites/{id}/transfer', {
          params: { path: { id: input.id } },
          body: {
            targetModuleId: input.targetModuleId,
            clearDownloadedList: input.clearDownloadedList,
          },
        }),
      ),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
}

/** PUT /api/settings/favorites — check interval (minutes) + startup toggle. */
export function useUpdateFavoritesSchedulerSettings(): UseMutationResult<
  SettingsT,
  ApiError,
  { intervalMinutes: number; checkAtStartup: boolean }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<SettingsT, ApiError, { intervalMinutes: number; checkAtStartup: boolean }>({
    mutationFn: (input): Promise<SettingsT> =>
      unwrap(client.PUT('/api/settings/favorites', { body: input })),
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

// ── MangaPage parity state (FMD2 info-pane hooks) ───────────────────

export interface FavoriteState {
  /** The matching favorite row id (LowerCase(ModuleID+Link)), undefined when absent. */
  readonly favoriteId: string | undefined;
  readonly isFavorited: boolean;
  readonly isMutating: boolean;
  readonly error: ApiError | null;
  /** Add via the existing create hook (initial check server-side). */
  add: (input: { title?: string; autoDownload?: boolean }) => Promise<void>;
  /** Remove the matching favorite (no-op when not favorited). */
  remove: () => Promise<void>;
}

/**
 * Membership + toggle for ONE manga (the btAddToFavorites parity
 * state): derives favorited-ness from the favorites LIST (match on
 * moduleId+url — the id is LowerCase(ModuleID+Link) server-side) and
 * round-trips through the EXISTING create/delete hooks, invalidating
 * the list so every mount reflects membership immediately.
 */
export function useFavoriteState(moduleId: string, url: string): FavoriteState {
  const queryClient = useQueryClient();
  // Membership lookup only when a manga is actually addressed (the
  // no-selection branch of the page fires no requests at all).
  const favorites = useFavorites(moduleId !== '' && url !== '');
  const createFavorite = useCreateFavorite();
  const deleteFavorite = useDeleteFavorite();
  const match = favorites.data?.favorites.find(
    (f): boolean => f.moduleId === moduleId && f.url === url,
  );
  return {
    favoriteId: match?.id,
    isFavorited: match !== undefined,
    isMutating: createFavorite.isPending || deleteFavorite.isPending,
    error: createFavorite.error ?? deleteFavorite.error ?? null,
    add: async (input): Promise<void> => {
      await createFavorite.mutateAsync({
        moduleId,
        url,
        ...(input.title !== undefined && input.title !== '' ? { title: input.title } : {}),
        ...(input.autoDownload !== undefined ? { autoDownload: input.autoDownload } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
    remove: async (): Promise<void> => {
      if (match === undefined) return;
      await deleteFavorite.mutateAsync(match.id);
      await queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  };
}

/**
 * The downloaded-chapter link set for one manga — the InfoResponse's
 * embedded `downloaded` array (the §9 ledger projection, computed
 * per response server-side) normalized into the case-insensitive
 * membership set the chapter-view state machine consumes.
 */
export function useDownloadedSet(
  info: UseQueryResult<InfoResponseT, ApiError>,
): ReadonlySet<string> {
  const links = info.data?.downloaded ?? [];
  const set = new Set<string>();
  for (const link of links) {
    set.add(link.toLowerCase());
  }
  return set;
}
