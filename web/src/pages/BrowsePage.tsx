/**
 * Browse page (§6.6 + site-first browse, FMD2 parity): the DEFAULT
 * state is the SitePicker (sites BY NAME — cbSelectManga parity,
 * frmMain.pas:6186; hex ids ride the URL, never the UI). Selecting a
 * site routes to `browse?site=<id>` (`?catalog=` stays as a legacy
 * alias for old links) and ALWAYS opens its list — one behavior, zero
 * internal vocabulary (the unified browsing model):
 *
 *   catalog present     → serve it (opens instantly)
 *   catalog absent      → auto-prepare (POST /api/sync/catalog/:id +
 *                         WS-driven 'Preparing <site>…' toast, the web
 *                         default for FMD2's DBUpdaterThread dialog)
 *   no catalog exists   → fall through AUTOMATICALLY to the live
 *     (FMD2-DB 404)       channel when the module has directory
 *                         capability — the same progress experience,
 *                         no user decision point
 *
 * The provision failure taxonomy: FMD2-DB 404 on a directory-capable
 * module auto-falls-through (§6.8, invisible plumbing); 404 on a
 * non-capable module → friendly no-list panel; transient errors →
 * retry; known-broken modules → disabled with reason. The channel that
 * served the open list surfaces ONLY as the muted SourceBadge
 * ('from site' / 'from catalog'). Catalog latest / by-title / FTS
 * search with cursor pagination ("Load more") is unchanged, and the
 * Manga deep-link flow (catalog→manga) is untouched.
 *
 * Live search + FMD2 filter panel (tsk-savvy-jockey-ambles): the
 * entries view is a PURE function of the URL-synced filter state
 * (?site=&q=&status=&genres=&mode= + authors/cgenres/new/view) — the
 * SearchBar edits q with as-you-type URL REPLACE (no history spam;
 * fetches debounced 250ms in useCatalogQuery), every discrete filter
 * change PUSHES (back/forward correct, shareable).
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ChevronDown, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { CatalogEntryT, ModuleSummaryT } from '../api/hooks';
import { useModules, useProvisionCatalog } from '../api/hooks';
import { SitePickerPage } from './SitePickerPage';
import { AllSitesSearchPage } from './AllSitesSearchPage';
import { SearchHomePage } from './SearchHomePage';
import { pushRecentSite } from '../state/recents';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { FilterBar } from '@/components/patterns/FilterBar';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatPill } from '@/components/patterns/StatPill';
import { siteRowDisabledReason } from '@/components/SiteRow';
import { ProvisionToast } from '@/components/ProvisionToast';
import { AppliedFilterChips } from '@/components/catalog/AppliedFilterChips';
import { CatalogFilterPanel } from '@/components/catalog/CatalogFilterPanel';
import { SearchBar, type SearchModeLabel } from '@/components/catalog/SearchBar';
import { AllSitesToggle } from '@/components/catalog/AllSitesToggle';
import { CatalogEntryRow } from '@/components/catalog/CatalogEntryRow';
import { HighlightNewToggle } from '@/components/catalog/HighlightNewToggle';
import { SourceBadge, type ListSource } from '@/components/catalog/SourceBadge';
import { useHighlightNew } from '../state/highlight-new';
import { catalogSyncJobId } from '../state/ws-protocol';
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  parseFilterQuery,
  serializeFilterQuery,
  type BrowseFilterState,
} from '../state/browse-filter-state';
import { useCatalogQuery } from '../state/use-catalog-query';
import {
  useSyncCatalogProgress,
  type ProvisionMachine,
} from '../state/use-sync-catalog-progress';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { navigate, replaceRoute, type Route } from '../router';
import { useRoute } from '../state/use-route';

const PAGE_LIMIT = 20;

export function BrowsePage(props: { route: Route }): ReactElement {
  // The live hash is the truth (App owns routing; this subscription
  // keeps the filter state pure under replaceState typing + back/forward).
  const route: Route = useRoute(props.route);
  // ?allsites=1 — the union search view (FMD2 cbSearchFromAllSites);
  // takes precedence over ?site= (toggling on drops the site context).
  if (route.query['allsites'] === '1') {
    return <AllSitesSearchPage route={route} />;
  }
  // ?site= is canonical; ?catalog= is kept as a legacy alias (old links).
  const siteId = route.query['site'] ?? route.query['catalog'] ?? '';
  if (siteId !== '') {
    return <SiteBrowse siteId={siteId} route={route} />;
  }
  // ?sites=1 — the full site picker (site-first SECONDARY mode: one
  // tap from the search home, and the 'Change site' target — FMD2
  // refugees keep the combobox-era flow intact).
  if (route.query['sites'] === '1') {
    return (
      <SitePickerPage
        route={route}
        onPick={(module: ModuleSummaryT): void => {
          navigate('browse', { site: module.id });
        }}
      />
    );
  }
  // Default = the SEARCH-FIRST home (R5): union search over every
  // installed catalog; deep links (?site=/?catalog=) never land here.
  return <SearchHomePage route={route} />;
}

/** The resolved terminal state: WS machine first, REST outcome as truth. */
type ProvisionView =
  | { readonly view: 'idle' }
  | { readonly view: 'installing' }
  | { readonly view: 'ready' }
  | { readonly view: 'no-catalog'; readonly detail?: string }
  | { readonly view: 'failed'; readonly detail?: string }
  | { readonly view: 'cancelled' };

function restOutcomeToView(outcome: {
  state: 'updated' | 'unchanged' | 'failed';
  error?: string;
}): ProvisionView {
  if (outcome.state !== 'failed') return { view: 'ready' };
  return outcome.error !== undefined && outcome.error.startsWith('no-catalog:')
    ? { view: 'no-catalog', ...(outcome.error !== undefined ? { detail: outcome.error } : {}) }
    : { view: 'failed', ...(outcome.error !== undefined ? { detail: outcome.error } : {}) };
}

function machineToView(machine: ProvisionMachine, cancelled: boolean): ProvisionView | undefined {
  if (cancelled) return { view: 'cancelled' };
  if (machine.state === 'idle') return undefined;
  if (machine.state === 'installing') return { view: 'installing' };
  if (machine.state === 'ready') return { view: 'ready' };
  if (machine.state === 'no-catalog') {
    return { view: 'no-catalog', ...(machine.detail !== undefined ? { detail: machine.detail } : {}) };
  }
  if (machine.state === 'failed') {
    return { view: 'failed', ...(machine.detail !== undefined ? { detail: machine.detail } : {}) };
  }
  return undefined;
}

function SiteBrowse(props: { siteId: string; route: Route }): ReactElement {
  const modules = useModules();
  const module = useMemo(
    (): ModuleSummaryT | undefined => modules.data?.modules.find((m): boolean => m.id === props.siteId),
    [modules.data, props.siteId],
  );
  const [cancelled, setCancelled] = useState(false);
  const [restView, setRestView] = useState<ProvisionView>({ view: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const firedRef = useRef('');
  const queryClient = useQueryClient();
  const provision = useProvisionCatalog();

  const brokenReason = module !== undefined ? siteRowDisabledReason(module) : undefined;
  const needsProvision = module !== undefined && !module.catalogInstalled && brokenReason === undefined;
  // Directory capability (§5.10): the module can serve its list
  // straight from the site when no prebuilt catalog exists.
  const directoryCapable = module?.capabilities.live_scrape_fallback ?? false;

  // Recents plumbing: every OPENED site (resolved to its name — the
  // hex id never reaches the UI) feeds the shared recent-sites store
  // (search home row + command palette). Re-opens move to the front.
  const resolvedSiteId = module?.id;
  const resolvedSiteName = module?.name;
  useEffect((): void => {
    if (resolvedSiteId !== undefined && resolvedSiteName !== undefined) {
      pushRecentSite({ id: resolvedSiteId, name: resolvedSiteName });
    }
  }, [resolvedSiteId, resolvedSiteName]);

  const progress = useSyncCatalogProgress({
    ...(needsProvision ? { jobId: catalogSyncJobId(props.siteId) } : {}),
    enabled: needsProvision && !cancelled,
  });
  const machineView = machineToView(progress.machine, cancelled);

  // AUTO-PREPARE (web default; FMD2 asks via dialog): fire the sync
  // POST once per (site, attempt) — the fired-key ref keeps React
  // StrictMode's dev double-invoke from double-firing. The
  // AbortController is the cancel LATCH — canceling withdraws the
  // progress view (the sync itself is one idempotent request; a late
  // completion only flips the chip).
  useEffect((): (() => void) | undefined => {
    if (!needsProvision) return undefined;
    const firedKey = `${props.siteId}#${String(attempt)}`;
    if (firedRef.current === firedKey) return undefined;
    firedRef.current = firedKey;
    const controller = new AbortController();
    abortRef.current = controller;
    provision.mutate(
      { moduleId: props.siteId },
      {
        onSuccess: (outcome): void => {
          setRestView(restOutcomeToView(outcome.result));
        },
        onError: (): void => {
          if (!controller.signal.aborted) {
            setRestView({ view: 'failed', detail: 'provisioning request failed' });
          }
        },
      },
    );
    return (): void => {
      controller.abort();
      abortRef.current = null;
    };
    // provision.mutate is stable; `attempt` is the retry lever.
  }, [props.siteId, attempt, needsProvision]);

  // Terminal truth: the WS machine settles first when the hub streams;
  // otherwise the REST outcome decides.
  const provisionView: ProvisionView | undefined =
    machineView !== undefined && machineView.view !== 'idle'
      ? machineView
      : restView.view !== 'idle'
        ? restView
        : machineView;

  // A finished provision flips catalogInstalled server-side (live
  // CatalogStore join) — refetch modules so the entries view opens.
  useEffect((): void => {
    if (provisionView?.view === 'ready') {
      void queryClient.invalidateQueries({ queryKey: ['modules'] });
    }
  }, [provisionView?.view, queryClient]);

  // UNIFIED BROWSING (invisible plumbing): when no prebuilt catalog
  // exists (FMD2-DB 404) and the module has directory capability, the
  // SAME progress experience falls through AUTOMATICALLY to the live
  // channel — the entries fetch is served by the site itself and the
  // only trace is the muted 'from site' badge. No button, no mode
  // name, no user decision.
  const fellThroughToSite =
    needsProvision && provisionView?.view === 'no-catalog' && directoryCapable;

  // Fallback name for a legacy ?catalog= id that is not a registered
  // module: neutral, NEVER the hex id.
  const siteName = module?.name ?? 'Catalog';

  const cancel = (): void => {
    abortRef.current?.abort();
    setCancelled(true);
  };

  const retry = (): void => {
    setCancelled(false);
    setRestView({ view: 'idle' });
    progress.reset();
    setAttempt((n): number => n + 1);
  };

  // Entries open when: the registry resolved (no doomed fetches against
  // an unresolved site) AND (the catalog is installed | preparation
  // completed | the automatic fall-through fired). A legacy ?catalog=
  // for an UNREGISTERED id keeps the classic entries view (server
  // decides the channel and errors typed).
  const registryLoaded = modules.data !== undefined;
  const showEntries =
    registryLoaded && (!needsProvision || provisionView?.view === 'ready' || fellThroughToSite);

  return (
    <section aria-label="Browse catalog" data-site-selected={showEntries ? 'entries' : 'provisioning'}>
      {needsProvision && !fellThroughToSite ? (
        <ProvisionToast machine={progress.machine} siteName={siteName} onCancel={cancel} />
      ) : null}

      <PageHeader
        title="Browse"
        description={
          <>
            <span className="site-title">{siteName}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-2 h-7"
              onClick={(): void => {
                // Back to the full picker (site-first secondary mode),
                // not the search home — 'Change site' keeps its FMD2
                // meaning of swapping to another site.
                navigate('browse', { sites: '1' });
              }}
            >
              <Undo2 aria-hidden="true" />
              Change site
            </Button>
          </>
        }
      />

      {modules.isError ? <ErrorBanner error={modules.error} /> : null}

      {brokenReason !== undefined ? (
        <EmptyState title="This site is unavailable">
          <p>
            {siteName} is known broken upstream — opening it is disabled until an upstream fix
            lands.
          </p>
          <p className="text-xs">{brokenReason}</p>
        </EmptyState>
      ) : null}

      {brokenReason === undefined && needsProvision && !showEntries ? (
        <ProvisionPanel
          siteName={siteName}
          view={provisionView ?? { view: 'idle' }}
          onCancel={cancel}
          onRetry={retry}
        />
      ) : null}

      {showEntries && brokenReason === undefined ? (
        <CatalogEntries
          siteId={props.siteId}
          siteName={siteName}
          enabled={showEntries}
          route={props.route}
        />
      ) : null}
    </section>
  );
}

function ProvisionPanel(props: {
  siteName: string;
  view: ProvisionView;
  onCancel: () => void;
  onRetry: () => void;
}): ReactElement {
  const v = props.view;
  if (v.view === 'no-catalog') {
    // Directory-capable modules never reach this branch (the automatic
    // fall-through opened their list) — this is the no-list dead end
    // for modules without directory capability.
    return (
      <EmptyState title="No list available for this site">
        <p>
          There is no ready-made list for {props.siteName}, and its titles cannot be fetched from
          the site directly.
        </p>
        {v.detail !== undefined ? <p className="text-xs">{v.detail}</p> : null}
      </EmptyState>
    );
  }
  if (v.view === 'failed') {
    return (
      <EmptyState
        title="Couldn’t open this site"
        action={
          <Button type="button" onClick={props.onRetry}>
            Retry
          </Button>
        }
      >
        <p>
          A transient error interrupted opening {props.siteName}. Retry when your connection
          allows — nothing partial was installed.
        </p>
        {v.detail !== undefined ? <p className="text-xs">{v.detail}</p> : null}
      </EmptyState>
    );
  }
  if (v.view === 'cancelled') {
    return (
      <EmptyState
        title="Cancelled"
        action={
          <Button type="button" onClick={props.onRetry}>
            Try again
          </Button>
        }
      >
        <p>Opening {props.siteName} was cancelled. Nothing was changed.</p>
      </EmptyState>
    );
  }
  // idle / installing — the inline mirror of the toast (role=status is
  // the pinned region e2e asserts; the toast is transient by design).
  return (
    <div role="status" aria-live="polite" data-testid="provision-status" className="provision-status">
      <p className="text-sm font-medium">Preparing {props.siteName}…</p>
      <p className="text-xs text-muted-foreground">
        {v.view === 'installing'
          ? 'Getting the site ready — this only happens the first time you open it.'
          : 'Starting…'}
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={props.onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * The entries view: a PURE function of the URL-synced filter state.
 * Typing in the SearchBar REPLACES the URL (shareable, no history
 * spam); discrete filter changes PUSH (back/forward restore).
 */
function CatalogEntries(props: {
  siteId: string;
  siteName: string;
  enabled: boolean;
  route: Route;
}): ReactElement {
  const { siteId } = props;
  const state: BrowseFilterState = parseFilterQuery(props.route.query);
  const view: 'latest' | 'title' = props.route.query['view'] === 'title' ? 'title' : 'latest';
  const [filtersOpen, setFiltersOpen] = useState(false);
  // FMD2 miHighlightNewManga parity: one persisted global toggle gating
  // the new-manga accent on every entry row.
  const [highlightNew] = useHighlightNew();

  const { mode, q, pages } = useCatalogQuery(siteId, state, {
    view,
    enabled: props.enabled,
    limit: PAGE_LIMIT,
  });

  const entries = pages.data?.pages.flatMap((page): CatalogEntryT[] => [...page.entries]) ?? [];
  const total = pages.data?.pages.at(-1)?.total;
  // Which channel served the open list — transparency only (muted
  // badge + tooltip), never a label on any control.
  const source: ListSource | undefined = pages.data?.pages.at(-1)?.source;

  // URL writer: replaces while typing, pushes for discrete changes.
  const writeState = (next: BrowseFilterState, replace: boolean): void => {
    const query: Record<string, string> = { site: siteId, ...serializeFilterQuery(next) };
    if (view === 'title') {
      query['view'] = 'title';
    }
    if (replace) {
      replaceRoute('browse', query);
    } else {
      navigate('browse', query);
    }
  };
  const onQChange = (text: string): void => {
    writeState({ ...state, q: text }, true);
  };
  const onFiltersChange = (next: BrowseFilterState): void => {
    writeState(next, false);
  };
  const onReset = (): void => {
    writeState(EMPTY_FILTERS, false);
  };

  const filtering: boolean = hasActiveFilters(state);
  // FMD2 lbMode parity: All / Filtered (+ which tab served the list).
  const modeLabel: SearchModeLabel = filtering ? 'filtered' : view === 'title' ? 'all' : 'latest';

  return (
    <>
      <FilterBar ariaLabel="Catalog filters">
        <Tabs
          value={view}
          onValueChange={(value): void => {
            const query: Record<string, string> = { site: siteId, ...serializeFilterQuery(state) };
            if (value === 'title') {
              query['view'] = 'title';
            }
            navigate('browse', query);
          }}
        >
          <TabsList aria-label="Browse mode">
            <TabsTrigger value="latest">Latest</TabsTrigger>
            <TabsTrigger value="title">By title</TabsTrigger>
          </TabsList>
        </Tabs>

        <SearchBar
          id="browse-search"
          value={state.q}
          onChange={onQChange}
          mode={modeLabel}
          total={total}
          fetching={pages.isFetching}
        />

        <AllSitesToggle
          checked={false}
          onChange={(): void => {
            // FMD2 cbSearchFromAllSites parity: switch the search bar
            // into union mode, carrying the typed query along.
            navigate('browse', { allsites: '1', ...(state.q !== '' ? { q: state.q } : {}) });
          }}
        />

        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={filtersOpen}
          onClick={(): void => {
            setFiltersOpen((open): boolean => !open);
          }}
        >
          <ChevronDown aria-hidden="true" className={filtersOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          Filters{filtering ? ' •' : ''}
        </Button>

        <HighlightNewToggle />

        {source !== undefined ? <SourceBadge source={source} /> : null}
      </FilterBar>

      {filtersOpen ? (
        <div className="mb-4 rounded-md border p-3">
          <CatalogFilterPanel state={state} onChange={onFiltersChange} onReset={onReset} />
        </div>
      ) : null}

      <AppliedFilterChips state={state} onChange={onFiltersChange} />

      {pages.isError ? <ErrorBanner error={pages.error} /> : null}
      {pages.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading…</p> : null}

      {entries.length > 0 ? (
        <>
          <p role="status" className="mb-2">
            <StatPill>
              Showing {entries.length}
              {total !== undefined ? ` of ${total}` : ''} entries
            </StatPill>
          </p>
          <ListPanel
            className="catalog-list"
            ariaLabel="Catalog entries"
            items={entries}
            itemKey={(entry): string => `${entry.jdn}-${entry.link}`}
            renderItem={(entry): ReactElement => (
              <CatalogEntryRow
                entry={entry}
                siteId={siteId}
                highlightNew={highlightNew}
                {...(state.newDays !== undefined ? { newDays: state.newDays } : {})}
              />
            )}
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
          <p>
            The catalog answered with zero entries
            {mode === 'search' && q !== '' ? ' for this query' : ''}
            {filtering && q === '' ? ' for these filters' : ''}.
          </p>
        </EmptyState>
      ) : null}
    </>
  );
}
