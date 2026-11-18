/**
 * ModuleListControls (Settings→Websites): the module-list bulk controls
 * — GLOBAL Enable all / Disable all scoped to the CURRENT facet+search
 * selection (ids[] bulk write; unfiltered = every module, the FMD2
 * Websites-tree Select All / Unselect All), with a confirm dialog on
 * the destructive direction (disable), plus one CategoryBulkControls
 * header per category group in the list (the tree's category nodes).
 * All bulk writes go through POST /api/modules/bulk (one module_state
 * rewrite); react-query invalidation makes the site picker reflect the
 * change immediately.
 */
import { CheckCheck, Square, X } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useBulkUpdateModules } from '../api/hooks';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Global Enable/Disable scoped to the filtered selection. When a filter
 * is active the write targets exactly the shown ids; with no filter it
 * is the registry-wide FMD2 Select All / Unselect All.
 */
export function GlobalBulkControls(props: {
  readonly busy: boolean;
  /** Ids of the CURRENT filtered selection (the bulk write scope). */
  readonly targetIds: readonly string[];
  /** True when a facet/search filter is active (scopes the write to ids). */
  readonly filtered: boolean;
  /** Human label for the confirm dialog ("all sites" / "N filtered sites"). */
  readonly scopeLabel: string;
}): ReactElement {
  const bulk = useBulkUpdateModules();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busy: boolean = props.busy || bulk.isPending;
  const run = (enabled: boolean): void => {
    bulk.mutate({
      enabled,
      ...(props.filtered ? { ids: props.targetIds } : {}),
    });
  };
  return (
    <div className="flex items-center gap-2" data-testid="module-bulk-global">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={(): void => run(true)}>
        <CheckCheck aria-hidden="true" />
        Enable all
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={(): void => {
          setConfirmOpen(true);
        }}
      >
        <Square aria-hidden="true" />
        Disable all
      </Button>
      {bulk.isError ? <span role="alert" className="text-xs text-destructive">Bulk update failed</span> : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm" data-testid="module-disable-all-dialog">
          <DialogHeader>
            <DialogTitle>Disable {props.scopeLabel}?</DialogTitle>
            <DialogDescription>
              Every site in the current selection is switched off: it disappears from Browse and
              Favorites checks until re-enabled. Nothing is deleted; re-enable anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={(): void => { setConfirmOpen(false); }}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="module-disable-all-confirm"
              disabled={busy}
              onClick={(): void => {
                run(false);
                setConfirmOpen(false);
              }}
            >
              <Square aria-hidden="true" />
              Disable {props.filtered ? `${String(props.targetIds.length)} sites` : 'all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One category group header: display label (empty categories show as
 * 'Unknown'), count, Enable/Disable category. The BULK WRITE targets
 * the RAW category (the server matches module.category exactly — the
 * label is presentation only).
 */
export function CategoryBulkControls(props: {
  readonly category: string;
  readonly label?: string;
  readonly count: number;
  readonly busy: boolean;
}): ReactElement {
  const bulk = useBulkUpdateModules();
  const busy: boolean = props.busy || bulk.isPending;
  const display: string = props.label ?? props.category;
  const run = (enabled: boolean): void => {
    bulk.mutate({ enabled, category: props.category });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-surface/60 px-3 py-2" data-testid="module-category-header">
      <span className="text-sm font-semibold">{display}</span>
      <span className="text-xs text-muted-foreground">({props.count})</span>
      <span className="ml-auto flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          disabled={busy}
          aria-label={`Enable all modules in ${display}`}
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
          aria-label={`Disable all modules in ${display}`}
          onClick={(): void => run(false)}
        >
          <X aria-hidden="true" />
          Disable all
        </Button>
      </span>
    </div>
  );
}
