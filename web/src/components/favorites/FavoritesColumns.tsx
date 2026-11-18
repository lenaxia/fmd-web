/**
 * FavoritesColumns (favorites-ux rebuild): the FMD2 vtFavorites column
 * set (Website / Current chapter / Save to / Last checked / Last
 * updated) on ONE shared grid template that the header row and every
 * data row render verbatim — pixel-true track alignment:
 *
 *   <md    mobile card (v0.3.0 parity pattern): stacked title+badges,
 *          the secondary meta line and the single kebab action button;
 *   md+    Title (flexible primary) | Ch. | Website | actions;
 *   xl+    + Save to | Checked | Updated.
 *
 * The Title track is minmax(12rem,1fr) so it is always the generous
 * primary column (ellipsis + title attr on overflow); metadata tracks
 * are compact fixed widths; every row action lives in ONE narrow
 * 2.25rem icon column at the right edge (the row overflow menu).
 *
 * Empty data renders BLANK (dates, chapter count) or 'Unknown' only
 * where semantically right — never a decorative em dash.
 */
import type { ReactElement, ReactNode } from 'react';
import type { FavoriteT } from '../../api/hooks';

/** Stable UTC 'YYYY-MM-DD HH:MM' — deterministic for tests + snapshots.
 * Missing/unparseable dates format to '' (blank cell). */
export function formatFavoriteDate(iso: string | null): string {
  if (iso === null) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

/**
 * THE shared column grid: FavoriteColumnHeader and FavoriteGridRow both
 * render this exact template (plus the same px-3 inset via their
 * containers), so headings and data land on identical tracks. Fixed
 * tracks: Ch. 3rem, Website 7rem, Save to/Checked/Updated 7rem each,
 * actions 2.25rem — the minmax'd Title track takes every leftover px.
 */
const FAVORITE_GRID =
  'md:grid md:grid-cols-[minmax(12rem,1fr)_3rem_7rem_2.25rem] md:items-center md:gap-x-3 ' +
  'xl:grid-cols-[minmax(14rem,1fr)_3rem_7rem_7rem_7rem_7rem_2.25rem]';

export interface FavoriteColumnData {
  readonly favorite: FavoriteT;
  /** Module display name (the modules join; raw id when unknown). */
  readonly website: string;
}

/** The FMD2 data columns as grid cells (children of the row grid). */
export function FavoriteColumnCells(props: FavoriteColumnData): ReactElement {
  const { favorite, website } = props;
  const checked = formatFavoriteDate(favorite.lastCheck);
  const updated = formatFavoriteDate(favorite.lastUpdated);
  return (
    <>
      <span
        className="favorite-col-ch hidden truncate text-right tabular-nums md:block"
        title="Current chapter"
      >
        {favorite.currentChapter === null ? '' : favorite.currentChapter}
      </span>
      <span className="favorite-col-website hidden truncate md:block" title={`Website: ${website}`}>
        {website}
      </span>
      <span
        className="favorite-col-saveto hidden truncate text-muted-foreground xl:block"
        title={
          favorite.saveTo === null || favorite.saveTo === ''
            ? 'Save to: default'
            : `Save to: ${favorite.saveTo}`
        }
      >
        {favorite.saveTo === null || favorite.saveTo === '' ? 'default' : favorite.saveTo}
      </span>
      <span
        className="favorite-col-checked hidden truncate text-muted-foreground tabular-nums xl:block"
        title={checked === '' ? 'Last checked: never' : `Last checked: ${checked}`}
      >
        {checked}
      </span>
      <span
        className="favorite-col-updated hidden truncate text-muted-foreground tabular-nums xl:block"
        title={updated === '' ? 'Last updated: never' : `Last updated: ${updated}`}
      >
        {updated}
      </span>
    </>
  );
}

/**
 * The responsive secondary line: the full column data as one dotted
 * sentence (`N chapters · Website · save-to · dates`). Below xl it is
 * the ONLY home of Save to / Added / Checked / Updated; at xl+ (where
 * the grid carries those columns) it collapses to just the Added date,
 * the one fact without a grid column.
 */
export function FavoriteColumnMeta(props: FavoriteColumnData): ReactElement {
  const { favorite, website } = props;
  const saveTo = favorite.saveTo === null || favorite.saveTo === '' ? null : favorite.saveTo;
  const datePart = (label: string, iso: string | null): string[] => {
    const value = formatFavoriteDate(iso);
    return value === '' ? [] : [`${label} ${value}`];
  };
  const full = [
    favorite.currentChapter === null ? 'no check yet' : `${favorite.currentChapter} chapters`,
    website,
    ...(saveTo !== null ? [`save to: ${saveTo}`] : []),
    ...datePart('added', favorite.dateAdded),
    ...datePart('checked', favorite.lastCheck),
    ...datePart('updated', favorite.lastUpdated),
  ].join(' · ');
  const addedOnly = datePart('added', favorite.dateAdded).join('');
  return (
    <span className="favorite-columns-meta">
      <span className="xl:hidden">{full}</span>
      <span className="hidden xl:inline">{addedOnly}</span>
    </span>
  );
}

/** The shared grid's header row (hidden below md; mirrors the row tiers). */
export function FavoriteColumnHeader(): ReactElement {
  return (
    <div
      aria-hidden="true"
      className={`favorite-columns-header hidden px-3 pb-2 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground ${FAVORITE_GRID}`}
    >
      <span>Title</span>
      <span className="hidden text-right md:block">Ch.</span>
      <span className="hidden md:block">Website</span>
      <span className="hidden xl:block">Save to</span>
      <span className="hidden xl:block">Checked</span>
      <span className="hidden xl:block">Updated</span>
      <span className="hidden md:block" />
    </div>
  );
}

/**
 * One favorite row: a flex card below md (title block + kebab), a grid
 * row on the exact template {@link FavoriteColumnHeader} renders at
 * md+ (ListPanel supplies the wrapping <li> and its px-3 inset — the
 * row itself carries NO horizontal padding so both stay on the same
 * tracks).
 */
export function FavoriteGridRow(props: {
  favorite: FavoriteT;
  website: string;
  titleCell: ReactNode;
  actionsCell: ReactNode;
}): ReactElement {
  return (
    <div
      data-favorite-id={props.favorite.id}
      className={`favorite-grid-row flex items-start gap-x-2 py-2 md:min-h-row ${FAVORITE_GRID}`}
    >
      {props.titleCell}
      <FavoriteColumnCells favorite={props.favorite} website={props.website} />
      {props.actionsCell}
    </div>
  );
}
