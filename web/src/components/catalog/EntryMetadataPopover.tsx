/**
 * EntryMetadataPopover (browse-list polish, FMD2 vtMangaListGetHint
 * parity — frmMain.pas:5161-5226): the rich metadata hover over catalog
 * entry rows as a web-native Radix HoverCard (owner adaptation ruling:
 * hover popovers, never native desktop tooltips).
 *
 * Content is CATALOG DATA ONLY — every §5.8 field the row already
 * carries renders from the list payload; hovering NEVER fetches. Field
 * parity with the FMD2 hint: the website line leads in all-sites mode
 * (FilterAllSites branch, pas:5166-5170), then Title always, then
 * AltTitles / Authors / Artists / Genres / Status / Summary each ONLY
 * when non-empty (pas:5172-5226).
 */
import type { ReactElement, ReactNode } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';

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
}

function Section(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="mt-2" data-metadata-field={props.label}>
      <dt className="text-xs font-medium text-muted-foreground">{props.label}</dt>
      <dd className="text-xs">{props.value}</dd>
    </div>
  );
}

export function EntryMetadataPopover(props: EntryMetadataPopoverProps): ReactElement {
  const { entry } = props;
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
      </HoverCardContent>
    </HoverCard>
  );
}
