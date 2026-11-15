/**
 * Catalog sync service (DESIGN.md §6.1–§6.3) — the write side of the
 * FMD2-DB pipeline, parity with `GitHubRepoV3.pas` + `DBUpdater.pas`:
 *
 * 1. Update check: GitHub commits API, ONE call (`commits?sha=<ref>&
 *    per_page=1`, GitHubRepoV3.pas:178) → head SHA; a moved pin defines
 *    the changed set (pending carry-over + the module registry's catalog
 *    ids); per-file change detection rides the blob conditional GETs.
 * 2. Fetch: `<dbUrl>/7z/<ID>.7z`, conditional GET (ETag /
 *    If-None-Match), every request gated by the token-bucket budget
 *    (10 req/s, burst 50).
 * 3. Extract: 7zz → a fresh temp dir → sha256 the extracted db →
 *    ATOMIC RENAME into `data/catalogs/<ID>.db` (never in-place; a
 *    crash anywhere before the rename leaves the previous catalog — or
 *    no catalog — visible, never a partial one).
 * 4. Batch state: pending set + per-file ETags persist atomically
 *    after every step; a crash mid-batch resumes exactly where it
 *    stopped (GitHubRepoV3.pas:69-113 work-file model, extended).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CatalogStore,
  CatalogSyncResult,
  CatalogSyncService,
  CatalogUpdateCheck,
  ModuleId,
} from '@fmd/contract';
import { BatchStateStore, type CatalogBatchState } from './batch-state.js';
import { CatalogFileStore, fileSha256, isValidCatalogId } from './catalog-store.js';
import { listFiles, SevenZipExtractor, type Extractor } from './extract.js';
import { RateLimitedError, RATE_LIMIT_MESSAGE_PREFIX, SyncHttpClient } from './http-client.js';
import {
  CATALOG_RATE_BUDGET,
  systemClock,
  TokenBucket,
  type SyncClock,
} from './rate-budget.js';

/** FMD2-DB repo pin (§6; FMDOptions DB_URL / GitHubRepoV3 config). */
export const FMD2_DB_REPO_DEFAULT = {
  owner: 'dazedcat19',
  name: 'FMD2-DB',
  ref: 'master',
} as const;

export interface CatalogSyncOptions {
  /** Data root: catalogs/, fts/, tmp/ and the batch state live here. */
  readonly dataDir: string;
  /** Blob base (`<dbUrl>/7z/<ID>.7z`, §6.2). Defaults to the pinned
   * FMD2-DB raw URL; tests point it at the loopback mock server. */
  readonly dbUrl?: string;
  /** Commits API base (§6.1). Defaults to `https://api.github.com`. */
  readonly apiBase?: string;
  /** Repo pin. Defaults to `dazedcat19/FMD2-DB@master`. */
  readonly repo?: typeof FMD2_DB_REPO_DEFAULT;
  /** GitHub token (anonymous works, tightly rate-limited). */
  readonly token?: string;
  /** Catalog id universe hook (the module registry supplies it in
   * production; tests wire fixture ids). */
  readonly knownCatalogIds?: () => readonly ModuleId[];
  /** Clock — inject a fake in tests for deterministic budget pacing. */
  readonly clock?: SyncClock;
  /** Budget — defaults to the §6.1 10 r/s / burst-50 bucket. */
  readonly budget?: TokenBucket;
  /** Extractor — defaults to the docker-shipped 7zz/7za binary. */
  readonly extractor?: Extractor;
  /** Transport override for loopback integration tests. */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Batch state file (defaults `<dataDir>/sync/catalog-batch.json`). */
  readonly statePath?: string;
  /**
   * Fault-injection hook, called AFTER extraction, immediately before
   * the atomic rename lands the new catalog. A throw (or a hard exit)
   * here simulates the §6.3 crash window; the invariant under test is
   * that no partial catalog is ever visible at the target path.
   */
  readonly onBeforeInstall?: (catalogId: ModuleId) => void;
}

interface CommitRow {
  sha?: unknown;
}

export class CatalogSync implements CatalogSyncService {
  readonly store: CatalogStore;

  private readonly dataDir: string;
  private readonly dbUrl: string;
  private readonly apiBase: string;
  private readonly repo: typeof FMD2_DB_REPO_DEFAULT;
  private readonly knownCatalogIds: () => readonly ModuleId[];
  private readonly budget: TokenBucket;
  private readonly extractor: Extractor;
  private readonly http: SyncHttpClient;
  private readonly state: BatchStateStore;
  private readonly onBeforeInstall: ((catalogId: ModuleId) => void) | undefined;
  private readonly fileStore: CatalogFileStore;

  constructor(options: CatalogSyncOptions) {
    this.dataDir = options.dataDir;
    this.repo = options.repo ?? FMD2_DB_REPO_DEFAULT;
    this.dbUrl =
      options.dbUrl ??
      `https://raw.githubusercontent.com/${this.repo.owner}/${this.repo.name}/${this.repo.ref}/db`;
    this.apiBase = options.apiBase ?? 'https://api.github.com';
    const clock: SyncClock = options.clock ?? systemClock;
    this.budget =
      options.budget ?? new TokenBucket(CATALOG_RATE_BUDGET.burst, CATALOG_RATE_BUDGET.requestsPerSecond, clock);
    this.extractor = options.extractor ?? new SevenZipExtractor();
    this.http = new SyncHttpClient(
      this.budget,
      clock,
      options.token === undefined ? {} : { token: options.token },
      options.fetchImpl,
    );
    this.state = new BatchStateStore(
      options.statePath ?? path.join(this.dataDir, 'sync', 'catalog-batch.json'),
      `${this.repo.owner}/${this.repo.name}`,
    );
    this.knownCatalogIds = options.knownCatalogIds ?? (() => []);
    this.onBeforeInstall = options.onBeforeInstall;
    this.fileStore = new CatalogFileStore({ dataDir: this.dataDir });
    this.store = this.fileStore;
  }

  /** §6.1 — exactly one commits-API call; no blob traffic here. */
  async checkForUpdates(): Promise<CatalogUpdateCheck> {
    const url: string =
      `${this.apiBase}/repos/${this.repo.owner}/${this.repo.name}/commits` +
      `?sha=${this.repo.ref}&per_page=1`;
    const current: CatalogBatchState = this.state.load();
    const { data, etag, status } = await this.http.getJson(url, current.lastCommitEtag);
    if (status === 304 || data === null) {
      // Conditional re-check: the pin has not moved.
      return {
        repo: `${this.repo.owner}/${this.repo.name}`,
        headSha: current.lastCommitSha,
        changed: false,
        changedIds: [...current.pending],
      };
    }
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('sync: commits API returned no commits');
    }
    const headSha: string = (data[0] as CommitRow).sha as string;
    if (typeof headSha !== 'string' || headSha === '') {
      throw new Error('sync: commits API returned no sha');
    }
    const changed: boolean = headSha !== current.lastCommitSha;
    const changedIds: ModuleId[] = [...current.pending];
    if (changed) {
      // New pin → re-verify every known catalog via its per-file ETag.
      for (const id of this.knownCatalogIds()) {
        if (!changedIds.includes(id)) {
          changedIds.push(id);
        }
      }
      const frozen: readonly ModuleId[] = changedIds;
      this.state.mutate((state) => {
        state.pending = [...frozen];
      });
    }
    this.state.markChecked(headSha, etag);
    return {
      repo: `${this.repo.owner}/${this.repo.name}`,
      headSha,
      changed,
      changedIds,
    };
  }

  /** §6.2–§6.3 — fetch + extract + atomic install of one catalog. */
  async syncCatalog(catalogId: ModuleId): Promise<CatalogSyncResult> {
    if (!isValidCatalogId(catalogId)) {
      return { id: catalogId, state: 'failed', error: `invalid catalog id: ${catalogId}` };
    }
    const url: string = `${this.dbUrl}/7z/${catalogId}.7z`;
    const etag: string = this.state.load().etags[catalogId] ?? '';
    let response;
    try {
      response = await this.http.getBlob(url, etag);
    } catch (err: unknown) {
      // Pending keeps the id → resumable; the error string is surfaced.
      return { id: catalogId, state: 'failed', error: String((err as Error).message) };
    }
    if (response.status === 304) {
      // Unchanged: drop from pending, keep the ETag (§6.1 conditional GET).
      this.state.markFetched(catalogId, etag);
      return { id: catalogId, state: 'unchanged' };
    }
    try {
      const meta: { dbSha: string; bytes: number } = await this.installBlob(catalogId, response.body);
      this.state.markFetched(catalogId, response.etag);
      return { id: catalogId, state: 'updated', dbSha: meta.dbSha, bytes: meta.bytes };
    } catch (err: unknown) {
      return { id: catalogId, state: 'failed', error: String((err as Error).message) };
    }
  }

  /**
   * Install pipeline: tmp 7z → extract into a FRESH temp dir → locate
   * the single .db → sha256 → ATOMIC RENAME to data/catalogs/<ID>.db.
   * Never in-place: the rename either fully lands the new file or (on
   * a crash before it) leaves the previous state untouched.
   */
  private async installBlob(catalogId: ModuleId, blob: Buffer): Promise<{ dbSha: string; bytes: number }> {
    const tmpDir: string = path.join(this.dataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const nonce: string = `${Date.now()}-${process.pid}`;
    const archivePath: string = path.join(tmpDir, `${catalogId}.${nonce}.7z`);
    const extractDir: string = path.join(tmpDir, `${catalogId}.${nonce}.x`);
    try {
      fs.writeFileSync(archivePath, blob);
      // The temp dir is only touched again AFTER extraction completed.
      await this.extractor.extract(archivePath, extractDir);

      // ── crash window under test: extraction done, rename next ──
      this.onBeforeInstall?.(catalogId);

      const dbs: string[] = listFiles(extractDir).filter((f) => f.endsWith('.db'));
      if (dbs.length !== 1) {
        throw new Error(`catalog archive must contain exactly one .db (got ${String(dbs.length)})`);
      }
      const extracted: string = path.join(extractDir, dbs[0] as string);
      const dbSha: string = fileSha256(extracted);
      const bytes: number = fs.statSync(extracted).size;
      const catalogsDir: string = path.join(this.dataDir, 'catalogs');
      fs.mkdirSync(catalogsDir, { recursive: true });
      const target: string = path.join(catalogsDir, `${catalogId}.db`);
      // Atomic swap-in: fsync the file so the rename publishes complete
      // content, then rename (same dataDir tree → same filesystem).
      const fd: number = fs.openSync(extracted, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.fileStore.invalidate(catalogId);
      fs.renameSync(extracted, target);
      this.fileStore.writeInstallReceipt(catalogId, dbSha, new Date().toISOString());
      // Fresh install → the sidecar rebuilds from the new db_sha on the
      // next search (§6.5 keyed-by-db_sha invalidation).
      return { dbSha, bytes };
    } finally {
      try {
        fs.rmSync(archivePath, { force: true });
      } catch {
        // best effort
      }
      try {
        fs.rmSync(extractDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  /**
   * Drain the changed set (pending carry-over + caller ids). Each
   * success drops the id from the persisted pending set immediately, so
   * a crash mid-batch resumes exactly at the remaining ids. A rate
   * limit stops the batch cleanly — remaining ids stay pending.
   */
  async syncChanged(ids?: readonly ModuleId[]): Promise<readonly CatalogSyncResult[]> {
    const queue: ModuleId[] = [];
    const push = (id: ModuleId): void => {
      if (!queue.includes(id)) {
        queue.push(id);
      }
    };
    if (ids !== undefined) {
      for (const id of ids) {
        push(id);
      }
    }
    for (const id of this.state.load().pending) {
      push(id);
    }
    const results: CatalogSyncResult[] = [];
    for (const id of queue) {
      const result: CatalogSyncResult = await this.syncCatalog(id);
      results.push(result);
      if (result.error !== undefined && result.error.startsWith(RATE_LIMIT_MESSAGE_PREFIX)) {
        break;
      }
    }
    return results;
  }

  /** Sidecar invalidation hook (contract): drop caches + receipt so the
   * next read re-derives state from the files (db_sha change → sidecar
   * rebuilds, §6.5). */
  invalidate(catalogId: ModuleId): void {
    this.fileStore.invalidate(catalogId);
  }
}

// RateLimitedError is exported for typed catching by callers; inside the
// batch it is recognized via its stable message prefix so the result
// type stays contract-only.
export { RateLimitedError };
