/**
 * CatalogFilterPanel + GenreSelect (FMD2 Filter panel parity,
 * frmMain.pas:3400): authors/artists/summary inputs (edFilterArtists
 * frmMain.lfm:1569, edFilterSummary :1606), status select, the
 * canonical
 * 38-genre checkbox grid with an ANY/ALL toggle (rbAny/rbAll), custom
 * genres free text (edCustomGenres), the only-new jdn window chip
 * (cbOnlyNew + OptionNewMangaTime), and reset (btFilterResetClick).
 * Edits filter STATE only — never the fetch. Rendered inside the
 * FilterBar pattern (Sheet on mobile).
 */
import type { ReactElement } from 'react';
import { RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  FILTER_STATUSES,
  FMD2_GENRES,
  liveFilterState,
  parseGenreEntries,
  type BrowseFilterState,
  type GenresMode,
} from '@/state/browse-filter-state';

export interface FilterPanelProps {
  readonly state: BrowseFilterState;
  readonly onChange: (next: BrowseFilterState) => void;
  readonly onReset: () => void;
}

function GenreSelect(props: {
  readonly selected: readonly string[];
  readonly mode: GenresMode;
  readonly onToggle: (genre: string) => void;
  readonly onModeChange: (mode: GenresMode) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium" id="genre-select-label">
          Genres
        </span>
        <Tabs
          value={props.mode}
          onValueChange={(value): void => {
            props.onModeChange(value as GenresMode);
          }}
        >
          <TabsList aria-label="Genre match mode" className="h-7">
            <TabsTrigger value="all" className="text-xs">
              Match all
            </TabsTrigger>
            <TabsTrigger value="any" className="text-xs">
              Any of
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div
        role="group"
        aria-labelledby="genre-select-label"
        aria-label="Genre filter"
        className="grid max-h-44 grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-x-3 gap-y-1 overflow-y-auto"
      >
        {FMD2_GENRES.map((genre): ReactElement => (
          <label key={genre} className="flex items-center gap-1.5 text-sm" data-genre={genre}>
            <Checkbox
              checked={props.selected.includes(genre)}
              onCheckedChange={(): void => {
                props.onToggle(genre);
              }}
              aria-label={genre}
            />
            {genre}
          </label>
        ))}
      </div>
    </div>
  );
}

export function CatalogFilterPanel(props: FilterPanelProps): ReactElement {
  const { state } = props;
  // Interaction-time base: the LIVE URL state (the hash round-trip is
  // async — consecutive clicks must compose, not clobber).
  const patch = (partial: Partial<BrowseFilterState>): void => {
    props.onChange({ ...liveFilterState(state), ...partial });
  };
  const toggleGenre = (genre: string): void => {
    const base: readonly string[] = liveFilterState(state).genres;
    patch({
      genres: base.includes(genre) ? base.filter((g): boolean => g !== genre) : [...base, genre],
    });
  };
  const newActive = state.newDays !== undefined;

  return (
    <div className="flex min-w-64 flex-col gap-3" data-testid="catalog-filter-panel">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="filter-authors" className="text-sm font-medium">
          Authors
        </label>
        <Input
          id="filter-authors"
          className="w-56"
          placeholder="contains…"
          value={state.authors}
          onChange={(e): void => {
            patch({ authors: e.target.value });
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="filter-artists" className="text-sm font-medium">
          Artists
        </label>
        <Input
          id="filter-artists"
          className="w-56"
          placeholder="contains…"
          value={state.artists}
          onChange={(e): void => {
            patch({ artists: e.target.value });
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="filter-summary" className="text-sm font-medium">
          Summary
        </label>
        <Input
          id="filter-summary"
          className="w-56"
          placeholder="contains…"
          value={state.summary}
          onChange={(e): void => {
            patch({ summary: e.target.value });
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="filter-status" className="text-sm font-medium">
          Status
        </label>
        <NativeSelect
          id="filter-status"
          className="w-40"
          value={state.status}
          onChange={(e): void => {
            patch({ status: e.target.value });
          }}
        >
          <option value="">Any status</option>
          {FILTER_STATUSES.map((status): ReactElement => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </NativeSelect>
      </div>

      <GenreSelect
        selected={state.genres}
        mode={state.genresMode}
        onToggle={toggleGenre}
        onModeChange={(genresMode): void => {
          patch({ genresMode });
        }}
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="filter-custom-genres" className="text-sm font-medium">
          Custom genres
        </label>
        <Input
          id="filter-custom-genres"
          className="w-56"
          placeholder="Adventure, !Ecchi, …"
          value={[...state.customGenres, ...state.excludedGenres.map((g): string => `!${g}`)].join(', ')}
          onChange={(e): void => {
            const raw: string = e.target.value;
            // Preserve the user's in-progress tail (trailing separator
            // or space) — parsing drops it on submit.
            const { includes, excludes } = parseGenreEntries(raw);
            const trailing: boolean = /[,\s]$/.test(raw);
            patch({
              customGenres: trailing ? [...includes, ''] : includes,
              excludedGenres: excludes,
            });
          }}
        />
        <p className="text-xs text-muted-foreground">
          Separate multiple genres with ","; prefix with ! or - to exclude
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="filter-new-days" className="text-sm font-medium">
          New manga
        </label>
        <Badge
          variant={newActive ? 'default' : 'secondary'}
          className="cursor-pointer"
          role="button"
          tabIndex={0}
          aria-pressed={newActive}
          data-testid="new-window-chip"
          onClick={(): void => {
            patch(newActive ? { newDays: undefined } : { newDays: 7 });
          }}
          onKeyDown={(e): void => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              patch(newActive ? { newDays: undefined } : { newDays: 7 });
            }
          }}
        >
          Only new
        </Badge>
        {newActive ? (
          <>
            <span className="text-xs text-muted-foreground">updated within</span>
            <Input
              id="filter-new-days"
              type="number"
              min={1}
              max={365}
              className="h-7 w-16"
              value={state.newDays}
              onChange={(e): void => {
                const n: number = Number.parseInt(e.target.value, 10);
                patch({ newDays: Number.isFinite(n) && n >= 1 && n <= 365 ? n : 1 });
              }}
            />
            <span className="text-xs text-muted-foreground">days</span>
          </>
        ) : null}
      </div>

      <Button type="button" variant="outline" size="sm" className="self-start" onClick={props.onReset}>
        <RotateCcw aria-hidden="true" />
        Reset filters
      </Button>
    </div>
  );
}
