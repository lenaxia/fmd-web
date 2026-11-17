/**
 * FavoritesColumns (favorites-parity): the FMD2 vtFavorites column set
 * (frmMain.lfm:2483-2512 — Website / Current chapter / Save to / Date
 * added / Last checked / Last updated) on a TIERED responsive grid so
 * the Title track never collapses:
 *
 *   <md    stacked rows (title+badges, the full secondary meta line,
 *          wrapping actions) — no grid at all;
 *   md–xl  Title | Ch. | Website | Actions  (save-to + dates live on
 *          the secondary meta line; actions render icon-only);
 *   xl+    + Save to | Checked | Updated    (Added stays on the meta
 *          line — the least actionable date);
 *   2xl+   action button text labels return (aria-labels everywhere).
 *
 * The shared template constants keep {@link FavoriteColumnHeader} and
 * every row in lockstep; a row renders a <div> (ListPanel already
 * supplies the wrapping <li> — never nest li>li).
 */
import type { ReactElement, ReactNode } from 'react';
import type { FavoriteT } from '../../api/hooks';

/** Stable UTC 'YYYY-MM-DD HH:MM' — deterministic for tests + snapshots. */
export function formatFavoriteDate(iso: string | null): string {
  if (iso === null) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

/** md tier: title | ch | website | actions (fixed tracks ≈ 128px + gaps). */
const FAVORITE_GRID_MD =
  'md:grid md:grid-cols-[minmax(0,1fr)_2.5rem_5.5rem_max-content] md:items-center md:gap-x-3';
/** xl tier: + save-to | checked | updated (fixed tracks ≈ 408px + gaps). */
const FAVORITE_GRID_XL = 'xl:grid-cols-[minmax(0,1fr)_2.5rem_5.5rem_6rem_6.5rem_6.5rem_max-content]';

export interface FavoriteColumnData {
  readonly favorite: FavoriteT;
  /** Module display name (the modules join; raw id when unknown). */
  readonly website: string;
}

/** The FMD2 data columns as grid cells (children of the row grid). */
export function FavoriteColumnCells(props: FavoriteColumnData): ReactElement {
  const { favorite, website } = props;
  return (
    <>
      <span className="hidden truncate text-right tabular-nums md:block" title="Current chapter">
        {favorite.currentChapter === null ? '—' : favorite.currentChapter}
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
        title={`Last checked: ${formatFavoriteDate(favorite.lastCheck)}`}
      >
        {formatFavoriteDate(favorite.lastCheck)}
      </span>
      <span
        className="favorite-col-updated hidden truncate text-muted-foreground tabular-nums xl:block"
        title={`Last updated: ${formatFavoriteDate(favorite.lastUpdated)}`}
      >
        {formatFavoriteDate(favorite.lastUpdated)}
      </span>
    </>
  );
}

/**
 * The responsive secondary line: the full column data as one dotted
 * sentence — `N chapters · Website · save-to · dates`. Always rendered
 * (it is the ONLY home of the Added date and the <md/xl carry-all for
 * the columns the grid hides).
 */
export function FavoriteColumnMeta(props: FavoriteColumnData): ReactElement {
  const { favorite, website } = props;
  const saveTo = favorite.saveTo === null || favorite.saveTo === '' ? null : favorite.saveTo;
  const parts: string[] = [
    favorite.currentChapter === null ? 'no check yet' : `${favorite.currentChapter} chapters`,
    website,
    ...(saveTo !== null ? [`save to: ${saveTo}`] : []),
    `added ${formatFavoriteDate(favorite.dateAdded)}`,
    `checked ${formatFavoriteDate(favorite.lastCheck)}`,
    `updated ${formatFavoriteDate(favorite.lastUpdated)}`,
  ];
  return <span className="favorite-columns-meta">{parts.join(' · ')}</span>;
}

/** The wide grid's header row (hidden below md; mirrors the row tiers). */
export function FavoriteColumnHeader(): ReactElement {
  return (
    <div
      aria-hidden="true"
      className={`favorite-columns-header hidden border-b px-3 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground ${FAVORITE_GRID_MD} ${FAVORITE_GRID_XL}`}
    >
      <span>Title</span>
      <span className="hidden text-right md:block">Ch.</span>
      <span className="hidden md:block">Website</span>
      <span className="hidden xl:block">Save to</span>
      <span className="hidden xl:block">Checked</span>
      <span className="hidden xl:block">Updated</span>
      <span />
    </div>
  );
}

/**
 * One favorite row: a <div> on the shared grid (ListPanel supplies the
 * wrapping <li>) — the title cell (title + badges + the always-on
 * secondary line), the data cells ({@link FavoriteColumnCells}) and
 * the actions cell, on the exact template {@link
 * FavoriteColumnHeader} renders.
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
      className={`favorite-grid-row flex flex-col gap-1 px-3 py-2 md:min-h-row ${FAVORITE_GRID_MD} ${FAVORITE_GRID_XL}`}
    >
      {props.titleCell}
      <FavoriteColumnCells favorite={props.favorite} website={props.website} />
      {props.actionsCell}
    </div>
  );
}
