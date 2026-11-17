/**
 * AppliedFilterChips: the row of removable chips mirroring the active
 * filter state (FMD2 has no direct twin — the web needs a glanceable
 * summary because filters hide inside the collapsible FilterBar).
 * Chips edit state only; removing a chip is a discrete filter change.
 */
import type { ReactElement } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { liveFilterState, type BrowseFilterState } from '@/state/browse-filter-state';

export function AppliedFilterChips(props: {
  readonly state: BrowseFilterState;
  readonly onChange: (next: BrowseFilterState) => void;
}): ReactElement | null {
  const { state } = props;
  const chips: Array<{ key: string; label: string; remove: () => void; excluded?: boolean }> = [];
  if (state.q !== '') {
    chips.push({
      key: 'q',
      label: `Search: ${state.q}`,
      remove: (): void => {
        props.onChange({ ...liveFilterState(state), q: '' });
      },
    });
  }
  if (state.status !== '') {
    chips.push({
      key: 'status',
      label: state.status,
      remove: (): void => {
        props.onChange({ ...liveFilterState(state), status: '' });
      },
    });
  }
  if (state.authors !== '') {
    chips.push({
      key: 'authors',
      label: `Authors: ${state.authors}`,
      remove: (): void => {
        props.onChange({ ...liveFilterState(state), authors: '' });
      },
    });
  }
  if (state.artists !== '') {
    chips.push({
      key: 'artists',
      label: `Artists: ${state.artists}`,
      remove: (): void => {
        props.onChange({ ...liveFilterState(state), artists: '' });
      },
    });
  }
  if (state.summary !== '') {
    chips.push({
      key: 'summary',
      label: `Summary: ${state.summary}`,
      remove: (): void => {
        props.onChange({ ...liveFilterState(state), summary: '' });
      },
    });
  }
  if (state.genres.length > 0 || state.customGenres.length > 0) {
    const all: readonly string[] = [...state.genres, ...state.customGenres];
    chips.push({
      key: 'genres',
      label: `${state.genresMode === 'any' ? 'Any of' : 'All of'}: ${all.join(', ')}`,
      remove: (): void => {
        props.onChange({ ...liveFilterState(state), genres: [], customGenres: [] });
      },
    });
  }
  if (state.excludedGenres.length > 0) {
    const label: string = `None of: ${state.excludedGenres.join(', ')}`;
    chips.push({
      key: 'genres-exclude',
      label,
      excluded: true,
      remove: (): void => {
        props.onChange({ ...liveFilterState(state), excludedGenres: [] });
      },
    });
  }
  if (state.newDays !== undefined) {
    chips.push({
      key: 'new',
      label: `New within ${state.newDays} days`,
      remove: (): void => {
        props.onChange({ ...liveFilterState(state), newDays: undefined });
      },
    });
  }
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="Applied filters" data-testid="applied-filters">
      {chips.map((chip): ReactElement => (
        <Badge
          key={chip.key}
          variant="secondary"
          className={`gap-1 pr-1${chip.excluded === true ? ' line-through opacity-60' : ''}`}
          data-excluded={chip.excluded === true ? 'true' : undefined}
        >
          <span className="max-w-64 truncate">{chip.label}</span>
          <button
            type="button"
            aria-label={`Remove filter: ${chip.label}`}
            className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-surface-hover"
            onClick={chip.remove}
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}
