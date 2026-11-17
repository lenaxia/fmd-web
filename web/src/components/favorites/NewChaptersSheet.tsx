/**
 * NewChaptersSheet (favorites-parity): the frmNewChapter ADAPT — FMD2
 * raises one modal PER favorite with new chapters; the web parity is a
 * SINGLE bottom sheet listing every favorite the check found new
 * chapters for (title, site, count) with per-row AND global decisions:
 * Download (active jobs) / Add to queue (paused jobs) / Dismiss.
 * Favorites with auto-download on were already queued server-side by
 * the check — their rows render pre-queued and keep no pending action.
 *
 * R3 mobile: the bottom sheet is DRAG-DISMISSABLE — a grabber handle
 * tracks a downward pointer drag on the sheet and closes past the
 * threshold (the thumb-native dismissal path; the Close button and
 * scrim tap remain). Pointer events cover touch, pen and mouse.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Download, ListPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';

/** Downward drag (px) past which a release dismisses the sheet. */
const DRAG_DISMISS_THRESHOLD = 72;

/** What the user decided for one favorite's new chapters. */
export type NewChapterDecision =
  | 'pending'
  | 'download'
  | 'queued'
  | 'dismissed'
  | 'auto-queued';

/** One sheet row: a favorite with new chapters found by a check. */
export interface NewChapterRow {
  readonly favoriteId: string;
  readonly title: string;
  readonly website: string;
  /** New chapters found (the count the row badge shows). */
  readonly count: number;
  /** The favorite's auto-download flag at check time. */
  readonly autoDownload: boolean;
  /** true when the check itself already queued these chapters. */
  readonly preQueued: boolean;
  /** The new chapters (live order) — the download/queue payloads. */
  readonly newChapters: ReadonlyArray<{ readonly position: number; readonly link: string; readonly name: string }>;
}

export type NewChapterAction = 'download' | 'queued' | 'dismissed';

/**
 * The sheet's decision state machine: auto rows start decided
 * (`auto-queued`), everything else `pending`; per-row and global
 * decisions land through `decide`/`decideAll`. State RESETS when the
 * rows array identity changes (a new check result opens a fresh sheet).
 */
export function useNewChapterDecisions(rows: readonly NewChapterRow[]): {
  readonly decisions: Readonly<Record<string, NewChapterDecision>>;
  readonly decide: (id: string, action: NewChapterAction) => void;
  readonly decideAll: (action: NewChapterAction) => void;
  readonly pendingCount: number;
} {
  const [decisions, setDecisions] = useState<Record<string, NewChapterDecision>>({});

  useEffect((): void => {
    const initial: Record<string, NewChapterDecision> = {};
    for (const row of rows) {
      initial[row.favoriteId] = row.preQueued ? 'auto-queued' : 'pending';
    }
    setDecisions(initial);
  }, [rows]);

  const decide = (id: string, action: NewChapterAction): void => {
    setDecisions((current): Record<string, NewChapterDecision> => ({
      ...current,
      [id]: action,
    }));
  };

  const decideAll = (action: NewChapterAction): void => {
    setDecisions((current): Record<string, NewChapterDecision> => {
      const next: Record<string, NewChapterDecision> = { ...current };
      for (const row of rows) {
        if (next[row.favoriteId] === 'pending') {
          next[row.favoriteId] = action;
        }
      }
      return next;
    });
  };

  const pendingCount = useMemo(
    (): number => rows.filter((row): boolean => decisions[row.favoriteId] === 'pending').length,
    [rows, decisions],
  );

  return { decisions, decide, decideAll, pendingCount };
}

function DecisionBadge(props: { decision: NewChapterDecision }): ReactElement | null {
  const { decision } = props;
  if (decision === 'auto-queued') {
    return (
      <Badge variant="secondary" data-testid={`newchapter-auto-${decision}`}>
        auto-queued (auto-download)
      </Badge>
    );
  }
  if (decision === 'download') {
    return (
      <Badge variant="success" data-testid={`newchapter-${decision}`}>
        downloading
      </Badge>
    );
  }
  if (decision === 'queued') {
    return (
      <Badge variant="outline" data-testid={`newchapter-${decision}`}>
        in queue
      </Badge>
    );
  }
  if (decision === 'dismissed') {
    return (
      <Badge variant="outline" data-testid={`newchapter-${decision}`}>
        dismissed
      </Badge>
    );
  }
  return null;
}

export function NewChaptersSheet(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly rows: readonly NewChapterRow[];
  /** Start ACTIVE downloads for one favorite's new chapters. */
  readonly onDownload: (row: NewChapterRow) => void;
  /** Add one favorite's new chapters to the queue (paused jobs). */
  readonly onQueue: (row: NewChapterRow) => void;
}): ReactElement {
  const { open, onClose, rows, onDownload, onQueue } = props;
  const { decisions, decide, decideAll, pendingCount } = useNewChapterDecisions(rows);

  // Drag-dismiss (R3): track a DOWNWARD pointer drag from the grabber;
  // release past the threshold closes the sheet, otherwise it snaps
  // back. The refs hold the grabbing pointer id + its start Y so only
  // the grabbing pointer moves the sheet; the state drives the translate.
  const dragPointer = useRef<number | null>(null);
  const dragStartY = useRef(0);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  useEffect((): void => {
    if (!open) {
      dragPointer.current = null;
      setDragY(0);
      setDragging(false);
    }
  }, [open]);

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    dragPointer.current = event.pointerId;
    dragStartY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onHandlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragPointer.current !== event.pointerId) {
      return;
    }
    // Downward only — an upward drag fights the open animation.
    setDragY(Math.max(0, event.clientY - dragStartY.current));
  };
  const onHandlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragPointer.current !== event.pointerId) {
      return;
    }
    dragPointer.current = null;
    setDragging(false);
    // Read the drag from the pointer positions (not the state) — the
    // last pointermove's setState may not have flushed into this
    // handler's closure yet.
    if (Math.max(0, event.clientY - dragStartY.current) > DRAG_DISMISS_THRESHOLD) {
      onClose();
    } else {
      setDragY(0);
    }
  };

  const act = (row: NewChapterRow, action: NewChapterAction): void => {
    decide(row.favoriteId, action);
    if (action === 'download') {
      onDownload(row);
    } else if (action === 'queued') {
      onQueue(row);
    }
  };

  const actAll = (action: NewChapterAction): void => {
    decideAll(action);
    for (const row of rows) {
      if (decisions[row.favoriteId] === 'pending') {
        if (action === 'download') {
          onDownload(row);
        } else if (action === 'queued') {
          onQueue(row);
        }
      }
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next): void => { if (!next) onClose(); }}>
      <SheetContent
        side="bottom"
        className="new-chapters-sheet flex max-h-[70vh] flex-col gap-0"
        data-testid="new-chapters-sheet"
        style={{
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? 'none' : 'transform 200ms ease-out',
        }}
      >
        {/* Drag-dismiss grabber (R3): the whole header strip drags.
         * Decorative (aria-hidden) — dismissal paths are the drag itself,
         * the Close button, the scrim and Escape (Radix Dialog). */}
        <div
          data-testid="new-chapters-drag-handle"
          aria-hidden="true"
          className="flex min-h-touch-target w-full cursor-grab touch-none flex-col items-center justify-center"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
        >
          <span className="h-1.5 w-10 rounded-full bg-muted-foreground/40" />
        </div>
        <SheetHeader className="pb-2 pt-0">
          <SheetTitle className="new-chapters-title">
            New chapters found ({rows.length} {rows.length === 1 ? 'title' : 'titles'})
          </SheetTitle>
          <SheetDescription>
            frmNewChapter parity: download the new chapters, add them to the
            queue (paused), or dismiss. Auto-download rows were already queued
            by the check.
          </SheetDescription>
        </SheetHeader>
        <ul className="new-chapters-list min-h-0 flex-1 divide-y overflow-y-auto" aria-label="Titles with new chapters">
          {rows.map((row): ReactElement => {
            const decision = decisions[row.favoriteId] ?? 'pending';
            const disabled = decision !== 'pending';
            return (
              <li
                key={row.favoriteId}
                data-favorite-id={row.favoriteId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2"
              >
                <span className="new-chapter-count min-w-0 flex-1">
                  <span className="font-medium">{row.title}</span>{' '}
                  <span className="text-muted-foreground">&lt;{row.website}&gt;</span>{' '}
                  has <span data-testid={`newchapter-count-${row.favoriteId}`} className="font-semibold tabular-nums">{row.count}</span>{' '}
                  new {row.count === 1 ? 'chapter' : 'chapters'}
                </span>
                <DecisionBadge decision={decision} />
                <span className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7"
                    disabled={disabled}
                    data-testid={`newchapter-download-${row.favoriteId}`}
                    onClick={(): void => act(row, 'download')}
                  >
                    <Download aria-hidden="true" />
                    Download
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={disabled}
                    data-testid={`newchapter-queue-${row.favoriteId}`}
                    onClick={(): void => act(row, 'queued')}
                  >
                    <ListPlus aria-hidden="true" />
                    Add to queue
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    disabled={disabled}
                    aria-label={`Dismiss new chapters for ${row.title}`}
                    onClick={(): void => decide(row.favoriteId, 'dismissed')}
                  >
                    <X aria-hidden="true" />
                    Dismiss
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
        <SheetFooter className="flex flex-row flex-wrap items-center justify-end gap-2 border-t pt-3">
          <span className="mr-auto text-xs text-muted-foreground" data-testid="newchapter-pending-count">
            {pendingCount} pending {pendingCount === 1 ? 'decision' : 'decisions'}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={pendingCount === 0}
            data-testid="newchapter-download-all"
            onClick={(): void => actAll('download')}
          >
            <Download aria-hidden="true" />
            Download all
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pendingCount === 0}
            data-testid="newchapter-queue-all"
            onClick={(): void => actAll('queued')}
          >
            <ListPlus aria-hidden="true" />
            Add all to queue
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="newchapter-dismiss-all"
            onClick={onClose}
          >
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
