/**
 * File-state badge (file-state story): the chapter/file truth pill —
 * downloaded (stat-verified on disk), missing (ledger entry, file not
 * at its recorded path), not_downloaded (no ledger entry — chapter
 * side), orphan (file under the root no ledger row claims).
 *
 * R3 note: the verification age rides a Tooltip on the badge AND the
 * section line above it — the tooltip is never the only path (the age
 * is visible text on the Files section header line).
 */
import type { ReactElement } from 'react';
import { cn } from 'cn';

export type FileState = 'downloaded' | 'missing' | 'not_downloaded' | 'orphan';

const STATE_STYLES: Record<FileState, string> = {
  downloaded: 'bg-primary/10 text-primary',
  missing: 'bg-destructive/15 text-destructive',
  not_downloaded: 'bg-muted text-muted-foreground',
  orphan: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

export function FileStateBadge(props: { state: FileState; className?: string }): ReactElement {
  return (
    <span
      data-state={props.state}
      className={cn(
        'file-state-badge inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
        STATE_STYLES[props.state],
        props.className,
      )}
    >
      {props.state === 'not_downloaded' ? 'not downloaded' : props.state}
    </span>
  );
}
