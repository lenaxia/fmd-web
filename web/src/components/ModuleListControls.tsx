/**
 * ModuleListControls (FMD2 Websites-tree parity, pas:6400): the module
 * list search box (name/category contains — the FMD2 tree filter) plus
 * the bulk enable/disable controls — global Select all / None (the
 * tree's Select All / Unselect All checkboxes) and one
 * CategoryBulkControls header per category group (the tree's category
 * node checkboxes). All bulk writes go through POST /api/modules/bulk
 * (one module_state rewrite); react-query invalidation makes the site
 * picker reflect the change immediately.
 */
import { CheckCheck, Search, Square, X } from 'lucide-react';
import type { ReactElement } from 'react';
import { useBulkUpdateModules } from '../api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** The name/category search box (FMD2 tree filter adaptation). */
export function ModuleListSearch(props: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly resultCount: number;
  readonly totalCount: number;
}): ReactElement {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="module-search">
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Search modules by name or category"
          placeholder="Search modules…"
          className="w-64 pl-8"
          value={props.value}
          onChange={(e): void => {
            props.onChange(e.target.value);
          }}
        />
      </div>
      <span className="text-xs text-muted-foreground" role="status">
        {props.value === ''
          ? `${props.totalCount} modules`
          : `${props.resultCount}/${props.totalCount} modules match “${props.value}”`}
      </span>
    </div>
  );
}

/** Global Select-all / None (FMD2 Select All / Unselect All). */
export function GlobalBulkControls(props: { readonly busy: boolean }): ReactElement {
  const bulk = useBulkUpdateModules();
  const busy: boolean = props.busy || bulk.isPending;
  const run = (enabled: boolean): void => {
    bulk.mutate({ enabled });
  };
  return (
    <div className="flex items-center gap-2" data-testid="module-bulk-global">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={(): void => run(true)}>
        <CheckCheck aria-hidden="true" />
        Select all
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={(): void => run(false)}>
        <Square aria-hidden="true" />
        None
      </Button>
      {bulk.isError ? <span role="alert" className="text-xs text-destructive">Bulk update failed</span> : null}
    </div>
  );
}

/** One category group header: name, count, Enable/Disable category. */
export function CategoryBulkControls(props: {
  readonly category: string;
  readonly count: number;
  readonly busy: boolean;
}): ReactElement {
  const bulk = useBulkUpdateModules();
  const busy: boolean = props.busy || bulk.isPending;
  const run = (enabled: boolean): void => {
    bulk.mutate({ enabled, category: props.category });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-surface/60 px-3 py-2" data-testid="module-category-header">
      <span className="text-sm font-semibold">{props.category}</span>
      <span className="text-xs text-muted-foreground">({props.count})</span>
      <span className="ml-auto flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          disabled={busy}
          aria-label={`Enable all modules in ${props.category}`}
          onClick={(): void => run(true)}
        >
          Enable all
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          disabled={busy}
          aria-label={`Disable all modules in ${props.category}`}
          onClick={(): void => run(false)}
        >
          <X aria-hidden="true" />
          Disable all
        </Button>
      </span>
    </div>
  );
}
