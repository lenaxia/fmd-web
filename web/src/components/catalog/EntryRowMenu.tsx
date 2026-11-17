/**
 * EntryRowMenu (browse-list polish, FMD2 pmMangaList parity —
 * frmMain.lfm:5787-5812): the row overflow menu behind the ⋮ trigger.
 * v1 items: Open (miMangaListViewInfos), Download all chapters
 * (miMangaListDownloadAll — one BATCH request per manga via
 * POST /api/jobs/download/batch, idempotent per manga so a re-click
 * replays the same jobs), Add to Favorites (miMangaListAddToFavorites
 * — disabled with a tooltip when already favorited, FMD2's menu item
 * is likewise state-aware).
 *
 * NO 'Delete local list' in v1: destructive server-side data —
 * deliberately deferred (docs/UX-PARITY.md Part 3 row) until a
 * confirm+undo pattern exists.
 */
import type { ReactElement } from 'react';
import { Download, Heart, MoreHorizontal, SquareArrowOutUpRight } from 'lucide-react';
import { toast } from 'sonner';
import { useCreateDownloadBatch, useFavoriteState } from '../../api/hooks';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from 'cn';

export interface EntryRowMenuProps {
  readonly moduleId: string;
  readonly mangaUrl: string;
  readonly mangaTitle?: string;
  /** Open (existing row navigation — miMangaListViewInfos parity). */
  readonly onOpen: () => void;
  /** Signals open-state so the composed row can suppress the hover popover. */
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly className?: string;
}

export function EntryRowMenu(props: EntryRowMenuProps): ReactElement {
  const batch = useCreateDownloadBatch();
  const favorite = useFavoriteState(props.moduleId, props.mangaUrl);

  const downloadAll = (): void => {
    void batch
      .mutateAsync({
        moduleId: props.moduleId,
        mangaUrl: props.mangaUrl,
        ...(props.mangaTitle !== undefined && props.mangaTitle !== '' ? { mangaTitle: props.mangaTitle } : {}),
        chapters: 'all',
      })
      .then((result): void => {
        const n: number = result.jobs.length;
        if (result.replayed) {
          toast.info(`Already queued — showing the existing ${n} download${n === 1 ? '' : 's'} for ${props.mangaTitle ?? 'this manga'}.`);
        } else {
          toast.success(`Queued ${n} chapter download${n === 1 ? '' : 's'} for ${props.mangaTitle ?? 'this manga'}.`);
        }
      })
      .catch((): void => {
        toast.error(`Couldn’t queue downloads for ${props.mangaTitle ?? 'this manga'} — try again in a moment.`);
      });
  };

  const addFavorite = (): void => {
    void favorite
      .add({
        ...(props.mangaTitle !== undefined && props.mangaTitle !== '' ? { title: props.mangaTitle } : {}),
      })
      .then((): void => {
        toast.success(`Added ${props.mangaTitle ?? 'this manga'} to favorites.`);
      })
      .catch((): void => {
        toast.error(`Couldn’t add ${props.mangaTitle ?? 'this manga'} to favorites — try again in a moment.`);
      });
  };

  return (
    <DropdownMenu
      onOpenChange={(open): void => {
        props.onMenuOpenChange?.(open);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${props.mangaTitle ?? props.mangaUrl}`}
          aria-haspopup="menu"
          className={cn('shrink-0', props.className)}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="entry-row-menu">
        <DropdownMenuItem onSelect={props.onOpen}>
          <SquareArrowOutUpRight aria-hidden="true" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={downloadAll} disabled={batch.isPending} data-testid="menu-download-all">
          <Download aria-hidden="true" />
          {batch.isPending ? 'Queueing…' : 'Download all chapters'}
        </DropdownMenuItem>
        {favorite.isFavorited ? (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Span wrapper: disabled menu items swallow pointer events. */}
                <span className="block" data-testid="menu-add-favorite-wrap">
                  <DropdownMenuItem disabled data-testid="menu-add-favorite">
                    <Heart aria-hidden="true" />
                    Add to favorites
                  </DropdownMenuItem>
                </span>
              </TooltipTrigger>
              <TooltipContent>Already in favorites</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <DropdownMenuItem onSelect={addFavorite} disabled={favorite.isMutating} data-testid="menu-add-favorite">
            <Heart aria-hidden="true" />
            Add to favorites
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
