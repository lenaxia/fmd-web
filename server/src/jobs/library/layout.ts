/**
 * Library layout — the owner-approved flat series convention
 * (`library/<manga>/<chapter>.<ext>`, DESIGN §7.1 as re-ruled by the
 * library-layout story): the module is NOT a path segment; hundreds of
 * per-site folders were hostile to browsing by series. Duplicates
 * (the same series followed from two sites — e.g. different
 * scanlation groups) get a module suffix on the FOLDER name, never a
 * module tree:
 *
 *   first writer    → `<libraryRoot>/<sanitized manga>/`
 *   different site  → `<libraryRoot>/<sanitized manga> [<module>]/`
 *
 * FIRST WRITER KEEPS THE CLEAN NAME — no retroactive renames, ever.
 * The effective folder is COMPUTED ONCE at the title's first download
 * and PERSISTED (the favorite's `library_folder` column — the same
 * additive-column seam the edSaveTo override rides — plus every
 * recorded ledger row's path/manga columns); it is never recomputed:
 * adding/deleting other favorites must never re-point an existing
 * folder. A same-name-different-actual-series across sites follows
 * the identical rule (accepted).
 *
 * `saveTo` (FMD2 edSaveTo) precedence is unchanged: when present it
 * REPLACES the computed `<libraryRoot>/<manga>` prefix entirely and no
 * effective folder is computed or persisted for that download.
 */
import { sanitizeFileName, truncateKeepTail } from './filenames.js';

/** Path-component cap shared with the finalizer (safeComponent). */
const COMPONENT_MAX = 255;

/** Sanitize + tail-truncate one layout folder component (non-empty). */
export function safeFolderComponent(component: string): string {
  const sanitized = sanitizeFileName(component);
  if (sanitized === '') {
    throw new Error(`library folder component is empty after sanitization: ${JSON.stringify(component)}`);
  }
  return truncateKeepTail(sanitized, COMPONENT_MAX);
}

/**
 * The duplicate-collision folder form `<manga> [<module>]` — both parts
 * sanitized, the WHOLE component tail-truncated so the suffix (the
 * discriminating tail) always survives the cap.
 */
export function suffixedMangaFolder(mangaFolder: string, moduleId: string): string {
  const suffix = sanitizeFileName(moduleId);
  const combined = suffix === '' ? mangaFolder : `${mangaFolder} [${suffix}]`;
  return safeFolderComponent(combined);
}

/**
 * The foreign-claim decision (rule 2): does the clean folder name
 * belong to a DIFFERENT module?
 *
 * `claimants` are the distinct sanitized module segments recorded (in
 * the ledger) under the clean folder; `diskClaim` is the folder's
 * on-disk existence — a folder present with NO ledger claimant is an
 * UNKNOWN claim (conservative: the newcomer suffixes rather than
 * merges into a tree it cannot attribute).
 */
export function isForeignClaim(
  claimants: readonly string[],
  ownModuleSegment: string,
  diskClaim: boolean,
): boolean {
  if (claimants.length === 0) {
    // Unattributed folder on disk: claimed by an unknown writer.
    return diskClaim;
  }
  return claimants.some((claimant): boolean => claimant !== ownModuleSegment);
}
