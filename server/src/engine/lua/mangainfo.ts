import { toStr } from './base-globals.js';
import type { FacadeBridge, FacadeSpec } from './facade.js';
import { makeTStrings } from './stubs.js';

/**
 * MANGAINFO event-global facade (§5.5, LuaMangaInfo.pas:23-34): the exact
 * field set — 10 string properties + the ChapterLinks/ChapterNames TStrings
 * sub-objects (luaClassAddStringProperty / luaClassAddObject rows, in unit
 * order). Keys are CASE-SENSITIVE (LuaClass.pas:94-169 metatable lookup) and
 * unknown keys silently no-op on get (nil) and set (dropped) — e.g. the
 * MANGAINFO.Artist typo (OrckuMangas.lua:91) is tolerated by contract.
 *
 * This module is also the host-side seam for §5.8: after OnGetInfo returns,
 * the host reads the backing (`fields`/`chapterLinks.list`/
 * `chapterNames.list`) and runs the §5.8 pipeline over the RAW module output
 * before caching/diffing.
 */

export const MANGAINFO_STRING_FIELDS = [
  'URL',
  'Title',
  'AltTitles',
  'Link',
  'CoverLink',
  'Authors',
  'Artists',
  'Genres',
  'Status',
  'Summary',
] as const;

export type MangaInfoFieldName = (typeof MANGAINFO_STRING_FIELDS)[number];

export interface MangaInfoHandle {
  readonly spec: FacadeSpec;
  /** Raw string-field backing, in unit order (read before §5.8 runs). */
  readonly fields: Record<MangaInfoFieldName, string>;
  readonly chapterLinks: ReturnType<typeof makeTStrings>;
  readonly chapterNames: ReturnType<typeof makeTStrings>;
}

export function makeMangaInfoSpec(bridge: FacadeBridge): MangaInfoHandle {
  const fields = Object.fromEntries(
    MANGAINFO_STRING_FIELDS.map((name) => [name, '']),
  ) as Record<MangaInfoFieldName, string>;
  const chapterLinks = makeTStrings(bridge);
  const chapterNames = makeTStrings(bridge);
  const lists: Record<string, number> = {
    ChapterLinks: bridge.create('', chapterLinks.spec),
    ChapterNames: bridge.create('', chapterNames.spec),
  };

  const spec: FacadeSpec = {
    get(key) {
      if (typeof key === 'number') {
        return undefined; // default-array access is not part of this facade
      }
      if (key in fields) {
        return fields[key as MangaInfoFieldName];
      }
      if (key === 'ChapterLinks' || key === 'ChapterNames') {
        // sub-objects are handed out by the Lua glue via sub(); a direct
        // id read here keeps host-side use simple
        return lists[key];
      }
      return undefined; // unknown key: silent no-op (case-sensitive lookup)
    },
    set(key, value) {
      if (typeof key !== 'string') {
        return;
      }
      if (key in fields) {
        fields[key as MangaInfoFieldName] = toStr(value);
      }
      // unknown keys: silent no-op
    },
    sub(key) {
      if (typeof key === 'string' && (key === 'ChapterLinks' || key === 'ChapterNames')) {
        return lists[key];
      }
      return undefined;
    },
  };

  return { spec, fields, chapterLinks, chapterNames };
}
