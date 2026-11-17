/**
 * SitePickerPage (site-first browse, FMD2 parity): the Browse default
 * state — a searchable, category-grouped list of ENABLED site modules
 * BY NAME (cbSelectManga parity, frmMain.pas:6186; the hex module id
 * rides the URL, never the UI). The category facet filter
 * (SiteFilterChips — the Options→Websites language groupings,
 * frmMain.pas:6400-6470) narrows the list and is URL-synced via
 * `?cats=<csv>` ('All' default, multi-select, AND-composed with the
 * search box). Each row carries the capability badges + the
 * catalog-state chip (`catalogInstalled` join); picking a site routes
 * to `browse?site=<id>` where an installed catalog opens instantly,
 * a missing one provisions automatically, and a catalog-less site
 * opens from the site itself — one behavior, no mode vocabulary.
 *
 * Composed ONLY from design-system patterns: PageHeader + FilterBar +
 * SiteFilterChips + ListPanel (virtualized above the threshold — the
 * 454-site registry scrolls at 60fps) + EntryRow rows. Group headers
 * are plain list items in the same virtualized list.
 */
import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { Search } from 'lucide-react';
import type { ModuleSummaryT } from '../api/hooks';
import { useModules } from '../api/hooks';
import { SiteRow } from '@/components/SiteRow';
import { OpenByUrlInput } from '@/components/catalog/OpenByUrlInput';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { FilterBar } from '@/components/patterns/FilterBar';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SiteFilterChips, type CategoryFacet } from '@/components/patterns/SiteFilterChips';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { navigate, type Route } from '../router';
import { useRoute } from '../state/use-route';

/** One flattened list item: a category group header or a site row. */
type PickerItem =
  | { readonly kind: 'header'; readonly category: string; readonly count: number }
  | { readonly kind: 'site'; readonly module: ModuleSummaryT };

function matchSite(module: ModuleSummaryT, needle: string): boolean {
  if (needle === '') return true;
  return (
    module.name.toLowerCase().includes(needle) ||
    module.category.toLowerCase().includes(needle)
  );
}

// ── ?cats= codec (category facet, URL-synced) ───────────────────────

/**
 * Parse `?cats=` (comma-separated) into the selected category set.
 * Unknown categories are dropped (a shared URL never filters to an
 * empty registry); empty/absent = All (the default).
 */
export function parseCatsParam(query: Record<string, string>, valid: readonly string[]): readonly string[] {
  const raw = query['cats'];
  if (raw === undefined || raw === '') return [];
  const allowed = new Set(valid);
  return [...new Set(raw.split(',').map((part): string => part.trim()).filter((part): boolean => part !== ''))].filter(
    (category): boolean => allowed.has(category),
  );
}

/** Serialize the selection back to `?cats=` (omitted when All). */
export function serializeCats(cats: readonly string[]): Record<string, string> {
  if (cats.length === 0) return {};
  return { cats: [...cats].sort().join(',') };
}

/** ENABLED modules, search+category-filtered, grouped by category (A→Z, sites A→Z). */
export function buildPickerItems(
  modules: readonly ModuleSummaryT[],
  needle: string,
  cats: readonly string[] = [],
): readonly PickerItem[] {
  const enabled = modules.filter(
    (m): boolean =>
      m.enabled &&
      matchSite(m, needle) &&
      (cats.length === 0 || cats.includes(m.category)),
  );
  const byCategory = new Map<string, ModuleSummaryT[]>();
  for (const module of enabled) {
    const bucket = byCategory.get(module.category) ?? [];
    bucket.push(module);
    byCategory.set(module.category, bucket);
  }
  const categories = [...byCategory.keys()].sort((a, b): number => (a < b ? -1 : a > b ? 1 : 0));
  const items: PickerItem[] = [];
  for (const category of categories) {
    const sites = (byCategory.get(category) ?? []).sort((a, b): number =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    items.push({ kind: 'header', category, count: sites.length });
    for (const module of sites) {
      items.push({ kind: 'site', module });
    }
  }
  return items;
}

/** Category facet totals over the ENABLED registry (stable counts —
 * the facet mirrors the registry, not the current search). */
export function categoryFacets(modules: readonly ModuleSummaryT[]): readonly CategoryFacet[] {
  const counts = new Map<string, number>();
  for (const module of modules) {
    if (!module.enabled) continue;
    counts.set(module.category, (counts.get(module.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, count]): CategoryFacet => ({ category, count }));
}

export function SitePickerPage(props: {
  route: Route;
  onPick: (module: ModuleSummaryT) => void;
}): ReactElement {
  // The live hash is the truth (App owns routing; this subscription
  // keeps ?cats= pure under back/forward navigation).
  const route: Route = useRoute(props.route);
  const modules = useModules();
  const [searchText, setSearchText] = useState('');
  const needle = searchText.trim().toLowerCase();

  const registry: readonly ModuleSummaryT[] = modules.data?.modules ?? [];
  const facets = useMemo((): readonly CategoryFacet[] => categoryFacets(registry), [registry]);
  const cats = useMemo(
    (): readonly string[] => parseCatsParam(route.query, facets.map((f): string => f.category)),
    [route.query, facets],
  );

  const items = useMemo(
    (): readonly PickerItem[] => buildPickerItems(registry, needle, cats),
    [registry, needle, cats],
  );

  const onCatsChange = (next: readonly string[]): void => {
    // Discrete facet change → PUSH (back/forward restore the chips).
    navigate('browse', serializeCats(next));
  };

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault(); // live filtering; submit only keeps focus stable
  };

  return (
    <section aria-label="Browse sites" className="site-picker">
      <PageHeader
        title="Browse sites"
        description="Pick a site by name — its list opens instantly when synced, or is prepared automatically when not."
      />

      <FilterBar ariaLabel="Site filters">
        <form
          className="flex flex-wrap items-center gap-2"
          aria-label="Site search"
          onSubmit={onSearchSubmit}
        >
          <label htmlFor="site-search" className="text-sm font-medium">
            Search sites
          </label>
          <Input
            id="site-search"
            name="site"
            type="search"
            className="w-64"
            placeholder="Name or category"
            value={searchText}
            onChange={(e): void => {
              setSearchText(e.target.value);
            }}
          />
          <Button type="submit" variant="secondary" size="sm">
            <Search aria-hidden="true" />
            Search
          </Button>
        </form>
        {/* [parity-sweep] M14 — FMD2 edURL paste-and-go parity */}
        <OpenByUrlInput />
      </FilterBar>

      {modules.data !== undefined ? (
        <SiteFilterChips categories={facets} selected={cats} onChange={onCatsChange} />
      ) : null}

      {modules.isError ? <ErrorBanner error={modules.error} /> : null}
      {modules.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading sites…
        </p>
      ) : null}

      {modules.data !== undefined && modules.data.count === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No site modules registered yet — the first-run module sync (D20) populates this list;
          Settings shows its progress.
        </p>
      ) : null}

      {items.length > 0 ? (
        <ListPanel
          className="site-list"
          ariaLabel="Sites by category"
          items={items}
          itemKey={(item): string =>
            item.kind === 'header' ? `header-${item.category}` : `site-${item.module.id}`
          }
          estimateSize={(): number => (items.length > 100 ? 52 : 48)}
          renderItem={(item): ReactElement =>
            item.kind === 'header' ? (
              <div
                role="presentation"
                className="flex items-baseline justify-between pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              >
                <span className="site-category">{item.category}</span>
                <span className="font-normal normal-case">
                  {item.count === 1 ? '1 site' : `${String(item.count)} sites`}
                </span>
              </div>
            ) : (
              <SiteRow module={item.module} onPick={props.onPick} />
            )
          }
        />
      ) : null}

      {!modules.isPending && items.length === 0 && modules.data !== undefined && modules.data.count > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {cats.length > 0 && needle === ''
            ? `No sites in the selected categories (${cats.join(', ')}).`
            : cats.length > 0
              ? `No sites match “${searchText.trim()}” in the selected categories.`
              : `No sites match “${searchText.trim()}”.`}
        </p>
      ) : null}
    </section>
  );
}
