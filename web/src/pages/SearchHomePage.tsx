/**
 * SearchHomePage (search-first home, R5 web-native IA): the DEFAULT
 * `#/browse` state — the primary job ("I want to read X") starts at a
 * SEARCH box, not a 454-row site combobox. Recomposition only: the
 * union search API (GET /api/search — every installed catalog at
 * once), the Website badge per row, the per-site facet chips and the
 * module registry already exist; this page arranges them as the home.
 *
 *   typing        → as-you-type union results (debounced like the site
 *                   view; q URL-REPLACED while typing — shareable, no
 *                   history spam)
 *   facet chip    → narrows into that site's browse context carrying q
 *   row click     → the manga page (unchanged deep link)
 *   Browse sites  → the full site picker one tap away (`?sites=1`;
 *                   site-first stays the secondary mode for FMD2
 *                   refugees — `?site=`/`?catalog=` deep links are
 *                   untouched)
 *   empty (q='')  → Recent sites + Recent manga rows (localStorage,
 *                   capped/deduped/clearable — shared with the palette)
 *                   and category quick-chips into the picker
 *
 * '/' focuses this input from anywhere (state/search-focus bus); Esc
 * blurs. The kbd affordance label is desktop-only (R3: mobile reaches
 * search via the always-visible input).
 */
import { useEffect, useMemo, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import { LayoutGrid, Loader2, Radio, Search, X } from 'lucide-react';
import type { Route } from '../router';
import { navigate, navigateToManga, replaceRoute } from '../router';
import { useRoute } from '../state/use-route';
import {
  useAllSitesSearch,
  useLiveSiteSearch,
  useModules,
  usePreferredSites,
  type CatalogEntryT,
  type SearchEntryT,
} from '../api/hooks';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../state/use-catalog-query';
import {
  liveSearchCandidates,
  parseSearchScope,
  serializeSearchScope,
  type SearchScopeState,
} from '../state/search-scope-state';
import { useHighlightNew } from '../state/highlight-new';
import {
  clearRecentManga,
  clearRecentSites,
  useRecentManga,
  useRecentSites,
} from '../state/recents';
import {
  consumeSearchFocusRequest,
  subscribeSearchFocus,
} from '../state/search-focus';
import { categoryFacets } from './SitePickerPage';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { AwaySummaryCard } from '@/components/patterns/AwaySummaryCard';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatPill } from '@/components/patterns/StatPill';
import { CatalogEntryRow } from '@/components/catalog/CatalogEntryRow';
import { PasteUrlAdd } from '@/components/catalog/PasteUrlAdd';
import { ScopeSelector, type PreferredRow } from '@/components/catalog/ScopeSelector';
import { WebsiteBadge } from '@/components/catalog/WebsiteBadge';
import { FacetChips, UnionExcludedChips, UnionWarningChips } from '@/components/catalog/UnionSearchChips';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_LIMIT = 20;
/** Category quick-chips in the empty state (top languages by size). */
const QUICK_CHIP_COUNT = 8;

export const HOME_SEARCH_INPUT_ID = 'home-search';

function focusHomeSearch(): void {
  globalThis.document?.getElementById(HOME_SEARCH_INPUT_ID)?.focus();
}

function UnionRow(props: { entry: SearchEntryT; highlightNew: boolean }): ReactElement {
  const { entry } = props;
  return (
    <CatalogEntryRow
      entry={entry}
      siteId={entry.site}
      highlightNew={props.highlightNew}
      badges={<WebsiteBadge siteName={entry.siteName} siteId={entry.site} />}
      website={entry.siteName}
    />
  );
}

/**
 * [fuzzy-javelin-pearls] The live-scrape leg's PROGRESSIVE results:
 * one group per catalog-less scoped site, rendered in scope order —
 * each group flips pending → entries/failed the moment its site
 * resolves (never a blocking spinner over the whole fan-out; groups
 * that finish early render early). Cancelling on navigate is the
 * hook's job (AbortController); a cancelled group simply stops
 * updating.
 */
function LiveResultsSection(props: {
  readonly live: ReturnType<typeof useLiveSiteSearch>;
}): ReactElement {
  const { live } = props;
  const [highlightNew] = useHighlightNew();
  return (
    <section
      aria-label="Live results from sites without an installed catalog"
      className="mt-6"
      data-testid="live-results"
      data-live-pending={live.anyPending ? 'true' : 'false'}
    >
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Radio aria-hidden="true" className="size-4 text-muted-foreground" />
        Live results
        {live.anyPending ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />
        ) : null}
        <span className="font-normal text-muted-foreground">
          {String(live.totalEntries)} entr{live.totalEntries === 1 ? 'y' : 'ies'} · searched
          one site at a time, results appear as each site answers
        </span>
      </h2>
      {live.perSite.map(
        (row): ReactElement => (
          <div key={row.siteId} className="mb-4" data-live-site={row.siteId} data-live-status={row.status}>
            <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <WebsiteBadge siteName={row.siteName} siteId={row.siteId} />
              {row.status === 'pending' ? (
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              ) : null}
              {row.status === 'failed' ? (
                <span className="normal-case text-destructive">failed — {row.error ?? 'unreachable'}</span>
              ) : null}
            </h3>
            {row.status === 'done' && row.entries.length > 0 ? (
              <ListPanel
                className="catalog-list"
                ariaLabel={`Live results from ${row.siteName}`}
                items={[...row.entries]}
                itemKey={(entry: CatalogEntryT): string => `${row.siteId}-${entry.link}`}
                renderItem={(entry: CatalogEntryT): ReactElement => (
                  <CatalogEntryRow
                    entry={entry}
                    siteId={row.siteId}
                    highlightNew={highlightNew}
                    website={row.siteName}
                  />
                )}
              />
            ) : null}
            {row.status === 'done' && row.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matches.</p>
            ) : null}
          </div>
        ),
      )}
    </section>
  );
}

/** A recents row: label + chips + Clear (home owns the affordance —
 * the palette consumes the same store). */
function RecentSitesRow(props: { sites: readonly { readonly id: string; readonly name: string }[] }): ReactElement {
  return (
    <div data-testid="recent-sites" className="mb-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Recent sites</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          aria-label="Clear recent sites"
          onClick={(): void => {
            clearRecentSites();
          }}
        >
          Clear
        </Button>
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {props.sites.map((site): ReactElement => (
          <li key={site.id}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-3"
              onClick={(): void => {
                navigate('browse', { site: site.id });
              }}
            >
              {site.name}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentMangaRow(props: {
  manga: readonly {
    readonly moduleId: string;
    readonly url: string;
    readonly title: string;
    readonly catalogId?: string;
  }[];
}): ReactElement {
  return (
    <div data-testid="recent-manga" className="mb-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Recent manga</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          aria-label="Clear recent manga"
          onClick={(): void => {
            clearRecentManga();
          }}
        >
          Clear
        </Button>
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {props.manga.map((manga): ReactElement => (
          <li key={`${manga.moduleId}-${manga.url}`}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 max-w-64 rounded-full px-3"
              onClick={(): void => {
                navigateToManga({
                  module: manga.moduleId,
                  url: manga.url,
                  title: manga.title,
                  ...(manga.catalogId !== undefined ? { catalog: manga.catalogId } : {}),
                });
              }}
            >
              <span className="truncate">{manga.title}</span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The category quick-chips (top languages by site count) — extracted
 * so the idle EmptyState and the recents-compact variant share them. */
function CategoryQuickChips(props: {
  readonly categories: readonly { readonly category: string; readonly count: number }[];
}): ReactElement {
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-center gap-1.5"
      aria-label="Categories"
      data-testid="category-quick-chips"
    >
      {props.categories.map((facet): ReactElement => (
        <Button
          key={facet.category}
          type="button"
          variant="secondary"
          size="sm"
          className="h-7 rounded-full px-3"
          aria-label={`Browse ${facet.category} sites`}
          onClick={(): void => {
            // Quick-chip = the picker pre-filtered to the category
            // (existing ?cats= param).
            navigate('browse', { sites: '1', cats: facet.category });
          }}
        >
          {facet.category}
        </Button>
      ))}
    </div>
  );
}

export function SearchHomePage(props: { route: Route }): ReactElement {
  // The live hash is the truth (App owns routing; this subscription
  // keeps q pure under replaceState typing + back/forward).
  const route: Route = useRoute(props.route);
  const q: string = route.query['q'] ?? '';
  // [fuzzy-javelin-pearls] scope state rides the same URL (absent =
  // all sites — the pre-scope URL shape keeps meaning "all").
  const scopeState: SearchScopeState = parseSearchScope(route.query);

  const debouncedQ: string = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
  const pages = useAllSitesSearch({
    q: debouncedQ,
    limit: PAGE_LIMIT,
    enabled: true,
    scope: scopeState.scope,
    sites: scopeState.scope === 'specific' ? scopeState.picks : [],
  });
  const [highlightNew] = useHighlightNew();
  const recentSites = useRecentSites();
  const recentManga = useRecentManga();
  const modules = useModules();
  const preferred = usePreferredSites();

  // The registry join feeding the selector: the allowlist in CANONICAL
  // order (D1 §3), names + availability hint state from /api/modules.
  const registry = modules.data?.modules ?? [];
  const preferredOrder = preferred.data?.sites ?? [];
  const preferredRows = useMemo(
    (): readonly PreferredRow[] =>
      preferredOrder.flatMap((id): PreferredRow[] => {
        const module = registry.find((m): boolean => m.id === id);
        if (module === undefined) {
          return [];
        }
        return [
          {
            id,
            name: module.name,
            unreachable: module.availability.status === 'unreachable',
          },
        ];
      }),
    [preferredOrder, registry],
  );

  // Live-scrape leg: catalog-less sites under an EXPLICIT scope only
  // (scope=all stays zero-network — its catalog-less sites surface as
  // the excluded chips instead), capped, progressive, cancelled on
  // navigate by the hook's AbortController.
  const liveSites = useMemo(
    (): readonly { readonly id: string; readonly name: string }[] =>
      liveSearchCandidates(
        scopeState,
        preferredOrder,
        registry.map((m): {
          readonly id: string;
          readonly name: string;
          readonly enabled: boolean;
          readonly catalogInstalled: boolean;
          readonly liveCapable: boolean;
        } => ({
          id: m.id,
          name: m.name,
          enabled: m.enabled,
          catalogInstalled: m.catalogInstalled,
          liveCapable: m.capabilities.live_scrape_fallback,
        })),
      ),
    [scopeState, preferredOrder, registry],
  );
  const live = useLiveSiteSearch({
    sites: liveSites,
    q: debouncedQ,
    enabled: scopeState.scope !== 'all' && debouncedQ !== '',
  });

  // '/' focus channel: a request that navigated here first is pending
  // at mount; later requests (already on the home) arrive as events.
  useEffect((): (() => void) => {
    const maybeFocus = (): void => {
      if (consumeSearchFocusRequest()) {
        focusHomeSearch();
      }
    };
    maybeFocus();
    return subscribeSearchFocus(maybeFocus);
  }, []);

  const entries: SearchEntryT[] =
    pages.data?.pages.flatMap((page): SearchEntryT[] => [...page.entries]) ?? [];
  const lastPage = pages.data?.pages.at(-1);
  const facets = lastPage?.facets ?? [];
  const warnings = lastPage?.warnings ?? [];
  const excluded = lastPage?.excluded ?? [];
  const total: number | undefined = useMemo((): number | undefined => {
    const counts = facets.map((f): number => f.count ?? 0);
    return counts.length > 0 ? counts.reduce((a, b): number => a + b, 0) : undefined;
  }, [facets]);

  // Category quick-chips: the registry's top languages by site count
  // (stable registry facets — never per-query).
  const quickCategories = useMemo(
    (): readonly { readonly category: string; readonly count: number }[] =>
      [...categoryFacets(modules.data?.modules ?? [])]
        .sort((a, b): number => b.count - a.count)
        .slice(0, QUICK_CHIP_COUNT),
    [modules.data],
  );

  const writeQ = (text: string): void => {
    // Typing REPLACES the URL entry (shareable, no history spam) and
    // PRESERVES the scope params — typing narrows within the scope.
    const scopeParams = serializeSearchScope(scopeState);
    if (text === '') {
      replaceRoute('browse', { ...scopeParams });
    } else {
      replaceRoute('browse', { q: text, ...scopeParams });
    }
  };

  // A scope change is a DISCRETE mode change → PUSH (back/forward
  // restore the selector); q rides along unchanged.
  const onScopeChange = (next: SearchScopeState): void => {
    navigate('browse', {
      ...(q !== '' ? { q } : {}),
      ...serializeSearchScope(next),
    });
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.currentTarget.blur();
    }
  };

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault(); // live results; submit only keeps focus stable
  };

  const idle = q === '';

  return (
    <section aria-label="Search home" data-search-home={idle ? 'idle' : 'results'}>
      <PageHeader
        title="Browse"
        description="Search every installed site at once, or browse sites by name."
      />

      {/* R5 arrival: the 'While you were away' summary renders above
       * the fold ONLY when the previous visit is ≥ 1 h stale AND the
       * server has news since (self-nulling otherwise). */}
      <AwaySummaryCard />

      <div className="search-hero mx-auto mb-6 max-w-2xl">
        <form onSubmit={onSearchSubmit}>
          <label htmlFor={HOME_SEARCH_INPUT_ID} className="mb-1.5 block text-sm font-medium">
            {scopeState.scope === 'all'
              ? 'Search all sites'
              : scopeState.scope === 'preferred'
                ? 'Search preferred sites'
                : 'Search picked sites'}
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={HOME_SEARCH_INPUT_ID}
              name="q"
              type="search"
              className="h-12 pr-20 pl-10 text-base"
              placeholder="Title, summary, genres…"
              value={q}
              onChange={(e): void => {
                writeQ(e.target.value);
              }}
              onKeyDown={onSearchKeyDown}
            />
            {/* Desktop-only affordance label (R3: mobile reaches search
                via the always-visible input — no keyboard-only path). */}
            <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 items-center rounded border bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-foreground md:inline-flex">
              /
            </kbd>
          </div>
        </form>
        {/* [fuzzy-javelin-pearls] the scope selector rides under the
         * search box — all (default, zero network) / preferred (the
         * allowlist) / specific (explicit picks). */}
        <div className="mt-3">
          <ScopeSelector
            scope={scopeState.scope}
            picks={scopeState.picks}
            preferred={preferredRows}
            registry={registry}
            onChange={onScopeChange}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-label="Browse sites: the full site picker"
            onClick={(): void => {
              navigate('browse', { sites: '1' });
            }}
          >
            <LayoutGrid aria-hidden="true" />
            Browse sites
          </Button>
          {pages.isFetching && !idle ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              <Loader2 aria-hidden="true" className="mr-1 inline size-3.5 animate-spin align-[-2px]" />
              Searching every installed catalog…
            </p>
          ) : null}
        </div>
      </div>

      {/* [crystal-nectar-pricks] D1 §2 ENTER: paste-URL — the
       * universal front door (always on the search home; the palette's
       * Add-by-URL action arms this box). */}
      <PasteUrlAdd />

      {idle ? (
        <>
          {recentSites.length > 0 ? <RecentSitesRow sites={recentSites} /> : null}
          {recentManga.length > 0 ? <RecentMangaRow manga={recentManga} /> : null}
          {/* [UX-AUDIT H-2] with recents on screen the empty-state prose
           * collapses to one line — no double-height filler on first
           * paint; the full teaching copy shows only for a fresh user. */}
          {recentSites.length > 0 || recentManga.length > 0 ? (
            <div
              className="mx-auto max-w-2xl rounded-xl border border-dashed border-border bg-surface/40 px-6 py-4 text-center"
              data-testid="idle-compact"
            >
              <p className="text-sm text-muted-foreground">
                Type a title to search every installed site, or start from a category:
              </p>
              <CategoryQuickChips categories={quickCategories} />
            </div>
          ) : (
            <EmptyState title="What do you want to read?">
              <p>
                Type a title; the search runs over every installed site catalog at once and each
                result shows the website it came from. New here? Start from a category:
              </p>
              <p>
                The <a className="underline underline-offset-4 max-md:inline-flex max-md:min-h-touch-target max-md:items-center" href="docs/USER-GUIDE.md#finding-manga">finding-manga walkthrough</a> covers search, the site picker, filters and shareable URLs.
              </p>
              <CategoryQuickChips categories={quickCategories} />
            </EmptyState>
          )}
        </>
      ) : (
        <>
          {pages.isError ? <ErrorBanner error={pages.error} /> : null}
          {pages.isPending ? (
            // [UX-AUDIT H-1] skeleton rows while the union search runs —
            // same EntryRow sizing (min-h-row + px-3 py-2) so the result
            // list never pops in under the StatPill count.
            <div
              role="status"
              aria-live="polite"
              aria-label="Searching every installed catalog"
              data-testid="search-skeleton"
              className="catalog-list overflow-hidden rounded-lg border"
            >
              {Array.from({ length: 5 }, (_, i): ReactElement => (
                <div key={i} className="flex min-h-row items-center gap-3 px-3 py-2">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-1/5" />
                  <Skeleton className="ml-auto h-3 w-14" />
                </div>
              ))}
            </div>
          ) : null}

          <UnionWarningChips warnings={warnings} />
          <UnionExcludedChips excluded={excluded} />
          <FacetChips
            facets={facets}
            onPickSite={(siteId): void => {
              // Chip click narrows into that site's browse context
              // carrying the query (site-scoped search).
              navigate('browse', { site: siteId, q });
            }}
          />

          {entries.length > 0 ? (
            <>
              <p role="status" className="mb-2">
                <StatPill>
                  Showing {entries.length}
                  {total !== undefined ? ` of ${total}` : ''} entries across {facets.length} site
                  {facets.length === 1 ? '' : 's'}
                </StatPill>
              </p>
              <ListPanel
                className="catalog-list"
                ariaLabel="Search results"
                items={entries}
                itemKey={(entry): string => `${entry.site}-${entry.link}`}
                renderItem={(entry): ReactElement => <UnionRow entry={entry} highlightNew={highlightNew} />}
              />
              {pages.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4"
                  onClick={(): void => {
                    pages.fetchNextPage();
                  }}
                  disabled={pages.isFetchingNextPage}
                >
                  {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
            </>
          ) : null}

          {live.perSite.length > 0 ? <LiveResultsSection live={live} /> : null}

          {!pages.isPending && entries.length === 0 && !pages.isError ? (
            <EmptyState title="No entries">
              <p>No installed site catalog matched this query.</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={(): void => {
                  writeQ('');
                }}
              >
                <X aria-hidden="true" />
                Clear search
              </Button>
            </EmptyState>
          ) : null}
        </>
      )}
    </section>
  );
}
