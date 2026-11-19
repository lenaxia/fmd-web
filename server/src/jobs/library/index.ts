/**
 * server/jobs/library — the download library facade (DESIGN §7.1/§9):
 * atomic chapter finalize (`library/<manga>/<chapter>.<ext>` (flat
 * series folders — the [library-layout] relayout; module suffix only on
 * duplicate folders),
 * temp-dir + rename at every boundary), FMD2 `DownloadedChaptersDB`
 * dedupe parity (key = LowerCase(ModuleID+Link), case-insensitively
 * merged lists), and the §7.2 dual-write chapter completion (favorite
 * list + global `downloaded_chapters`).
 */
export {
  mergeCaseInsensitive,
  splitTextLines,
  linesToText,
  downloadedChaptersKey,
  asciiLowerCase,
  hasChapter,
} from './merge.js';
export {
  SYMBOLS,
  CR,
  sanitizeFileName,
  truncateKeepTail,
  resolveChapterFileName,
  normalizeChapterExtension,
} from './filenames.js';
export type { ChapterFileNameParts, ChapterFileFormat } from './filenames.js';
export {
  LibraryFinalizer,
  finalizeLeftovers,
} from './finalize.js';
export type {
  FinalizeRequest,
  FinalizeResult,
  FinalizerOptions,
  FinalizeFaultPoint,
} from './finalize.js';
export {
  SqliteLibraryStore,
  ensureLibrarySchema,
} from './store.js';
export type {
  LibraryStore,
  LibraryFileRow,
  DownloadedChaptersAccess,
  FavoriteRow,
  ChapterCompletionRequest,
  ChapterCompletionResult,
  SqliteLibraryStoreOptions,
} from './store.js';
