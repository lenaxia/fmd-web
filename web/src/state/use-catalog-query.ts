/**
 * useCatalogQuery (tsk-savvy-jockey-ambles, LLD): the ONE hook unifying
 * latest/title/search modes over the browse filter state.
 *
 * - Debounce (250 ms trailing): the as-you-type fetch guard, adapted
 *   from FMD2's TSearchDBThread (frmMain.pas:1114) — a single worker
 *   coalesces keystrokes by re-reading the LATEST string, so
 *   intermediate results are never fetched. Filter changes bypass the
 *   debounce (FMD2 applies the Filter panel as a discrete action).
 * - In-flight abort (anti-spam guard #2, FMD2 NewSearch parity):
 *   every state change immediately cancels the site's in-flight
 *   catalog queries via the query client (react-query aborts the
 *   AbortSignal wired through useCatalogEntries' queryFn), so a
 *   superseded request never lands.
 * - Unchanged-state skip (guard #3, FMD2's `LastSearchStr` check):
 *   react-query's key equality already no-ops identical states.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CatalogMode, CatalogQueryInput } from '../api/hooks';
import { useCatalogEntries } from '../api/hooks';
import {
  apiGenres,
  apiGenresExclude,
  hasActiveFilters,
  type BrowseFilterState,
} from './browse-filter-state';

export const SEARCH_DEBOUNCE_MS = 250;

/**
 * Trailing debounce: returns `value` after it stayed stable for
 * `delayMs` (clock injectable for tests). The INITIAL value is emitted
 * immediately — mounting with a shared URL must fetch without waiting.
 */
export function useDebouncedValue<T>(value: T, delayMs: number, clock: { now: () => number; setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (id: number) => void } = { now: (): number => Date.now(), setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (id) => window.clearTimeout(id) }): T {
  const [debounced, setDebounced] = useState<T>(value);
  const timer: { current: number | undefined } = useRef(undefined);
  useEffect((): (() => void) => {
    if (value === debounced) {
      return (): void => undefined;
    }
    timer.current = clock.setTimeout((): void => {
      timer.current = undefined;
      setDebounced(value);
    }, delayMs);
    return (): void => {
      if (timer.current !== undefined) {
        clock.clearTimeout(timer.current);
        timer.current = undefined;
      }
    };
  }, [value, delayMs, debounced, clock]);
  return debounced;
}

/** The resolved query mode for a filter state + selected view tab. */
export function resolveMode(state: BrowseFilterState, view: 'latest' | 'title'): CatalogMode {
  return hasActiveFilters(state) ? 'search' : view;
}

/**
 * The unified catalog query. `state` is the URL-synced filter state;
 * `view` picks the browse tab when no search/filter is active. The
 * returned pages are a PURE function of (site, state, view).
 */
export function useCatalogQuery(
  siteId: string,
  state: BrowseFilterState,
  options: { readonly view: 'latest' | 'title'; readonly enabled: boolean; readonly limit?: number },
): {
  /** Mode actually queried (search whenever any filter is active). */
  readonly mode: CatalogMode;
  /** The debounced q actually fetched (for the count/mode label). */
  readonly q: string;
  readonly pages: ReturnType<typeof useCatalogEntries>;
} {
  const queryClient = useQueryClient();
  const debouncedQ: string = useDebouncedValue(state.q, SEARCH_DEBOUNCE_MS);
  const mode: CatalogMode = resolveMode(state, options.view);
  const limit: number = options.limit ?? 20;

  // In-flight cancel on ANY state change (pre-debounce — the guard is
  // about not landing superseded work, not about saving requests).
  const cancelKey: string = JSON.stringify([siteId, state]);
  useEffect((): void => {
    if (siteId !== '') {
      void queryClient.cancelQueries({ queryKey: ['catalog', siteId] });
    }
  }, [queryClient, siteId, cancelKey]);

  const genres: readonly string[] = apiGenres(state);
  const genresExclude: readonly string[] = apiGenresExclude(state);
  const active: boolean = mode === 'search';
  const pages = useCatalogEntries({
    catalogId: siteId,
    mode,
    limit,
    enabled: options.enabled && siteId !== '',
    ...(active
      ? {
          q: debouncedQ,
          ...(state.status !== '' ? { status: state.status } : {}),
          ...(state.authors !== '' ? { authors: state.authors } : {}),
          ...(state.artists !== '' ? { artists: state.artists } : {}),
          ...(state.summary !== '' ? { summary: state.summary } : {}),
          ...(genres.length > 0 ? { genres } : {}),
          ...(genresExclude.length > 0 ? { genresExclude } : {}),
          genresMode: state.genresMode,
          ...(state.newDays !== undefined ? { newDays: state.newDays } : {}),
        }
      : {}),
  } satisfies CatalogQueryInput);

  return { mode, q: debouncedQ, pages };
}
