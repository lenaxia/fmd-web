/**
 * ChapterToolbar (MangaPage parity, FMD2 pmChapterList —
 * frmMain.lfm:1649-1703, FilterBar pattern): the chapter-list controls
 * — case-insensitive substring filter (pas:1939), Ascending/Descending
 * (pas:1552), hide-downloaded toggle, invert (acts on the visible
 * rows), select-new (chapters newer than the favorite's downloaded
 * list — enabled only when favorited), select-all and clear.
 * Pure view concerns only; state lives in the page over
 * chapter-view-state.ts.
 */
import type { ReactElement } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, CheckCheck, Eraser, FlipVertical2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from 'cn';
import type { ChapterViewOptions } from '@/state/chapter-view-state';

export function ChapterToolbar(props: {
  options: ChapterViewOptions;
  visibleCount: number;
  downloadedCount: number;
  favorited: boolean;
  onOptionsChange: (options: ChapterViewOptions) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onInvert: () => void;
  onSelectNew: () => void;
  className?: string;
}): ReactElement {
  const set = (patch: Partial<ChapterViewOptions>): void => {
    props.onOptionsChange({ ...props.options, ...patch });
  };

  return (
    <div
      role="group"
      aria-label="Chapter list controls"
      className={cn('flex flex-wrap items-center gap-2', props.className)}
    >
      <Input
        type="search"
        aria-label="Filter chapters"
        placeholder="Filter chapters…"
        value={props.options.query}
        onChange={(e): void => {
          set({ query: e.target.value });
        }}
        className="h-8 w-44"
      />
      <Button
        type="button"
        variant={props.options.ascending ? 'outline' : 'secondary'}
        size="sm"
        aria-pressed={!props.options.ascending}
        onClick={(): void => {
          set({ ascending: !props.options.ascending });
        }}
      >
        {props.options.ascending ? (
          <ArrowUpNarrowWide aria-hidden="true" />
        ) : (
          <ArrowDownWideNarrow aria-hidden="true" />
        )}
        {props.options.ascending ? 'Ascending' : 'Descending'}
      </Button>
      <Button
        type="button"
        variant={props.options.hideDownloaded ? 'secondary' : 'outline'}
        size="sm"
        aria-pressed={props.options.hideDownloaded}
        onClick={(): void => {
          set({ hideDownloaded: !props.options.hideDownloaded });
        }}
      >
        Hide downloaded
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={props.onInvert}>
        <FlipVertical2 aria-hidden="true" />
        Invert
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={props.onSelectNew}
        disabled={!props.favorited}
        title={props.favorited ? 'Select chapters not yet downloaded' : 'Add to favorites to select new chapters'}
      >
        <Sparkles aria-hidden="true" />
        Select new
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={props.onSelectAll}>
        <CheckCheck aria-hidden="true" />
        Select all
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={props.onClear}>
        <Eraser aria-hidden="true" />
        Clear
      </Button>
      <span aria-hidden="true" className="text-xs text-muted-foreground">
        {props.visibleCount} shown
        {props.downloadedCount > 0 ? ` · ${props.downloadedCount} downloaded` : ''}
      </span>
    </div>
  );
}
