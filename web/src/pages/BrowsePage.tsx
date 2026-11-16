/**
 * Browse page (§6.6): catalog latest / by-title / FTS search with
 * cursor pagination ("Load more"). The catalog id equals the site
 * module id (§6.4 catalogs are keyed per module); with no catalog
 * selected the D20 empty-state explains how to get one.
 *
 * Design-system retrofit: PageHeader + FilterBar (Tabs + forms; the
 * bar collapses into the Sheet side panel on mobile) + ListPanel
 * (virtualized above the threshold). Behavior, texts, labels and
 * test hooks are unchanged — visual-only.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { Search } from 'lucide-react';
import type { CatalogEntryT } from '../api/hooks';
import { useCatalogEntries, type CatalogMode } from '../api/hooks';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { FilterBar } from '@/components/patterns/FilterBar';
import { ListPanel } from '@/components/patterns/ListPanel';
import { EntryRow } from '@/components/patterns/EntryRow';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatPill } from '@/components/patterns/StatPill';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { navigate, type Route } from '../router';

const PAGE_LIMIT = 20;

const MODES: readonly { value: CatalogMode; label: string }[] = [
  { value: 'latest', label: 'Latest' },
  { value: 'title', label: 'By title' },
  { value: 'search', label: 'Search' },
];

function EntryRowView(props: { entry: CatalogEntryT; catalogId: string }): ReactElement {
  const { entry } = props;
  const open = (): void => {
    navigate('manga', {
      catalog: props.catalogId,
      module: props.catalogId,
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
  const catalogId = props.route.query['catalog'] ?? '';
  const [mode, setMode] = useState<CatalogMode>('latest');
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const pages = useCatalogEntries({
    catalogId,
    mode,
    ...(mode === 'search' ? { q: searchQuery } : {}),
    limit: PAGE_LIMIT,
    enabled: catalogId !== '' && (mode !== 'search' || searchQuery !== ''),
  });

  const entries = pages.data?.pages.flatMap((page): CatalogEntryT[] => [...page.entries]) ?? [];
  const total = pages.data?.pages.at(-1)?.total;

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSearchQuery(searchText.trim());
    setMode('search');
  };

  if (catalogId === '') {
    return (
      <section aria-label="Browse catalog">
        <PageHeader title="Browse catalog" description="Search every synced site module's catalog." />
        <EmptyState title="No catalog selected">
          <p>
            Browse needs a catalog id (32-hex, keyed per site module). On first run the server
            auto-triggers module + catalog sync (D20) — check Settings for bootstrap progress,
            then open a catalog:
          </p>
          <CatalogIdForm />
        </EmptyState>
      </section>
    );
  }

  return (
    <section aria-label="Browse catalog">
      <PageHeader
        title="Browse"
        description={
          <>
            Catalog <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">{catalogId}</code>
            {pages.data?.pages.at(-1)?.source === 'live' ? (
              <Badge variant="secondary" className="ml-2 align-middle" title="§6.8 live-scrape fallback: no FMD2-DB catalog — served live from the module's directory walk">
                live scrape
              </Badge>
            ) : null}
          </>
        }
      />

      <FilterBar ariaLabel="Catalog filters">
        <Tabs value={mode} onValueChange={(value): void => { setMode(value as CatalogMode); }}>
          <TabsList aria-label="Browse mode">
            {MODES.map((m): ReactElement => (
              <TabsTrigger key={m.value} value={m.value}>
                {m.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <form
          className="flex flex-wrap items-center gap-2"
          aria-label="Catalog search"
          onSubmit={(event): void => {
            onSearchSubmit(event);
          }}
        >
          <label htmlFor="browse-search" className="text-sm font-medium">
            Search titles
          </label>
          <Input
            id="browse-search"
            type="search"
            className="w-56"
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

        <CatalogIdForm />
      </FilterBar>

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
            renderItem={(entry): ReactElement => <EntryRowView entry={entry} catalogId={catalogId} />}
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
            {mode === 'search' ? ' for this query' : ''}. If the catalog database is missing,
            run the catalog sync in Settings (first-run bootstrap, D20).
          </p>
        </EmptyState>
      ) : null}
    </section>
  );
}

function CatalogIdForm(): ReactElement {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      aria-label="Open catalog by id"
      onSubmit={(event): void => {
        event.preventDefault();
        const id = value.trim();
        if (/^[0-9a-f]{32}$/.test(id)) {
          navigate('browse', { catalog: id });
        }
      }}
    >
      <label htmlFor="catalog-id" className="text-sm font-medium">
        Catalog id
      </label>
      <Input
        id="catalog-id"
        name="catalog"
        className="w-64 font-mono text-xs"
        placeholder="32-hex module id"
        value={value}
        onChange={(e): void => {
          setValue(e.target.value);
        }}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={!/^[0-9a-f]{32}$/.test(value.trim())}>
        Open
      </Button>
    </form>
  );
}
