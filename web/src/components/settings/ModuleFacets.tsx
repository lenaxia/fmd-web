/**
 * ModuleFacets (Settings→Websites rebuild): the faceted filter bar over
 * the module registry — LANGUAGE (collapsed FMD2 categories, so English
 * + English-Scanlation count together), H-STATUS and NEEDS SETUP chips
 * with LIVE counts (proper faceted semantics: each group counts over
 * the other groups' constraints), plus the free-text search input.
 *
 * Pure presentational: the page owns the URL-synced state (chips →
 * push, typing → replace) and passes counts computed by
 * module-facets.ts. Chip styling mirrors SiteFilterChips (the site
 * picker's facet pattern — one design language for facets app-wide).
 */
import type { ReactElement } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  AVAILABILITY_FACET_LABELS,
  H_FACET_LABELS,
  SETUP_FACET_LABELS,
  type FacetGroups,
  type HFacetValue,
  type ModuleFilterState,
  type SetupFacetValue,
} from '../../state/module-facets';

function FacetChip(props: {
  readonly label: string;
  readonly count: number;
  readonly pressed: boolean;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={cn(
        'site-chip max-md:min-h-touch-target rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        props.pressed
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
        props.disabled === true ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : '',
      )}
      aria-pressed={props.pressed}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
    >
      {props.label}
      <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px] font-normal">
        {String(props.count)}
      </Badge>
    </button>
  );
}

function FacetGroup(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onClear: () => void;
  readonly children: readonly ReactElement[];
}): ReactElement {
  return (
    <div className="module-facet-group flex flex-wrap items-center gap-2" role="group" aria-label={props.label}>
      <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {props.label}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {props.children}
        {props.active ? (
          <button
            type="button"
            className="flex max-md:min-h-touch-target max-md:min-w-touch-target items-center rounded-full text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={props.onClear}
          >
            <X aria-hidden="true" className="size-3" />
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ModuleFacets(props: {
  readonly filter: ModuleFilterState;
  readonly counts: FacetGroups;
  readonly onChange: (next: ModuleFilterState) => void;
  readonly resultCount: number;
  readonly totalCount: number;
}): ReactElement {
  const toggleLang = (value: string): void => {
    props.onChange({
      ...props.filter,
      lang: props.filter.lang.includes(value)
        ? props.filter.lang.filter((v): boolean => v !== value)
        : [...props.filter.lang, value],
    });
  };
  const toggleH = (value: HFacetValue): void => {
    props.onChange({
      ...props.filter,
      h: props.filter.h.includes(value)
        ? props.filter.h.filter((v): boolean => v !== value)
        : [...props.filter.h, value],
    });
  };
  const toggleSetup = (value: SetupFacetValue): void => {
    props.onChange({
      ...props.filter,
      setup: props.filter.setup.includes(value)
        ? props.filter.setup.filter((v): boolean => v !== value)
        : [...props.filter.setup, value],
    });
  };

  return (
    <div className="module-facets mb-3 flex flex-col gap-2" data-testid="module-facets">
      <div className="flex flex-wrap items-center gap-2" data-testid="module-search">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search modules by name or category"
            placeholder="Search modules…"
            className="w-64 max-w-full pl-8"
            value={props.filter.q}
            onChange={(e): void => {
              props.onChange({ ...props.filter, q: e.target.value });
            }}
          />
        </div>
        <span className="text-xs text-muted-foreground" role="status">
          {props.filter.q === '' && props.filter.lang.length === 0 && props.filter.h.length === 0 && props.filter.setup.length === 0
            ? `${props.totalCount} sites`
            : `${props.resultCount}/${props.totalCount} sites match`}
        </span>
      </div>
      <FacetGroup
        label="Language"
        active={props.filter.lang.length > 0}
        onClear={(): void => {
          props.onChange({ ...props.filter, lang: [] });
        }}
      >
        {props.counts.lang.map(
          (facet): ReactElement => (
            <FacetChip
              key={facet.value}
              label={facet.value}
              count={facet.count}
              pressed={props.filter.lang.includes(facet.value)}
              disabled={facet.count === 0 && !props.filter.lang.includes(facet.value)}
              onClick={(): void => {
                toggleLang(facet.value);
              }}
            />
          ),
        )}
      </FacetGroup>
      <FacetGroup
        label="H status"
        active={props.filter.h.length > 0}
        onClear={(): void => {
          props.onChange({ ...props.filter, h: [] });
        }}
      >
        <FacetChip
          label={H_FACET_LABELS.h}
          count={props.counts.h.find((f): boolean => f.value === 'h')?.count ?? 0}
          pressed={props.filter.h.includes('h')}
          disabled={
            (props.counts.h.find((f): boolean => f.value === 'h')?.count ?? 0) === 0 &&
            !props.filter.h.includes('h')
          }
          onClick={(): void => {
            toggleH('h');
          }}
        />
        <FacetChip
          label={H_FACET_LABELS.safe}
          count={props.counts.h.find((f): boolean => f.value === 'safe')?.count ?? 0}
          pressed={props.filter.h.includes('safe')}
          disabled={
            (props.counts.h.find((f): boolean => f.value === 'safe')?.count ?? 0) === 0 &&
            !props.filter.h.includes('safe')
          }
          onClick={(): void => {
            toggleH('safe');
          }}
        />
      </FacetGroup>
      <FacetGroup
        label="Needs setup"
        active={props.filter.setup.length > 0}
        onClear={(): void => {
          props.onChange({ ...props.filter, setup: [] });
        }}
      >
        {(['no-setup', 'creds'] as const).map(
          (value): ReactElement => (
            <FacetChip
              key={value}
              label={SETUP_FACET_LABELS[value]}
              count={props.counts.setup.find((f): boolean => f.value === value)?.count ?? 0}
              pressed={props.filter.setup.includes(value)}
              disabled={
                (props.counts.setup.find((f): boolean => f.value === value)?.count ?? 0) === 0 &&
                !props.filter.setup.includes(value)
              }
              onClick={(): void => {
                toggleSetup(value);
              }}
            />
          ),
        )}
      </FacetGroup>
      <FacetGroup
        label="Last check"
        active={props.filter.avail !== 'all'}
        onClear={(): void => {
          props.onChange({ ...props.filter, avail: 'all' });
        }}
      >
        {/* Single-select by nature (statuses are mutually exclusive):
         * pressing the active chip returns to All. The All count is the
         * sum of the three (modules under the OTHER groups' constraints). */}
        {(['all', 'reachable', 'unreachable', 'unknown'] as const).map(
          (value): ReactElement => (
            <FacetChip
              key={value}
              label={value === 'all' ? 'All' : AVAILABILITY_FACET_LABELS[value]}
              count={
                value === 'all'
                  ? props.counts.avail.reduce((sum, facet): number => sum + facet.count, 0)
                  : props.counts.avail.find((f): boolean => f.value === value)?.count ?? 0
              }
              pressed={props.filter.avail === value}
              disabled={
                value !== 'all' &&
                (props.counts.avail.find((f): boolean => f.value === value)?.count ?? 0) === 0 &&
                props.filter.avail !== value
              }
              onClick={(): void => {
                props.onChange({
                  ...props.filter,
                  avail: props.filter.avail === value ? 'all' : value,
                });
              }}
            />
          ),
        )}
      </FacetGroup>
    </div>
  );
}
