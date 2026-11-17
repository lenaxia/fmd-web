/**
 * NewChaptersSheet (favorites-parity): the frmNewChapter ADAPT — FMD2
 * raises one modal PER favorite with new chapters; the web parity is a
 * SINGLE bottom sheet listing every favorite the check found new
 * chapters for (title, site, count) with per-row AND global decisions:
 * Download (active jobs) / Add to queue (paused jobs) / Dismiss.
 * Favorites with auto-download on were already queued server-side by
 * the check — their rows render pre-queued and keep no pending action.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
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
      >
        <SheetHeader className="pb-2">
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
