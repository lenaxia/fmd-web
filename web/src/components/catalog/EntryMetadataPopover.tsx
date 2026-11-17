/**
 * EntryMetadataPopover (browse-list polish, FMD2 vtMangaListGetHint
 * parity — frmMain.pas:5161-5226): the rich metadata popover over
 * catalog entry rows — R3a dual-activation by pointer class:
 *
 *   hover-capable pointers  → Radix HoverCard (owner adaptation
 *                             ruling: hover popovers, never native
 *                             desktop tooltips) — desktop unchanged;
 *   touch / no-hover        → Radix POPOVER semantics: the row TAP
 *                             opens the metadata (a hover-only
 *                             affordance has no touch path — R3a
 *                             closes it), and `onOpen` supplies the
 *                             navigation affordance inside the popover
 *                             (the row's own tap is the preview).
 *
 * Content is CATALOG DATA ONLY — every §5.8 field the row already
 * carries renders from the list payload; opening NEVER fetches. Field
 * parity with the FMD2 hint: the website line leads in all-sites mode
 * (FilterAllSites branch, pas:5166-5170), then Title always, then
 * AltTitles / Authors / Artists / Genres / Status / Summary each ONLY
 * when non-empty (pas:5172-5226).
 */
import type { ReactElement, ReactNode } from 'react';
import { SquareArrowOutUpRight } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useMediaQuery } from '@/state/use-media-query';

/** The catalog-carried §5.8 fields the popover renders (CatalogEntry shape). */
export interface EntryMetadata {
  readonly link: string;
  readonly title: string;
  readonly alttitles: string;
  readonly authors: string;
  readonly artists: string;
  readonly genres: string;
  readonly status: string;
  readonly summary: string;
}

export interface EntryMetadataPopoverProps {
  readonly entry: EntryMetadata;
  /** The row trigger (the whole entry row button). */
  readonly children: ReactNode;
  /** Website line (all-sites union mode only — pas:5166-5170). */
  readonly website?: string;
  /** Controlled open (the composed row suppresses the popover while the row menu is open). */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Touch-branch navigation affordance (R3a): the action the row's own
   * click used to carry — rendered as the popover's leading "Open"
   * button. Hover pointers ignore it (their row click still navigates).
   */
  readonly onOpen?: () => void;
}

function Section(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="mt-2" data-metadata-field={props.label}>
      <dt className="text-xs font-medium text-muted-foreground">{props.label}</dt>
      <dd className="text-xs">{props.value}</dd>
    </div>
  );
}

/** The §5.8 field set — IDENTICAL markup in the hover and tap branches. */
function MetadataFields(props: { readonly entry: EntryMetadata; readonly website?: string }): ReactElement {
  const { entry } = props;
  return (
    <dl className="min-w-0">
      {props.website !== undefined ? (
        <div data-metadata-field="Website">
          <dt className="text-xs font-medium text-muted-foreground">Website</dt>
          <dd className="text-xs">{props.website}</dd>
        </div>
      ) : null}
      <div data-metadata-field="Title">
        <dt className={props.website !== undefined ? 'text-xs font-medium text-muted-foreground' : 'sr-only'}>
          Title
        </dt>
        <dd className={props.website !== undefined ? 'text-xs font-medium' : 'text-sm font-medium'}>
          {entry.title}
        </dd>
      </div>
      {entry.alttitles !== '' ? <Section label="Alternative titles" value={entry.alttitles} /> : null}
      {entry.authors !== '' ? <Section label="Authors" value={entry.authors} /> : null}
      {entry.artists !== '' ? <Section label="Artists" value={entry.artists} /> : null}
      {entry.genres !== '' ? <Section label="Genres" value={entry.genres} /> : null}
      {entry.status !== '' ? <Section label="Status" value={entry.status} /> : null}
      {entry.summary !== '' ? <Section label="Summary" value={entry.summary} /> : null}
    </dl>
  );
}

export function EntryMetadataPopover(props: EntryMetadataPopoverProps): ReactElement {
  const { entry } = props;
  // '(hover: none)' — NOT '(hover: hover)': hover-capable pointers are
  // the STABLE default (first render + jsdom), so desktop never pays a
  // branch-flip remount; only touch surfaces adapt after the media
  // query settles.
  const noHover: boolean = useMediaQuery('(hover: none)');

  if (!noHover) {
    return (
      <HoverCard
        openDelay={200}
        closeDelay={100}
        {...(props.open !== undefined ? { open: props.open } : {})}
        {...(props.onOpenChange !== undefined ? { onOpenChange: props.onOpenChange } : {})}
      >
        <HoverCardTrigger asChild>{props.children}</HoverCardTrigger>
        <HoverCardContent
          data-testid="entry-metadata"
          data-entry-link={entry.link}
          aria-label={`About ${entry.title}`}
          className="max-h-96 overflow-y-auto"
        >
          <MetadataFields entry={entry} {...(props.website !== undefined ? { website: props.website } : {})} />
        </HoverCardContent>
      </HoverCard>
    );
  }

  // Touch branch (R3a): Radix Popover semantics — the row's own click
  // (owned by the composed row, so it never fights the kebab menu)
  // drives the controlled open; the ANCHOR is the row.
  return (
    <Popover
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.onOpenChange !== undefined ? { onOpenChange: props.onOpenChange } : {})}
    >
      <PopoverAnchor asChild>{props.children}</PopoverAnchor>
      <PopoverContent
        data-testid="entry-metadata"
        data-entry-link={entry.link}
        aria-label={`About ${entry.title}`}
        align="start"
        className="max-h-96 w-80 overflow-y-auto"
      >
        {props.onOpen !== undefined ? (
          <Button
            type="button"
            size="sm"
            className="mb-2"
            data-testid="entry-metadata-open"
            aria-label={`Open manga page for ${entry.title}`}
            onClick={props.onOpen}
          >
            <SquareArrowOutUpRight aria-hidden="true" />
            Open
          </Button>
        ) : null}
        <MetadataFields entry={entry} {...(props.website !== undefined ? { website: props.website } : {})} />
      </PopoverContent>
    </Popover>
  );
}
