/**
 * Catalog pipeline (DESIGN.md §6) — public surface.
 */
export {
  dateToJdn,
  jdnToDate,
  isoDateToJdn,
  jdnToIsoDate,
  type CalendarDate,
} from './jdn.js';
export {
  FakeClock,
  systemClock,
  TokenBucket,
  CATALOG_RATE_BUDGET,
  type SyncClock,
} from './rate-budget.js';
export {
  BatchStateStore,
  emptyBatchState,
  type CatalogBatchState,
} from './batch-state.js';
export {
  listFiles,
  resolveSevenZipBinary,
  SevenZipExtractor,
  type Extractor,
} from './extract.js';
export {
  RateLimitedError,
  RATE_LIMIT_MESSAGE_PREFIX,
  SyncHttpClient,
  type FetchLike,
  type SyncHttpOptions,
  type SyncHttpResponse,
} from './http-client.js';
export {
  buildMatchQuery,
  CatalogFileStore,
  CATALOG_PAGE_DEFAULT,
  CATALOG_PAGE_MAX,
  fileSha256,
  isValidCatalogId,
} from './catalog-store.js';
export { CatalogSync, FMD2_DB_REPO_DEFAULT, type CatalogSyncOptions } from './sync-service.js';
