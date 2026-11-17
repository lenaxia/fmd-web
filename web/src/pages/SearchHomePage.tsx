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
import { LayoutGrid, Loader2, Search, X } from 'lucide-react';
import type { Route } from '../router';
import { navigate, replaceRoute } from '../router';
import { useRoute } from '../state/use-route';
import { useAllSitesSearch, useModules, type SearchEntryT } from '../api/hooks';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../state/use-catalog-query';
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
import { WebsiteBadge } from '@/components/catalog/WebsiteBadge';
import { FacetChips, UnionExcludedChips, UnionWarningChips } from '@/components/catalog/UnionSearchChips';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
                navigate('manga', {
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

export function SearchHomePage(props: { route: Route }): ReactElement {
  // The live hash is the truth (App owns routing; this subscription
  // keeps q pure under replaceState typing + back/forward).
  const route: Route = useRoute(props.route);
  const q: string = route.query['q'] ?? '';

  const debouncedQ: string = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
  const pages = useAllSitesSearch({ q: debouncedQ, limit: PAGE_LIMIT, enabled: true });
  const [highlightNew] = useHighlightNew();
  const recentSites = useRecentSites();
  const recentManga = useRecentManga();
  const modules = useModules();

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
    // Typing REPLACES the URL entry (shareable, no history spam).
    if (text === '') {
      replaceRoute('browse', {});
    } else {
      replaceRoute('browse', { q: text });
    }
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
            Search all sites
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
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-label="Browse sites — the full site picker"
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

      {idle ? (
        <>
          {recentSites.length > 0 ? <RecentSitesRow sites={recentSites} /> : null}
          {recentManga.length > 0 ? <RecentMangaRow manga={recentManga} /> : null}
          <EmptyState title="What do you want to read?">
            <p>
              Type a title — the search runs over every installed site catalog at once and each
              result shows the website it came from. New here? Start from a category:
            </p>
            <div
              className="mt-3 flex flex-wrap items-center justify-center gap-1.5"
              aria-label="Categories"
              data-testid="category-quick-chips"
            >
              {quickCategories.map((facet): ReactElement => (
                <Button
                  key={facet.category}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-7 rounded-full px-3"
                  aria-label={`Browse ${facet.category} sites`}
                  onClick={(): void => {
                    // Quick-chip = the picker pre-filtered to the
                    // category (existing ?cats= param).
                    navigate('browse', { sites: '1', cats: facet.category });
                  }}
                >
                  {facet.category}
                </Button>
              ))}
            </div>
          </EmptyState>
        </>
      ) : (
        <>
          {pages.isError ? <ErrorBanner error={pages.error} /> : null}
          {pages.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Searching every installed catalog…
            </p>
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
