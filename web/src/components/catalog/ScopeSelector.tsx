/**
 * ScopeSelector ([fuzzy-javelin-pearls], D1 §2 ENTER — search-with-
 * scope): the three-way scope control on the search home —
 *
 *   All sites      the default union (zero network, local index)
 *   Preferred (n)  the persisted user-ordered allowlist
 *   Choose sites   the explicit multi-select (the tightest scope)
 *
 * Composes with availability dimming everywhere a site renders: a
 * DEAD preferred row or pick dims (opacity + 'unreachable' note) but
 * stays visible and selectable — a hint, never a gate (D1 §3; dead
 * preferred sites surface in triage later, they are never hidden
 * here). The parent owns routing (a scope change PUSHES — back/forward
 * restore the selector); this component only reports the next state.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { Star, WifiOff, X } from 'lucide-react';
import type { ModuleSummaryT } from '../../api/hooks';
import type { SearchScope, SearchScopeState } from '../../state/search-scope-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from 'cn';

/** Max checkbox rows rendered in the specific-picker panel (454-site
 * registry: type-to-narrow keeps the DOM bounded). */
const MAX_RENDERED_PICKS = 60;

/** One preferred row joined against the registry (name + hint state). */
export interface PreferredRow {
  readonly id: string;
  readonly name: string;
  readonly unreachable: boolean;
}

export function ScopeSelector(props: {
  readonly scope: SearchScope;
  readonly picks: readonly string[];
  readonly preferred: readonly PreferredRow[];
  readonly registry: readonly ModuleSummaryT[];
  readonly onChange: (next: SearchScopeState) => void;
}): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');

  const scopeButton = (
    label: string,
    value: SearchScope,
    testId: string,
    count?: number,
  ): ReactElement => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        'scope-option h-8 max-md:min-h-touch-target rounded-full px-3 text-sm',
        props.scope === value ? 'border-primary bg-primary/10 font-medium' : '',
      )}
      aria-pressed={props.scope === value}
      data-testid={testId}
      onClick={(): void => {
        if (value === 'specific') {
          setPickerOpen((open): boolean => !open || props.scope !== 'specific');
          if (props.scope !== 'specific') {
            props.onChange({ scope: 'specific', picks: props.picks });
          }
          return;
        }
        setPickerOpen(false);
        props.onChange({ scope: value, picks: [] });
      }}
    >
      {value === 'preferred' ? <Star aria-hidden="true" className="mr-1 size-3.5" /> : null}
      {label}
      {count !== undefined ? (
        <span className="ml-1 text-muted-foreground">{String(count)}</span>
      ) : null}
    </Button>
  );

  return (
    <div className="scope-selector" data-testid="scope-selector" data-scope={props.scope}>
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Search scope"
      >
        {scopeButton('All sites', 'all', 'scope-all')}
        {scopeButton('Preferred', 'preferred', 'scope-preferred', props.preferred.length)}
        {scopeButton('Choose sites…', 'specific', 'scope-specific', props.picks.length > 0 ? props.picks.length : undefined)}
      </div>

      {props.scope === 'preferred' ? (
        props.preferred.length > 0 ? (
          <ul
            className="mt-2 m-0 flex list-none flex-wrap gap-1.5 p-0"
            aria-label="Preferred sites (canonical order)"
            data-testid="preferred-chips"
          >
            {props.preferred.map(
              (row): ReactElement => (
                <li key={row.id} className={row.unreachable ? 'opacity-70' : ''}>
                  <Badge
                    variant="secondary"
                    className="preferred-chip h-6 gap-1 rounded-full px-2 text-xs"
                    data-testid={`preferred-chip-${row.id}`}
                    data-unavailable={row.unreachable ? 'true' : undefined}
                    title={
                      row.unreachable
                        ? `${row.name}: last check failed — the site may be back (still searched)`
                        : row.name
                    }
                  >
                    {row.unreachable ? <WifiOff aria-hidden="true" className="size-3" /> : null}
                    {row.name}
                  </Badge>
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="preferred-empty-hint">
            No preferred sites yet — star sites in the site picker to build your list.
          </p>
        )
      ) : null}

      {props.scope === 'specific' && pickerOpen ? (
        <div
          className="mt-2 rounded-lg border bg-surface/40 p-3"
          data-testid="specific-picker"
        >
          <label htmlFor="scope-site-filter" className="mb-1.5 block text-sm font-medium">
            Filter sites
          </label>
          <Input
            id="scope-site-filter"
            type="search"
            className="mb-2 w-64"
            placeholder="Name or category"
            value={pickerFilter}
            onChange={(e): void => {
              setPickerFilter(e.target.value);
            }}
          />
          <SpecificPickList
            registry={props.registry}
            selected={props.picks}
            filter={pickerFilter.trim().toLowerCase()}
            onChange={props.onChange}
            onDone={(): void => {
              setPickerOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The specific multi-select list: registry rows ordered preferred-
 * first (allowlist order) then A→Z by name, checkbox-per-row, capped
 * at {@link MAX_RENDERED_PICKS} rendered matches.
 */
function SpecificPickList(props: {
  readonly registry: readonly ModuleSummaryT[];
  readonly selected: readonly string[];
  readonly filter: string;
  readonly onChange: (next: SearchScopeState) => void;
  readonly onDone: () => void;
}): ReactElement {
  const rows = useMemo((): readonly ModuleSummaryT[] => {
    const needle = props.filter;
    const matched = props.registry.filter(
      (m): boolean =>
        m.enabled &&
        (needle === '' ||
          m.name.toLowerCase().includes(needle) ||
          m.category.toLowerCase().includes(needle)),
    );
    const preferredRank = new Map(
      props.registry
        .filter((m): boolean => m.preferred)
        .map((m): readonly [string, number] => [m.id, props.registry.indexOf(m)]),
    );
    return [...matched].sort((a, b): number => {
      const pa = preferredRank.has(a.id) ? 0 : 1;
      const pb = preferredRank.has(b.id) ? 0 : 1;
      if (pa !== pb) {
        return pa - pb;
      }
      if (pa === 0) {
        const ra = preferredRank.get(a.id) ?? 0;
        const rb = preferredRank.get(b.id) ?? 0;
        if (ra !== rb) {
          return ra < rb ? -1 : 1;
        }
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }, [props.registry, props.filter]);

  const selectedSet = useMemo((): Set<string> => new Set(props.selected), [props.selected]);

  const toggle = (id: string): void => {
    const next =
      selectedSet.has(id) === false
        ? [...props.selected, id]
        : props.selected.filter((sid): boolean => sid !== id);
    props.onChange({ scope: 'specific', picks: next });
  };

  const capped = rows.slice(0, MAX_RENDERED_PICKS);

  return (
    <div>
      <ul
        className="m-0 max-h-72 list-none overflow-y-auto p-0"
        aria-label="Sites to search"
        data-testid="specific-pick-list"
      >
        {capped.map(
          (module): ReactElement => (
            <li key={module.id} className="flex items-center gap-2 px-1 py-1">
              <label
                className={cn(
                  'flex w-full items-center gap-2 text-sm max-md:min-h-touch-target',
                  module.availability.status === 'unreachable' ? 'opacity-70' : '',
                )}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-(--primary)"
                  data-testid={`specific-pick-${module.id}`}
                  checked={selectedSet.has(module.id)}
                  onChange={(): void => {
                    toggle(module.id);
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{module.name}</span>
                {module.preferred ? (
                  <Star aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
                <span className="shrink-0 text-xs text-muted-foreground">{module.category}</span>
                {module.availability.status === 'unreachable' ? (
                  <span
                    className="flex shrink-0 items-center"
                    title="Last check failed — the site may be back (still searched when picked)"
                  >
                    <WifiOff aria-hidden="true" className="size-3 text-muted-foreground" />
                  </span>
                ) : null}
                {!module.catalogInstalled ? (
                  <Badge variant="outline" className="shrink-0 text-xs">
                    live
                  </Badge>
                ) : null}
              </label>
            </li>
          ),
        )}
      </ul>
      {rows.length > capped.length ? (
        <p className="mt-1.5 text-xs text-muted-foreground" role="note">
          Showing {String(capped.length)} of {String(rows.length)} matches — type to narrow.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">No enabled site matches.</p>
      ) : null}
      {props.selected.length > 0 ? (
        <div className="mt-2 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={(): void => {
              props.onChange({ scope: 'specific', picks: [] });
            }}
          >
            <X aria-hidden="true" />
            Clear picks
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            data-testid="specific-done"
            onClick={(): void => {
              /* picks are live (URL-as-truth); Done simply closes */
              props.onDone();
            }}
          >
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}
