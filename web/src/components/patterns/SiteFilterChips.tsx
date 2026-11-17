/**
 * SiteFilterChips (design system pattern): the category facet filter
 * for the site picker — one toggle chip per category with its site
 * count, plus an 'All' chip that clears the selection (FMD2
 * Options→Websites parity: the tree's language groupings — English,
 * Spanish, Indonesian, Raw, … — as multi-select facets above the
 * list). Selection is multi-select (OR within chips) and composes
 * with any text search upstream (AND).
 *
 * Pure presentational: the caller owns the selected set (URL-synced
 * upstream) and the counts (facet totals over the enabled registry).
 */
import type { ReactElement } from 'react';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';

/** One category facet: the group label + its enabled-site count. */
export interface CategoryFacet {
  readonly category: string;
  readonly count: number;
}

export function SiteFilterChips(props: {
  /** Available categories (A→Z upstream), each with its count. */
  readonly categories: readonly CategoryFacet[];
  /** Selected categories; empty = All (the default). */
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly ariaLabel?: string;
}): ReactElement {
  const all = props.selected.length === 0;
  const toggle = (category: string): void => {
    if (props.selected.includes(category)) {
      props.onChange(props.selected.filter((c): boolean => c !== category));
    } else {
      props.onChange([...props.selected, category]);
    }
  };
  return (
    <div
      role="group"
      aria-label={props.ariaLabel ?? 'Filter sites by category'}
      className="site-filter-chips mb-4 flex flex-wrap items-center gap-2"
    >
      <button
        type="button"
        className={cn(
          'site-chip site-chip-all max-md:min-h-touch-target max-md:min-w-touch-target rounded-full border px-3 py-1 text-xs font-medium transition-colors',
          all
            ? 'border-transparent bg-primary text-primary-foreground'
            : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
        )}
        aria-pressed={all}
        onClick={(): void => {
          props.onChange([]);
        }}
      >
        All
      </button>
      {props.categories.map(
        (facet): ReactElement => (
          <button
            key={facet.category}
            type="button"
            className={cn(
              'site-chip max-md:min-h-touch-target max-md:min-w-touch-target rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              props.selected.includes(facet.category)
                ? 'border-transparent bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
            )}
            aria-pressed={props.selected.includes(facet.category)}
            onClick={(): void => {
              toggle(facet.category);
            }}
          >
            {facet.category}
            <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px] font-normal">
              {String(facet.count)}
            </Badge>
          </button>
        ),
      )}
    </div>
  );
}
