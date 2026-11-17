/**
 * JobFilters (downloads parity): the FMD2 tsDownload filter tree
 * (All → Finished/InProgress/Stopped/Failed/Disabled + History date
 * windows incl. Custom From/To, frmMain.lfm:60-182), web-adapted to
 * chips + dropdowns — a state MULTI-SELECT (any combination, not a
 * tree) and a date-window preset with custom From/To inputs. Pure
 * controlled inputs; the page owns the state and syncs it into the
 * URL query.
 */
import type { ReactElement } from 'react';
import type { JobStateT } from '../../api/hooks';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { Input } from '@/components/ui/input';
import { cn } from 'cn';
import {
  DATE_WINDOWS,
  type DateWindow,
  type DownloadsFilterState,
} from '../../state/downloads-filter-state';

const STATE_CHIPS: readonly { readonly value: JobStateT; readonly label: string }[] = [
  { value: 'queued', label: 'waiting' },
  { value: 'running', label: 'in progress' },
  { value: 'done', label: 'finished' },
  { value: 'cancelled', label: 'stopped' },
  { value: 'failed', label: 'failed' },
  { value: 'retry', label: 'problem' },
];

export function JobFilters(props: {
  readonly filters: DownloadsFilterState;
  readonly onChange: (next: DownloadsFilterState) => void;
}): ReactElement {
  const { filters } = props;
  const toggleState = (state: JobStateT): void => {
    const next = filters.states.includes(state)
      ? filters.states.filter((value): boolean => value !== state)
      : [...filters.states, state];
    props.onChange({ ...filters, states: next });
  };

  return (
    <div
      className="job-filters mb-4 flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="job-filters"
      aria-label="Job filters"
    >
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by state">
        {STATE_CHIPS.map((chip): ReactElement => {
          const active = filters.states.includes(chip.value);
          return (
            <button
              key={chip.value}
              type="button"
              aria-pressed={active}
              data-testid={`state-chip-${chip.value}`}
              className={cn(
                'state-chip max-md:min-h-touch-target max-md:min-w-touch-target rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-surface text-muted-foreground hover:text-foreground',
              )}
              onClick={(): void => {
                toggleState(chip.value);
              }}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="jobs-date-window" className="text-sm font-medium">
          Added
        </label>
        <NativeSelect
          id="jobs-date-window"
          className="w-36"
          value={filters.window}
          onChange={(e): void => {
            props.onChange({ ...filters, window: e.target.value as DateWindow });
          }}
        >
          {DATE_WINDOWS.map((entry): ReactElement => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </NativeSelect>
      </div>

      {filters.window === 'custom' ? (
        <div className="flex items-center gap-2" data-testid="custom-range">
          <label htmlFor="jobs-date-from" className="text-sm">
            From
          </label>
          <Input
            type="date"
            id="jobs-date-from"
            className="w-40"
            value={filters.from}
            onChange={(e): void => {
              props.onChange({ ...filters, from: e.target.value });
            }}
          />
          <label htmlFor="jobs-date-to" className="text-sm">
            To
          </label>
          <Input
            type="date"
            id="jobs-date-to"
            className="w-40"
            value={filters.to}
            onChange={(e): void => {
              props.onChange({ ...filters, to: e.target.value });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
