/**
 * Browse page (§6.6 + site-first browse, FMD2 parity): the DEFAULT
 * state is the SitePicker (sites BY NAME — cbSelectManga parity,
 * frmMain.pas:6186; hex ids ride the URL, never the UI). Selecting a
 * site routes to `browse?site=<id>` (`?catalog=` stays as a legacy
 * alias for old links): an installed catalog opens the entries view
 * instantly (DBDataFileExist → OpenDataDB parity); a missing one
 * AUTO-PROVISIONS (POST /api/sync/catalog/:id + WS-driven progress
 * toast — the web default for FMD2's DBUpdaterThread dialog) and opens
 * on completion. The provision failure taxonomy: FMD2-DB 404 →
 * friendly no-catalog + §6.8 live-scrape offer when the module has
 * the directory events; transient errors → retry; known-broken
 * modules → disabled with reason. Catalog latest / by-title / FTS
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
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { FilterBar } from '@/components/patterns/FilterBar';
import { ListPanel } from '@/components/patterns/ListPanel';
import { EntryRow } from '@/components/patterns/EntryRow';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatPill } from '@/components/patterns/StatPill';
import { siteRowDisabledReason } from '@/components/SiteRow';
import { ProvisionToast } from '@/components/ProvisionToast';
import { AppliedFilterChips } from '@/components/catalog/AppliedFilterChips';
import { CatalogFilterPanel } from '@/components/catalog/CatalogFilterPanel';
import { SearchBar, type SearchModeLabel } from '@/components/catalog/SearchBar';
import { AllSitesToggle } from '@/components/catalog/AllSitesToggle';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { navigate, replaceRoute, type Route } from '../router';
import { useRoute } from '../state/use-route';

const PAGE_LIMIT = 20;

function EntryRowView(props: { entry: CatalogEntryT; siteId: string }): ReactElement {
  const { entry } = props;
  const open = (): void => {
    navigate('manga', {
      catalog: props.siteId,
      module: props.siteId,
      url: entry.link,
      title: entry.title,
    });
  };
  return (
    <EntryRow
      onClick={open}
      buttonClassName="catalog-entry"
      title={<span className="entry-title">{entry.title}</span>}
      meta={
        <span className="entry-meta">
          {entry.authors !== '' ? entry.authors : 'unknown author'} · {entry.status} · {entry.numChapter} chapters
        </span>
      }
    />
  );
}

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
  if (siteId === '') {
    return (
      <SitePickerPage
        onPick={(module: ModuleSummaryT): void => {
          navigate('browse', { site: module.id });
        }}
      />
    );
  }
  return <SiteBrowse siteId={siteId} route={route} />;
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
  const [forceLive, setForceLive] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [restView, setRestView] = useState<ProvisionView>({ view: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const firedRef = useRef('');
  const queryClient = useQueryClient();
  const provision = useProvisionCatalog();

  const brokenReason = module !== undefined ? siteRowDisabledReason(module) : undefined;
  const needsProvision = module !== undefined && !module.catalogInstalled && brokenReason === undefined;

  const progress = useSyncCatalogProgress({
    ...(needsProvision ? { jobId: catalogSyncJobId(props.siteId) } : {}),
    enabled: needsProvision && !cancelled,
  });
  const machineView = machineToView(progress.machine, cancelled);

  // AUTO-PROVISION (web default; FMD2 asks via dialog): fire the sync
  // POST once per (site, attempt) — the fired-key ref keeps React
  // StrictMode's dev double-invoke from double-firing. The
  // AbortController is the cancel LATCH — canceling withdraws the
  // provisioning view (the sync itself is one idempotent request; a
  // late completion only flips the chip).
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
  // an unresolved site) AND (the catalog is installed | live browse was
  // chosen | provisioning completed). A legacy ?catalog= for an
  // UNREGISTERED id keeps the classic entries view (server decides the
  // catalog/live channel and errors typed).
  const registryLoaded = modules.data !== undefined;
  const showEntries =
    registryLoaded && (!needsProvision || forceLive || provisionView?.view === 'ready');

  return (
    <section aria-label="Browse catalog" data-site-selected={showEntries ? 'entries' : 'provisioning'}>
      {needsProvision ? (
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
                navigate('browse');
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
          liveCapable={module?.capabilities.live_scrape_fallback ?? false}
          onCancel={cancel}
          onRetry={retry}
          onLive={(): void => {
            setForceLive(true);
          }}
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
  liveCapable: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onLive: () => void;
}): ReactElement {
  const v = props.view;
  if (v.view === 'no-catalog') {
    return (
      <EmptyState title="No prebuilt catalog for this site">
        <p>
          FMD2-DB has no catalog archive for {props.siteName}. The site cannot be browsed from a
          prebuilt database.
        </p>
        {props.liveCapable ? (
          <p>
            Its module supports live browsing — you can browse the site’s directory live instead
            (slower, but always current).
          </p>
        ) : (
          <p>This site’s module does not support live browsing either.</p>
        )}
        {props.liveCapable ? (
          <Button type="button" className="provision-live" onClick={props.onLive}>
            Browse live instead
          </Button>
        ) : null}
      </EmptyState>
    );
  }
  if (v.view === 'failed') {
    return (
      <EmptyState
        title="Catalog provisioning failed"
        action={
          <>
            <Button type="button" onClick={props.onRetry}>
              Retry
            </Button>
            {props.liveCapable ? (
              <Button type="button" variant="outline" className="ml-2" onClick={props.onLive}>
                Try live browse
              </Button>
            ) : null}
          </>
        }
      >
        <p>
          A transient error interrupted the catalog download for {props.siteName}. Retry when your
          connection allows — nothing partial was installed.
        </p>
        {v.detail !== undefined ? <p className="text-xs">{v.detail}</p> : null}
      </EmptyState>
    );
  }
  if (v.view === 'cancelled') {
    return (
      <EmptyState
        title="Provisioning cancelled"
        action={
          <Button type="button" onClick={props.onRetry}>
            Restart provisioning
          </Button>
        }
      >
        <p>The catalog download for {props.siteName} was cancelled. Nothing partial was installed.</p>
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
          ? 'Downloading and installing the site catalog (FMD2-DB).'
          : 'Starting catalog provisioning…'}
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

  const { mode, q, pages } = useCatalogQuery(siteId, state, {
    view,
    enabled: props.enabled,
    limit: PAGE_LIMIT,
  });

  const entries = pages.data?.pages.flatMap((page): CatalogEntryT[] => [...page.entries]) ?? [];
  const total = pages.data?.pages.at(-1)?.total;
  const live = pages.data?.pages.at(-1)?.source === 'live';

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

        {live ? (
          <Badge variant="secondary" title="§6.8 live-scrape fallback: no FMD2-DB catalog — served live from the module's directory walk">
            live scrape
          </Badge>
        ) : null}
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
            renderItem={(entry): ReactElement => <EntryRowView entry={entry} siteId={siteId} />}
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
