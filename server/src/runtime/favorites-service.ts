/**
 * §10 FavoriteService over the §7.2 engine + app.db store: CRUD (via
 * the library store's favorite rows), the auto-download toggle, the
 * manual check-now trigger, the D4 import path (tag-100
 * transfer-favorite bulk-ingest), the batch check with scopes + cancel
 * (btFavoritesCheckNewChapter parity) and the website transfer
 * (frmTransferFavorites parity: catalog title-match preview + GetInfo
 * dry-run, remap, optional clear-and-reload). Timestamps are stored as
 * epoch ms and projected as RFC 3339 — the §10 wire shape.
 */
import { ApiError } from '../api/errors.js';
import type {
  CatalogService,
  FavoriteService,
  InfoService,
} from '../api/services.js';
import type {
  FavoriteCheckBatchItemT,
  FavoriteCheckBatchResponseT,
  FavoriteCheckResponseT,
  FavoriteCreateRequestT,
  FavoriteT,
  FavoriteTransferPreviewResponseT,
  FavoriteUpdateRequestT,
} from '../api/schemas.js';
import { downloadedChaptersKey } from '../jobs/library/merge.js';
import type { FavoriteRow } from '../jobs/library/store.js';
import { FavoritesEngine } from '../jobs/favorites/engine.js';

function msToIso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

function toFavoriteWire(row: FavoriteRow): FavoriteT {
  return {
    id: row.mangaKey,
    moduleId: row.moduleId,
    url: row.url,
    title: row.title ?? null,
    status: row.status ?? null,
    currentChapter: row.currentChapter ?? null,
    newChapterCount: row.newChapterCount ?? 0,
    autoDownload: row.autoDownload === true,
    lastCheck: msToIso(row.lastCheck),
    lastUpdated: msToIso(row.lastUpdated),
    saveTo: row.saveTo ?? null,
    enabled: row.enabled !== false,
    dateAdded: msToIso(row.dateAdded),
    coverLink: row.coverLink ?? null,
  };
}

export class SqliteFavoritesService implements FavoriteService {
  private batchCancelRequested = false;
  private batchRunning = false;

  public constructor(
    private readonly engine: FavoritesEngine,
    /** Transfer preview seams: catalog title search + GetInfo dry-run. */
    private readonly transferDeps?: {
      readonly catalogs: CatalogService;
      readonly info: InfoService;
    },
  ) {}

  list(): FavoriteT[] {
    return this.engine.listFavorites().map(toFavoriteWire);
  }

  get(id: string): FavoriteT | undefined {
    const row = this.engine.storeView().getFavorite(id);
    return row === undefined ? undefined : toFavoriteWire(row);
  }

  async create(input: FavoriteCreateRequestT): Promise<FavoriteT> {
    const id = downloadedChaptersKey(input.moduleId, input.url);
    if (this.engine.storeView().getFavorite(id) !== undefined) {
      throw new ApiError(409, 'conflict', `favorite already exists: ${id}`);
    }
    // FMD2 `Add` parity: the row seeds from the caller's known state
    // (no live fetch); the scheduler checks it promptly and the first
    // check reports every live chapter as new. Auto-download defaults
    // off (FMD2 OptionAutoCheckFavDownload = False).
    return toFavoriteWire(
      this.engine.createFavorite({
        moduleId: input.moduleId,
        url: input.url,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.autoDownload !== undefined ? { autoDownload: input.autoDownload } : {}),
      }),
    );
  }

  update(id: string, patch: FavoriteUpdateRequestT): FavoriteT {
    const row = this.engine.storeView().getFavorite(id);
    if (row === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    const updated: FavoriteRow = {
      ...row,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.autoDownload !== undefined ? { autoDownload: patch.autoDownload } : {}),
      ...(patch.saveTo !== undefined ? { saveTo: patch.saveTo } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    };
    this.engine.storeView().upsertFavorite(updated);
    return toFavoriteWire(updated);
  }

  remove(id: string): void {
    if (this.engine.storeView().getFavorite(id) === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    this.engine.storeView().deleteFavorite(id);
  }

  async checkNow(id: string): Promise<FavoriteCheckResponseT> {
    if (this.engine.storeView().getFavorite(id) === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    const result = await this.engine.checkFavorite(id);
    return {
      favorite: toFavoriteWire(result.favorite),
      queuedDownloads: result.queuedDownloads,
      newChapters: result.newChapters.map((chapter) => ({ ...chapter })),
    };
  }

  async checkBatch(scope: 'all' | 'enabled' | 'disabled'): Promise<FavoriteCheckBatchResponseT> {
    if (this.batchRunning) {
      throw new ApiError(409, 'conflict', 'a favorites check batch is already running');
    }
    this.batchRunning = true;
    this.batchCancelRequested = false;
    try {
      const rows = this.engine.listFavorites().filter((row): boolean => {
        if (scope === 'enabled') {
          return row.enabled !== false;
        }
        if (scope === 'disabled') {
          return row.enabled === false;
        }
        return true;
      });
      const results: FavoriteCheckBatchItemT[] = [];
      let checked = 0;
      let failed = 0;
      let queuedDownloads = 0;
      let cancelled = false;
      for (const row of rows) {
        if (this.batchCancelRequested) {
          cancelled = true;
          break;
        }
        try {
          const result = await this.engine.checkFavorite(row.mangaKey);
          checked += 1;
          queuedDownloads += result.queuedDownloads;
          results.push({
            favorite: toFavoriteWire(result.favorite),
            status: result.outcome === 'skipped' ? 'skipped' : 'checked',
            newChapters: result.newChapters.map((chapter) => ({ ...chapter })),
            queuedDownloads: result.queuedDownloads,
          });
        } catch (error: unknown) {
          failed += 1;
          results.push({
            favorite: toFavoriteWire(row),
            status: 'failed',
            newChapters: [],
            queuedDownloads: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { scope, cancelled, checked, failed, queuedDownloads, results };
    } finally {
      this.batchRunning = false;
      this.batchCancelRequested = false;
    }
  }

  cancelBatch(): boolean {
    if (!this.batchRunning) {
      return false;
    }
    this.batchCancelRequested = true;
    return true;
  }

  async transferPreview(id: string, targetModuleId: string): Promise<FavoriteTransferPreviewResponseT> {
    const row = this.engine.storeView().getFavorite(id);
    if (row === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    if (this.transferDeps === undefined) {
      return { targetModuleId, valid: false, targetUrl: null, matchedTitle: null, reason: 'no-catalog' };
    }
    if (this.transferDeps.catalogs.getMeta(targetModuleId) === undefined) {
      return { targetModuleId, valid: false, targetUrl: null, matchedTitle: null, reason: 'no-catalog' };
    }
    const title = row.title ?? '';
    if (title === '') {
      return { targetModuleId, valid: false, targetUrl: null, matchedTitle: null, reason: 'not-found' };
    }
    const page = this.transferDeps.catalogs.search(targetModuleId, { query: title, limit: 20 });
    const hit = page.entries.find(
      (entry): boolean => entry.title.toLowerCase() === title.toLowerCase(),
    );
    if (hit === undefined) {
      return { targetModuleId, valid: false, targetUrl: null, matchedTitle: null, reason: 'not-found' };
    }
    // GetInfo dry-run: the mapping is valid only when the target link
    // actually resolves live (TFindMatchDBThread + the reload check).
    try {
      await this.transferDeps.info.getInfo(targetModuleId, hit.link);
    } catch {
      return { targetModuleId, valid: false, targetUrl: null, matchedTitle: null, reason: 'get-info-failed' };
    }
    return { targetModuleId, valid: true, targetUrl: hit.link, matchedTitle: hit.title };
  }

  async transfer(
    id: string,
    target: { moduleId: string; url: string; clearDownloadedList: boolean },
  ): Promise<{ favorite: FavoriteT; reloadedFromServer: boolean }> {
    if (this.engine.storeView().getFavorite(id) === undefined) {
      throw new ApiError(404, 'not_found', `unknown favorite: ${id}`);
    }
    const row = await this.engine.transferFavorite(id, target);
    return { favorite: toFavoriteWire(row), reloadedFromServer: target.clearDownloadedList };
  }

  async import(
    input: FavoriteCreateRequestT & {
      /** FMD2 file-import seed (offline, MD_ImportToFavorites parity). */
      seed?: {
        status?: string;
        currentChapter?: number | null;
        downloadedChapterList?: string;
        enabled?: boolean;
        dateAdded?: number;
        ledgerChapters?: string;
      };
    },
  ): Promise<{ favorite: FavoriteT; importOutcome: 'created' | 'updated' | 'unchanged' }> {
    const result = await this.engine.importFavorite({
      moduleId: input.moduleId,
      url: input.url,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.autoDownload !== undefined ? { autoDownload: input.autoDownload } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    });
    return { favorite: toFavoriteWire(result.favorite), importOutcome: result.importOutcome };
  }
}
