/**
 * SitePickerPage (site-first browse, FMD2 parity): the Browse default
 * state — a searchable, category-grouped list of ENABLED site modules
 * BY NAME (cbSelectManga parity, frmMain.pas:6186; the hex module id
 * rides the URL, never the UI). Each row carries the capability
 * badges + the catalog-state chip (`catalogInstalled` join); picking a
 * site routes to `browse?site=<id>` where an installed catalog opens
 * instantly and a missing one auto-provisions (DBUpdaterThread parity).
 *
 * Composed ONLY from design-system patterns: PageHeader + FilterBar +
 * ListPanel (virtualized above the threshold — the 454-site registry
 * scrolls at 60fps) + EntryRow rows. Group headers are plain list
 * items in the same virtualized list.
 */
import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { Search } from 'lucide-react';
import type { ModuleSummaryT } from '../api/hooks';
import { useModules } from '../api/hooks';
import { SiteRow } from '@/components/SiteRow';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { FilterBar } from '@/components/patterns/FilterBar';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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

/** ENABLED modules, search-filtered, grouped by category (A→Z, sites A→Z). */
export function buildPickerItems(
  modules: readonly ModuleSummaryT[],
  needle: string,
): readonly PickerItem[] {
  const enabled = modules.filter((m): boolean => m.enabled && matchSite(m, needle));
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

export function SitePickerPage(props: {
  onPick: (module: ModuleSummaryT) => void;
}): ReactElement {
  const modules = useModules();
  const [searchText, setSearchText] = useState('');
  const needle = searchText.trim().toLowerCase();

  const items = useMemo(
    (): readonly PickerItem[] => buildPickerItems(modules.data?.modules ?? [], needle),
    [modules.data, needle],
  );

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault(); // live filtering; submit only keeps focus stable
  };

  return (
    <section aria-label="Browse sites" className="site-picker">
      <PageHeader
        title="Browse sites"
        description="Pick a site by name — its catalog opens instantly when synced, or provisions automatically when not."
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
      </FilterBar>

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
          No sites match “{searchText.trim()}”.
        </p>
      ) : null}
    </section>
  );
}
