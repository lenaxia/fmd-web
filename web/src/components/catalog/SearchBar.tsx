/**
 * SearchBar (FMD2 edMangaListSearch parity): as-you-type live search
 * input against the open catalog. The input is CONTROLLED and purely
 * edits state — the debounce/abort lives in useCatalogQuery (never
 * here). The count/mode label is FMD2's lbMode parity (frmMain.pas:
 * `RS_ModeAll`/`RS_ModeFiltered` — "All (N)" / "Filtered (N)").
 */
import type { ReactElement } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

export type SearchModeLabel = 'latest' | 'title' | 'all' | 'filtered';

const MODE_TEXT: Readonly<Record<SearchModeLabel, string>> = {
  latest: 'Latest',
  title: 'All',
  all: 'All',
  filtered: 'Filtered',
};

export function SearchBar(props: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** lbMode parity: which list mode the results represent. */
  mode: SearchModeLabel;
  /** Total matching rows (server total), when known. */
  total?: number | undefined;
  fetching?: boolean | undefined;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={props.id ?? 'catalog-search'} className="text-sm font-medium">
        Search
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={props.id ?? 'catalog-search'}
          type="search"
          className="w-56 pl-8"
          placeholder="Title, summary, genres…"
          value={props.value}
          onChange={(e): void => {
            props.onChange(e.target.value);
          }}
        />
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {props.fetching ? (
          <Loader2 aria-hidden="true" className="mr-1 inline size-3.5 animate-spin align-[-2px]" />
        ) : null}
        {MODE_TEXT[props.mode]}
        {props.total !== undefined ? ` (${props.total})` : ''}
      </p>
    </div>
  );
}
