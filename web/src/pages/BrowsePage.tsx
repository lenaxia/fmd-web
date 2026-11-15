/**
 * Browse page (§6.6): catalog latest / by-title / FTS search with
 * cursor pagination ("Load more"). The catalog id equals the site
 * module id (§6.4 catalogs are keyed per module); with no catalog
 * selected the D20 empty-state explains how to get one.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import type { CatalogEntryT } from '../api/hooks';
import { useCatalogEntries, type CatalogMode } from '../api/hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { navigate, type Route } from '../router';

const PAGE_LIMIT = 20;

const MODES: readonly { value: CatalogMode; label: string }[] = [
  { value: 'latest', label: 'Latest' },
  { value: 'title', label: 'By title' },
  { value: 'search', label: 'Search' },
];

function EntryRow(props: { entry: CatalogEntryT; catalogId: string }): ReactElement {
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
    <li className="catalog-entry">
      <button type="button" className="entry-link" onClick={open}>
        <span className="entry-title">{entry.title}</span>
        <span className="entry-meta">
          {entry.authors !== '' ? entry.authors : 'unknown author'} · {entry.status} · {entry.numChapter} chapters
        </span>
      </button>
    </li>
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
      <EmptyState title="No catalog selected">
        <p>
          Browse needs a catalog id (32-hex, keyed per site module). On first run the server
          auto-triggers module + catalog sync (D20) — check Settings for bootstrap progress,
          then open a catalog:
        </p>
        <CatalogIdForm />
      </EmptyState>
    );
  }

  return (
    <section aria-label="Browse catalog">
      <p className="toolbar">
        Catalog <code>{catalogId}</code>
        {pages.data?.pages.at(-1)?.source === 'live' ? (
          <span className="badge badge-capability" title="§6.8 live-scrape fallback: no FMD2-DB catalog — served live from the module's directory walk">
            live scrape
          </span>
        ) : null}
      </p>
      <CatalogIdForm />

      <div role="tablist" aria-label="Browse mode">
        {MODES.map((m): ReactElement => (
          <button
            key={m.value}
            type="button"
            role="tab"
            aria-selected={mode === m.value}
            onClick={(): void => {
              setMode(m.value);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      <form
        className="search-form"
        aria-label="Catalog search"
        onSubmit={(event): void => {
          onSearchSubmit(event);
        }}
      >
        <label htmlFor="browse-search">Search titles</label>
        <input
          id="browse-search"
          type="search"
          value={searchText}
          onChange={(e): void => {
            setSearchText(e.target.value);
          }}
        />
        <button type="submit">Search</button>
      </form>

      {pages.isError ? <ErrorBanner error={pages.error} /> : null}
      {pages.isPending ? <p role="status">Loading…</p> : null}

      {entries.length > 0 ? (
        <>
          <p role="status">
            Showing {entries.length}
            {total !== undefined ? ` of ${total}` : ''} entries
          </p>
          <ul className="catalog-list">
            {entries.map((entry): ReactElement => (
              <EntryRow key={`${entry.jdn}-${entry.link}`} entry={entry} catalogId={catalogId} />
            ))}
          </ul>
          {pages.hasNextPage ? (
            <button
              type="button"
              onClick={(): void => {
                pages.fetchNextPage();
              }}
              disabled={pages.isFetchingNextPage}
            >
              {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
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
      className="catalog-form"
      aria-label="Open catalog by id"
      onSubmit={(event): void => {
        event.preventDefault();
        const id = value.trim();
        if (/^[0-9a-f]{32}$/.test(id)) {
          navigate('browse', { catalog: id });
        }
      }}
    >
      <label htmlFor="catalog-id">Catalog id</label>
      <input
        id="catalog-id"
        name="catalog"
        placeholder="32-hex module id"
        value={value}
        onChange={(e): void => {
          setValue(e.target.value);
        }}
      />
      <button type="submit" disabled={!/^[0-9a-f]{32}$/.test(value.trim())}>
        Open
      </button>
    </form>
  );
}
