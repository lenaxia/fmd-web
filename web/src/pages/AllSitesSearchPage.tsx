/**
 * AllSitesSearchPage (FMD2 cbSearchFromAllSites parity): the union
 * search view behind `#/browse?allsites=1` — queries every INSTALLED
 * catalog simultaneously (GET /api/search), shows a Website badge on
 * every row (frmMain.pas:5170), per-site count facet chips, typed
 * warning chips for catalogs that failed, and no-catalog chips for
 * excluded sites. Row clicks deep-link into that site's manga context
 * (unchanged from the site-scoped flow). A LOCAL catalog union —
 * never live scraping (FMD2 parity).
 *
 * The filter state is URL-synced like the site view: typing REPLACES
 * (shareable, no history spam), the toggle PUSHES.
 */
import { useMemo, type ReactElement } from 'react';
import type { Route } from '../router';
import { navigate, replaceRoute } from '../router';
import { useRoute } from '../state/use-route';
import { useAllSitesSearch, type SearchEntryT } from '../api/hooks';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '../state/use-catalog-query';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { FilterBar } from '@/components/patterns/FilterBar';
import { ListPanel } from '@/components/patterns/ListPanel';
import { EntryRow } from '@/components/patterns/EntryRow';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatPill } from '@/components/patterns/StatPill';
import { AllSitesToggle } from '@/components/catalog/AllSitesToggle';
import { SearchBar } from '@/components/catalog/SearchBar';
import { WebsiteBadge } from '@/components/catalog/WebsiteBadge';
import { FacetChips, UnionExcludedChips, UnionWarningChips } from '@/components/catalog/UnionSearchChips';
import { Button } from '@/components/ui/button';

const PAGE_LIMIT = 20;

function UnionRow(props: { entry: SearchEntryT }): ReactElement {
  const { entry } = props;
  const open = (): void => {
    // Unchanged manga deep-link — the site params carry the union row
    // into its source site's context.
    navigate('manga', {
      catalog: entry.site,
      module: entry.site,
      url: entry.link,
      title: entry.title,
    });
  };
  return (
    <EntryRow
      onClick={open}
      buttonClassName="catalog-entry union-entry"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="entry-title">{entry.title}</span>
          <WebsiteBadge siteName={entry.siteName} siteId={entry.site} />
        </span>
      }
      meta={
        <span className="entry-meta">
          {entry.authors !== '' ? entry.authors : 'unknown author'} · {entry.status} · {entry.numChapter} chapters
        </span>
      }
    />
  );
}

export function AllSitesSearchPage(props: { route: Route }): ReactElement {
  const route: Route = useRoute(props.route);
  const q: string = route.query['q'] ?? '';

  const debouncedQ: string = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
  const pages = useAllSitesSearch({ q: debouncedQ, limit: PAGE_LIMIT, enabled: true });

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

  const writeQ = (text: string, replace: boolean): void => {
    const query: Record<string, string> = { allsites: '1' };
    if (text !== '') {
      query['q'] = text;
    }
    if (replace) {
      replaceRoute('browse', query);
    } else {
      navigate('browse', query);
    }
  };

  return (
    <section aria-label="All-sites search" data-all-sites-search={q !== '' ? 'results' : 'idle'}>
      <PageHeader
        title="Search"
        description={
          <>
            <span className="site-title">All installed sites</span>
            <p className="mt-1 text-xs text-muted-foreground">
              Searches every installed site catalog at once — a local catalog union, exactly like
              FMD2’s “search from all sites”. Sites without an installed catalog are skipped
              (shown below).
            </p>
          </>
        }
      />

      <FilterBar ariaLabel="All-sites search filters">
        <SearchBar
          id="all-sites-search"
          value={q}
          onChange={(text): void => {
            writeQ(text, true);
          }}
          mode="all"
          total={total}
          fetching={pages.isFetching}
        />
        <AllSitesToggle
          checked
          onChange={(): void => {
            navigate('browse', {});
          }}
        />
      </FilterBar>

      {pages.isError ? <ErrorBanner error={pages.error} /> : null}
      {pages.isPending && q !== '' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Searching every installed catalog…
        </p>
      ) : null}

      <UnionWarningChips warnings={warnings} />
      <UnionExcludedChips excluded={excluded} />
      <FacetChips
        facets={facets}
        onPickSite={(siteId): void => {
          // Chip click routes into that site's browse context carrying
          // the query (site-scoped search).
          navigate('browse', siteId === '' ? { allsites: '1' } : { site: siteId, ...(q !== '' ? { q } : {}) });
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
            ariaLabel="All-sites search results"
            items={entries}
            itemKey={(entry): string => `${entry.site}-${entry.link}`}
            renderItem={(entry): ReactElement => <UnionRow entry={entry} />}
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

      {!pages.isPending && entries.length === 0 && !pages.isError && q !== '' ? (
        <EmptyState title="No entries">
          <p>No installed site catalog matched this query.</p>
        </EmptyState>
      ) : null}

      {q === '' ? (
        <EmptyState title="Search every installed site at once">
          <p>
            Type a title (or set filters from a site’s Browse page) — the union runs over every
            INSTALLED catalog simultaneously and each result row shows the website it came from.
          </p>
        </EmptyState>
      ) : null}
    </section>
  );
}
