/**
 * §10 FavoriteService over the §7.2 engine + app.db store: CRUD (via
 * the library store's favorite rows), the auto-download toggle, the
 * manual check-now trigger (one immediate DoCheck cycle) and the D4
 * import path (tag-100 transfer-favorite bulk-ingest). Timestamps are
 * stored as epoch ms and projected as RFC 3339 — the §10 wire shape.
 */
import { ApiError } from '../api/errors.js';
import type {
  FavoriteService,
} from '../api/services.js';
import type {
  FavoriteCheckResponseT,
  FavoriteCreateRequestT,
  FavoriteT,
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
  };
}

export class SqliteFavoritesService implements FavoriteService {
  public constructor(private readonly engine: FavoritesEngine) {}

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

  async import(input: FavoriteCreateRequestT): Promise<FavoriteT> {
    const result = await this.engine.importFavorite({
      moduleId: input.moduleId,
      url: input.url,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.autoDownload !== undefined ? { autoDownload: input.autoDownload } : {}),
    });
    return toFavoriteWire(result.favorite);
  }
}
