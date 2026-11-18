/**
 * Favorites engine (DESIGN §7.2/D8) — the `uFavoritesManager` parity
 * loop, NOT `uUpdateThread`: per favorite a LIVE `GetInfoFromURL` (the
 * §5 engine info path, §5.8-normalized), then `doCheck` semantics
 * (uFavoritesManager.pas:329-395), then — when the favorite is
 * auto-download enabled and the diff found new chapters — every new
 * chapter enqueues through the Phase-3 download pipeline and the merged
 * chapter list is DUAL-WRITTEN to both the favorite's stored list and
 * the global `downloaded_chapters` (:1131-1133). The dual-write marks
 * the queued chapters as seen, so a later check (mid-download or after)
 * does not re-detect them — exact FMD2 timing (the merge happens when
 * the downloads are queued, not when they finish).
 *
 * The tag-100 "transfer favorite" bulk-ingest (D4/D15) ships here as
 * `importFavorite`: the created favorite immediately runs the transfer
 * branch of DoCheck (:356-361) — the whole live chapter list becomes its
 * stored downloaded list.
 */

import type { InfoService, JobCreateInput } from '../../api/services.js';
import { ApiError } from '../../api/errors.js';
import {
  downloadedChaptersKey,
  linesToText,
  mergeCaseInsensitive,
} from '../library/merge.js';
import type { FavoriteRow, LibraryStore } from '../library/store.js';
import { doCheck } from './do-check.js';
import { newChapters } from './diff.js';

/** The Phase-3 pipeline port the engine auto-downloads through. */
export interface FavoriteDownloadQueue {
  /** Enqueue one chapter download (queue idempotency NOT used — the
   * dual-write below is the re-detection guard, FMD2 parity). */
  createDownload(input: JobCreateInput): { jobId: string };
}

export interface FavoritesEngineDeps {
  readonly store: Pick<
    LibraryStore,
    | 'getFavorite'
    | 'listFavorites'
    | 'upsertFavorite'
    | 'setDownloadedChapters'
    | 'getFavoriteDownloadedList'
    | 'deleteFavorite'
  >;
  readonly info: InfoService;
  readonly downloads: FavoriteDownloadQueue;
  /** Wall/fake clock (epoch ms). */
  readonly now?: () => number;
}

export interface FavoriteCheckResult {
  /** The favorite row as persisted by this check. */
  readonly favorite: FavoriteRow;
  /** 'skipped' = empty link or vanished row (parity :332-334). */
  readonly outcome: 'checked' | 'skipped';
  /** New chapters in live order ({position, link, name}). */
  readonly newChapters: ReadonlyArray<{ position: number; link: string; name: string }>;
  /** Download jobs enqueued through the pipeline (auto-download). */
  readonly queuedDownloads: number;
  /** true when the tag-100 transfer branch ran (:356-361). */
  readonly transferIngest: boolean;
}

export class FavoritesEngine {
  public constructor(private readonly deps: FavoritesEngineDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * One DoCheck cycle for one favorite (by key): live info → immediate
   * CurrentChapter/Status persist → diff → optional auto-download +
   * dual-write. Throws on live-info failure (the scheduler logs and
   * continues; the API maps it to a typed 502).
   */
  public async checkFavorite(mangaKey: string): Promise<FavoriteCheckResult> {
    const favorite = this.deps.store.getFavorite(mangaKey);
    if (favorite === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${mangaKey}`);
    }
    if (favorite.url === '') {
      // :332-334 — a link-less favorite exits before anything happens.
      return { favorite, outcome: 'skipped', newChapters: [], queuedDownloads: 0, transferIngest: false };
    }
    const live = await this.deps.info.getInfo(favorite.moduleId, favorite.url);
    const outcome = doCheck(favorite, live, this.now());
    const newChapterSet = newChapters(
      live.chapterLinks,
      live.chapterNames,
      favorite.downloadedChapterList ?? '',
    );

    // Immediate favorite update (:346-348, :376-380) — BEFORE any
    // download bookkeeping, exactly FMD2's order. The §5.8 coverLink
    // rides along (covers live-defect): the favorites grid renders
    // covers through the same-origin proxy off the STORED url — an
    // empty live cover never clobbers a previously captured one.
    const updated: FavoriteRow = {
      ...favorite,
      currentChapter: outcome.currentChapter,
      status: outcome.status,
      lastCheck: outcome.lastCheck,
      ...(outcome.lastUpdated !== undefined ? { lastUpdated: outcome.lastUpdated } : {}),
      newChapterCount: outcome.newChapterPositions.length,
      downloadedChapterList: outcome.downloadedChapterList,
      ...(live.coverLink !== '' ? { coverLink: live.coverLink } : {}),
    };
    this.deps.store.upsertFavorite(updated);

    if (outcome.transferIngest) {
      // Tag-100 branch (:356-361): everything is marked downloaded, no
      // downloads run, the global ledger is untouched (parity).
      return { favorite: updated, outcome: 'checked', newChapters: [], queuedDownloads: 0, transferIngest: true };
    }

    // Auto-download: queue every new chapter through the Phase-3
    // pipeline, then dual-write the merged list (:1131-1133). The
    // enqueue payload carries the favorite's mangaKey so the per-chapter
    // completion ledger write updates the favorite side too.
    if (favorite.autoDownload === true && newChapterSet.length > 0) {
      const newLinks = newChapterSet.map((chapter) => chapter.link);
      for (const chapter of newChapterSet) {
        this.deps.downloads.createDownload({
          moduleId: favorite.moduleId,
          mangaUrl: favorite.url,
          ...(favorite.title !== undefined ? { mangaTitle: favorite.title } : {}),
          chapterLink: chapter.link,
          ...(chapter.name !== '' ? { chapterName: chapter.name } : {}),
          mangaKey: favorite.mangaKey,
        });
      }
      const merged = this.dualWriteNewChapters(updated, newLinks);
      return { favorite: merged, outcome: 'checked', newChapters: newChapterSet, queuedDownloads: newLinks.length, transferIngest: false };
    }

    return { favorite: updated, outcome: 'checked', newChapters: newChapterSet, queuedDownloads: 0, transferIngest: false };
  }

  /**
   * :1131-1133 — the new-chapter set merges into BOTH the favorite's
   * stored list and the global `downloaded_chapters` row (merge
   * semantics per row age: an existing global row merges
   * case-insensitively, a new one stores as-is — SetChapters parity).
   */
  private dualWriteNewChapters(base: FavoriteRow, newLinks: readonly string[]): FavoriteRow {
    const newText = linesToText([...newLinks]);
    if (newText === '') {
      return base;
    }
    this.deps.store.setDownloadedChapters(base.moduleId, base.url, newText);
    const stored = this.deps.store.getFavoriteDownloadedList(base.mangaKey);
    const merged: FavoriteRow = {
      ...base,
      downloadedChapterList: mergeCaseInsensitive(stored, newText),
    };
    this.deps.store.upsertFavorite(merged);
    return merged;
  }

  /**
   * Plain favorite create (FMD2 `Add` parity): insert the row seeded
   * from the caller's known state — NO live fetch, the downloaded list
   * starts EMPTY so the first check reports every live chapter as new
   * (the badge), and the scheduler picks the favorite up immediately
   * (rescan marks unseen favorites due now).
   */
  public createFavorite(input: {
    moduleId: string;
    url: string;
    title?: string;
    autoDownload?: boolean;
    saveTo?: string;
    enabled?: boolean;
  }): FavoriteRow {
    const mangaKey = downloadedChaptersKey(input.moduleId, input.url);
    const row: FavoriteRow = {
      mangaKey,
      moduleId: input.moduleId,
      url: input.url,
      ...(input.title !== undefined ? { title: input.title } : {}),
      autoDownload: input.autoDownload ?? false,
      newChapterCount: 0,
      downloadedChapterList: '',
      ...(input.saveTo !== undefined && input.saveTo !== '' ? { saveTo: input.saveTo } : {}),
      enabled: input.enabled ?? true,
      dateAdded: this.now(),
    };
    this.deps.store.upsertFavorite(row);
    return row;
  }

  /**
   * Website transfer (frmTransferFavorites.btOKClick parity, ADAPT to
   * one favorite at a time): the row remaps onto the target module+link
   * under a NEW mangaKey — title/status/currentChapter/saveTo carry
   * over, the downloaded list carries over unless the caller asked for
   * the clear-and-reload (then the stored list resets and the tag-100
   * transfer branch re-ingests the LIVE chapter list from the target
   * site). The old row is deleted (its downloaded_chapters ledger row
   * is NOT touched, same as a plain delete).
   */
  public async transferFavorite(
    id: string,
    target: { moduleId: string; url: string; clearDownloadedList: boolean },
  ): Promise<FavoriteRow> {
    const favorite = this.deps.store.getFavorite(id);
    if (favorite === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    const seed: FavoriteRow = {
      ...favorite,
      mangaKey: downloadedChaptersKey(target.moduleId, target.url),
      moduleId: target.moduleId,
      url: target.url,
      newChapterCount: 0,
      ...(target.clearDownloadedList ? { downloadedChapterList: '' } : {}),
    };
    this.deps.store.deleteFavorite(id);
    this.deps.store.upsertFavorite(seed);
    if (target.clearDownloadedList) {
      // Tag-100 reload: the live target-site chapter list becomes the
      // stored downloaded list (importFavorite semantics).
      const reloaded = await this.importFavorite({
        moduleId: target.moduleId,
        url: target.url,
        ...(favorite.title !== undefined ? { title: favorite.title } : {}),
        ...(favorite.autoDownload !== undefined ? { autoDownload: favorite.autoDownload } : {}),
      });
      return reloaded.favorite;
    }
    return seed;
  }

  /**
   * Favorites-import path — the ONE import primitive both entry points
   * share (the JSON-list tag-100 route and the FMD2 file import):
   *
   * - WITHOUT `seed` (tag-100, D4): create and immediately run the
   *   transfer branch (:356-361) — every live chapter lands in the
   *   favorite's stored downloaded list. Re-adding an existing key
   *   re-ingests from the CURRENT live list (idempotent: the merge
   *   keeps one case-insensitive set).
   *
   * - WITH `seed` (FMD2 favorites.db import, MD_ImportToFavorites
   *   parity — uSilentThread.pas:507-513: NO live fetch): the row is
   *   seeded offline from the file's own fields (status, current
   *   chapter, downloaded list, enabled, date added) and the optional
   *   `ledgerChapters` merges into the global downloaded_chapters row
   *   (SetChapters merge parity). Idempotent by mangaKey: an existing
   *   row merges (lists union, file values win where present) and the
   *   result reports whether anything actually changed.
   */
  public async importFavorite(input: {
    moduleId: string;
    url: string;
    title?: string;
    autoDownload?: boolean;
    seed?: {
      status?: string;
      currentChapter?: number | null;
      downloadedChapterList?: string;
      enabled?: boolean;
      dateAdded?: number;
      /** Ledger text for downloaded_chapters (merged, never replaced). */
      ledgerChapters?: string;
    };
  }): Promise<FavoriteCheckResult & { readonly importOutcome: 'created' | 'updated' | 'unchanged' }> {
    const mangaKey = downloadedChaptersKey(input.moduleId, input.url);
    const existing = this.deps.store.getFavorite(mangaKey);
    const seed = input.seed;
    const seedList =
      seed?.downloadedChapterList !== undefined && seed.downloadedChapterList !== ''
        ? seed.downloadedChapterList
        : undefined;
    const mergedList =
      seedList !== undefined && existing?.downloadedChapterList !== undefined
        ? mergeCaseInsensitive(existing.downloadedChapterList, seedList)
        : seedList ?? existing?.downloadedChapterList ?? '';
    const candidate: FavoriteRow = {
      // Re-ingest keeps the stored row's shape (status/currentChapter/
      // saveTo/enabled/dateAdded — only the diff-relevant fields reset).
      ...(existing !== undefined ? existing : {}),
      mangaKey,
      moduleId: input.moduleId,
      url: input.url,
      ...(input.title !== undefined && input.title !== '' ? { title: input.title } : {}),
      autoDownload: input.autoDownload ?? existing?.autoDownload ?? false,
      newChapterCount: 0,
      downloadedChapterList: mergedList,
      ...(seed !== undefined
        ? {
            ...(seed.status !== '' ? { status: seed.status } : {}),
            ...(seed.currentChapter !== null && seed.currentChapter !== undefined
              ? { currentChapter: seed.currentChapter }
              : {}),
            ...(seed.enabled !== undefined ? { enabled: seed.enabled } : {}),
            ...(seed.dateAdded !== undefined && existing === undefined ? { dateAdded: seed.dateAdded } : {}),
          }
        : {}),
    };
    const before = existing;
    this.deps.store.upsertFavorite(candidate);
    if (seed !== undefined) {
      if (seed.ledgerChapters !== undefined && seed.ledgerChapters !== '') {
        // SetChapters parity: new row stores as-is, existing merges
        // case-insensitively (store-level semantics).
        this.deps.store.setDownloadedChapters(input.moduleId, input.url, seed.ledgerChapters);
      }
      const importOutcome: 'created' | 'updated' | 'unchanged' =
        before === undefined
          ? 'created'
          : favoriteRowsEqual(before, candidate)
            ? 'unchanged'
            : 'updated';
      return {
        favorite: candidate,
        outcome: 'checked',
        newChapters: [],
        queuedDownloads: 0,
        transferIngest: false,
        importOutcome,
      };
    }
    // The transfer branch reads the intent off the check input, then
    // the persisted row never carries the flag (FMD2 resets Tag to 0).
    const favorite = this.deps.store.getFavorite(mangaKey);
    if (favorite === undefined) {
      throw new ApiError(500, 'internal_error', `favorite vanished during import: ${mangaKey}`);
    }
    if (favorite.url === '') {
      return { favorite, outcome: 'skipped', newChapters: [], queuedDownloads: 0, transferIngest: false, importOutcome: 'unchanged' };
    }
    const live = await this.deps.info.getInfo(favorite.moduleId, favorite.url);
    const outcome = doCheck({ ...favorite, transferIngest: true }, live, this.now());
    const updated: FavoriteRow = {
      ...favorite,
      currentChapter: outcome.currentChapter,
      status: outcome.status,
      lastCheck: outcome.lastCheck,
      newChapterCount: 0,
      downloadedChapterList: outcome.downloadedChapterList,
    };
    this.deps.store.upsertFavorite(updated);
    return {
      favorite: updated,
      outcome: 'checked',
      newChapters: [],
      queuedDownloads: 0,
      transferIngest: true,
      importOutcome: before === undefined ? 'created' : 'updated',
    };
  }

  /** All favorites (scheduler input / listing). */
  public listFavorites(): FavoriteRow[] {
    return this.deps.store.listFavorites();
  }

  /** The underlying store (service-layer CRUD needs direct row access). */
  public storeView(): FavoritesEngineDeps['store'] {
    return this.deps.store;
  }
}

/** Field-wise favorite equality (import idempotency: 'unchanged' verdict). */
function favoriteRowsEqual(a: FavoriteRow, b: FavoriteRow): boolean {
  return (
    a.mangaKey === b.mangaKey &&
    a.moduleId === b.moduleId &&
    a.url === b.url &&
    a.title === b.title &&
    a.status === b.status &&
    a.currentChapter === b.currentChapter &&
    a.lastCheck === b.lastCheck &&
    a.lastUpdated === b.lastUpdated &&
    a.autoDownload === b.autoDownload &&
    a.newChapterCount === b.newChapterCount &&
    (a.downloadedChapterList ?? '') === (b.downloadedChapterList ?? '') &&
    (a.saveTo ?? '') === (b.saveTo ?? '') &&
    a.enabled === b.enabled &&
    a.dateAdded === b.dateAdded
  );
}

/** The scheduler identity input for one favorite row. */
export function schedulerView(favorite: FavoriteRow): { mangaKey: string; intervalMs?: number } {
  return { mangaKey: favorite.mangaKey };
}

/** `LowerCase(ModuleID+Link)` — the favorites :id. */
export function favoriteId(moduleId: string, url: string): string {
  return downloadedChaptersKey(moduleId, url);
}
