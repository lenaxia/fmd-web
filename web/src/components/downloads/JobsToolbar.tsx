/**
 * JobsToolbar (downloads parity, tsk-retro-fountain-tasks): the FMD2
 * tsDownload toolbar (frmMain.lfm:291-339) — Resume all / Stop
 * (Pause) all / Delete completed (confirm dialog, FMD2
 * RS_DlgRemoveFinishTasks) — plus the search box (title/chapter
 * substring; URL-synced by the page, debounced typing → replaceRoute).
 */
import type { ReactElement } from 'react';
import { CheckCheck, Pause, Play, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { JobBulkActionT } from '../../api/hooks';

export function JobsToolbar(props: {
  readonly q: string;
  readonly onQ: (next: string) => void;
  readonly onBulk: (action: JobBulkActionT) => void;
  readonly bulkPending: boolean;
  /** Completed (done) rows exist — gates Delete completed. */
  readonly hasCompleted: boolean;
  /** [UX-AUDIT D-3] exact done-row count for the confirm copy. */
  readonly completedCount: number;
  readonly confirmOpen: boolean;
  readonly onConfirmOpen: (open: boolean) => void;
}): ReactElement {
  return (
    <div className="jobs-toolbar mb-4 flex flex-wrap items-center gap-2" data-testid="jobs-toolbar">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          id="jobs-search"
          name="jobs-search"
          className="jobs-search w-56 pl-8"
          placeholder="Search title or chapter…"
          aria-label="Search jobs by title or chapter"
          value={props.q}
          onChange={(e): void => {
            props.onQ(e.target.value);
          }}
        />
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="resume-all"
          disabled={props.bulkPending}
          onClick={(): void => {
            props.onBulk('resume');
          }}
        >
          <Play aria-hidden="true" />
          Resume all
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="pause-all"
          disabled={props.bulkPending}
          onClick={(): void => {
            props.onBulk('pause');
          }}
        >
          <Pause aria-hidden="true" />
          Pause all
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive"
          data-testid="delete-completed"
          disabled={props.bulkPending || !props.hasCompleted}
          onClick={(): void => {
            props.onConfirmOpen(true);
          }}
        >
          <Trash2 aria-hidden="true" />
          Delete completed
        </Button>
      </div>

      <Dialog open={props.confirmOpen} onOpenChange={props.onConfirmOpen}>
        <DialogContent className="max-w-sm" data-testid="delete-completed-dialog">
          <DialogHeader>
            <DialogTitle>Delete completed jobs?</DialogTitle>
            <DialogDescription data-testid="delete-completed-count">
              This will delete {String(props.completedCount)} completed job
              {props.completedCount === 1 ? '' : 's'}. The downloaded files stay in the library;
              delete job + file is the per-row choice.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={(): void => { props.onConfirmOpen(false); }}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="delete-completed-confirm"
              disabled={props.bulkPending}
              onClick={(): void => {
                props.onBulk('delete');
                props.onConfirmOpen(false);
              }}
            >
              <CheckCheck aria-hidden="true" />
              {props.bulkPending ? 'Deleting…' : 'Delete completed'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
