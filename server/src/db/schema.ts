/**
 * app.db schema placeholder (DESIGN.md §9) + catalog read-only columns
 * (§6, DBDataProcess.pas:143–153). Migrations land with the db stories.
 */

export const APP_DB_TABLES = [
  'settings',
  'module_state',
  'catalog_meta',
  'favorite',
  'job',
  'downloaded_chapters',
  'account',
  'sync_state',
] as const;

export type AppDbTable = (typeof APP_DB_TABLES)[number];

/** FMD2-DB catalog schema, reused verbatim (§6). */
export const CATALOG_SCHEMA_COLUMNS = [
  'link',
  'title',
  'alttitles',
  'authors',
  'artists',
  'genres',
  'status',
  'summary',
  'numchapter',
  'jdn',
] as const;

export type CatalogColumn = (typeof CATALOG_SCHEMA_COLUMNS)[number];

/** Julian day number epoch (Pascal 1899-12-30) — shared JDN helper (§6.7). */
export const JDN_PASCAL_EPOCH = '1899-12-30';

export function isAppDbTable(name: string): name is AppDbTable {
  return (APP_DB_TABLES as readonly string[]).includes(name);
}
