/**
 * CatalogEntryRow (browse-list polish): the ONE composed entry row
 * behind the site browse list AND the all-sites union list —
 *
 * - metadata hover popover (EntryMetadataPopover — vtMangaListGetHint
 *   parity, catalog data only, never a fetch);
 * - row accents (vtMangaListBeforeCellPaint parity, frmMain.pas:5114-
 *   5152): the completed accent is UNGATED and OVERRIDES the new accent
 *   exactly like FMD2 paints completed last; the new accent + badge are
 *   gated by the persisted highlight-new toggle and the only-new jdn
 *   window (the filter's day setting, FMD2's single OptionNewMangaTime
 *   feeding both cbOnlyNew and the paint, pas:6329-6330);
 * - the row overflow menu (EntryRowMenu — pmMangaList parity).
 *
 * Accent tokens come from the design system (bg-primary/5, bg-success/5
 * — no ad-hoc colors; the gate script enforces token-only styling).
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { navigate } from '../../router';
import { isNewEntry } from '../../state/highlight-new';
import { useMediaQuery } from '../../state/use-media-query';
import { EntryRow } from '@/components/patterns/EntryRow';
import { EntryMetadataPopover } from '@/components/catalog/EntryMetadataPopover';
import { EntryRowMenu } from '@/components/catalog/EntryRowMenu';
import { cn } from 'cn';

/** The catalog-carried fields the composed row needs (CatalogEntry shape). */
export interface CatalogEntryRowEntry {
  readonly link: string;
  readonly title: string;
  readonly alttitles: string;
  readonly authors: string;
  readonly artists: string;
  readonly genres: string;
  readonly status: string;
  readonly summary: string;
  readonly numChapter: number;
  readonly jdn: number;
}

export interface CatalogEntryRowProps {
  readonly entry: CatalogEntryRowEntry;
  /** The site module id (navigation context + favorites + batch key). */
  readonly siteId: string;
  /** Persisted highlight-new toggle (list-level control owns it). */
  readonly highlightNew: boolean;
  /** The filter's only-new day window; undefined = FMD2 default (1 day). */
  readonly newDays?: number | undefined;
  /** Extra leading/badge slot (the union row's WebsiteBadge). */
  readonly badges?: ReactNode;
  /** All-sites union mode: the popover's website line (pas:5166-5170). */
  readonly website?: string;
}

/**
 * The accent matrix (pas:5114-5152): 'completed' paints UNGATED and
 * overrides 'new'; 'new' paints only under the toggle + jdn window.
 */
export function entryAccent(
  entry: Pick<CatalogEntryRowEntry, 'status' | 'jdn'>,
  opts: { highlightNew: boolean; newDays?: number | undefined },
): { readonly accent: 'new' | 'completed' | undefined; readonly showNewBadge: boolean } {
  const withinWindow: boolean = isNewEntry(entry.jdn, opts.newDays);
  if (entry.status === 'Completed') {
    return { accent: 'completed', showNewBadge: false };
  }
  if (opts.highlightNew && withinWindow) {
    return { accent: 'new', showNewBadge: true };
  }
  return { accent: undefined, showNewBadge: false };
}

export function CatalogEntryRow(props: CatalogEntryRowProps): ReactElement {
  const { entry } = props;
  const { accent, showNewBadge } = entryAccent(
    entry,
    { highlightNew: props.highlightNew, ...(props.newDays !== undefined ? { newDays: props.newDays } : {}) },
  );
  // The popover and the row menu are independent affordances — the menu
  // WINS: while it is open the metadata popover is suppressed (two
  // overlapping overlays would fight for the row). R3a activation is
  // pointer-class driven: hover pointers keep the hover popover (row
  // click navigates, unchanged); touch pointers have no hover — the row
  // TAP opens the metadata (Radix Popover semantics) and the popover's
  // own Open button navigates. '(hover: none)' keeps hover-capable as
  // the stable first-render default (no branch-flip remount).
  const noHover: boolean = useMediaQuery('(hover: none)');
  const [hoverOpen, setHoverOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const open = (): void => {
    navigate('manga', {
      catalog: props.siteId,
      module: props.siteId,
      url: entry.link,
      title: entry.title,
    });
  };
  return (
    <EntryMetadataPopover
      entry={entry}
      {...(props.website !== undefined ? { website: props.website } : {})}
      open={hoverOpen && !menuOpen}
      onOpenChange={setHoverOpen}
      {...(noHover ? { onOpen: open } : {})}
    >
      <EntryRow
        onClick={noHover ? (): void => {
          setHoverOpen((previous): boolean => !previous && !menuOpen);
        } : open}
        buttonClassName={cn(
          'catalog-entry',
          accent === 'new' && 'bg-primary/5',
          accent === 'completed' && 'bg-success/5',
        )}
        data={{ 'data-entry-link': entry.link, ...(accent !== undefined ? { 'data-accent': accent } : {}) }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="entry-title">{entry.title}</span>
            {showNewBadge ? (
              <span
                data-new-badge="true"
                className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              >
                new
              </span>
            ) : null}
            {props.badges}
          </span>
        }
        meta={
          <span className="entry-meta">
            {entry.authors !== '' ? entry.authors : 'unknown author'} · {entry.status} · {entry.numChapter} chapters
          </span>
        }
        trailing={
          <EntryRowMenu
            moduleId={props.siteId}
            mangaUrl={entry.link}
            mangaTitle={entry.title}
            onOpen={open}
            onMenuOpenChange={setMenuOpen}
            className="my-0.5"
          />
        }
      />
    </EntryMetadataPopover>
  );
}
