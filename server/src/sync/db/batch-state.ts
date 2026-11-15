/**
 * Resumable catalog sync batch state (DESIGN.md §6.1) — the §6 work-file
 * model (`GitHubRepoV3.pas:69-113 ReadWorkFile/WriteWorkFile`:
 * last_commit_sha + last_commit_etag) extended with the per-file ETags
 * and the still-to-fetch pending set that makes a batch crash-resumable.
 *
 * Persistence is atomic: every save writes a temp file and renames it
 * over the target (§6.3 discipline applied to our own metadata).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModuleId } from '@fmd/contract';

/** Persisted batch state document. */
export interface CatalogBatchState {
  /** Repo pin this state belongs to (`owner/name`). */
  repo: string;
  /** Last seen commits-API head SHA (empty = never checked). */
  lastCommitSha: string;
  /** ETag of the last commits-API response (conditional re-check). */
  lastCommitEtag: string;
  /** Per-catalog blob ETag from the last successful fetch (If-None-Match). */
  etags: Record<string, string>;
  /** Catalog IDs still to fetch (drives resume after a crash). */
  pending: ModuleId[];
  /** RFC 3339 timestamp of the last state write. */
  updatedAt: string;
}

export function emptyBatchState(repo: string): CatalogBatchState {
  return {
    repo,
    lastCommitSha: '',
    lastCommitEtag: '',
    etags: {},
    pending: [],
    updatedAt: '',
  };
}

/** Crash-safe JSON document store (temp + atomic rename). */
export class BatchStateStore {
  private cache: CatalogBatchState | undefined;

  constructor(
    private readonly filePath: string,
    private readonly repo: string,
  ) {}

  /** Load the persisted state (or a fresh one); cached afterwards. */
  load(): CatalogBatchState {
    if (this.cache !== undefined) {
      return this.cache;
    }
    let state: CatalogBatchState = emptyBatchState(this.repo);
    try {
      const raw: string = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isBatchState(parsed)) {
        state = parsed;
      }
    } catch {
      // Missing/corrupt state = fresh batch (resync from scratch).
    }
    this.cache = state;
    return state;
  }

  /** Mutate the cached state and persist it atomically. */
  mutate(fn: (state: CatalogBatchState) => void): CatalogBatchState {
    const state: CatalogBatchState = this.load();
    fn(state);
    state.updatedAt = new Date().toISOString();
    this.save(state);
    return state;
  }

  /** Replace the pending set (recomputed on every check). */
  setPending(ids: readonly ModuleId[]): void {
    this.mutate((state) => {
      state.pending = [...ids];
    });
  }

  /** Record a completed catalog: store its blob ETag, drop it from pending. */
  markFetched(id: ModuleId, etag: string): void {
    this.mutate((state) => {
      if (etag !== '') {
        state.etags[id] = etag;
      }
      state.pending = state.pending.filter((p) => p !== id);
    });
  }

  /** Record the update-check result (pin + commits-API ETag). */
  markChecked(sha: string, etag: string): void {
    this.mutate((state) => {
      state.lastCommitSha = sha;
      state.lastCommitEtag = etag;
    });
  }

  /** Drop the cached ETag of one catalog (force-refetch on next sync). */
  clearEtag(id: ModuleId): void {
    this.mutate((state) => {
      delete state.etags[id];
    });
  }

  private save(state: CatalogBatchState): void {
    const dir: string = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp: string = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

function isBatchState(value: unknown): value is CatalogBatchState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v: Record<string, unknown> = value as Record<string, unknown>;
  return (
    typeof v['repo'] === 'string' &&
    typeof v['lastCommitSha'] === 'string' &&
    typeof v['lastCommitEtag'] === 'string' &&
    typeof v['etags'] === 'object' &&
    v['etags'] !== null &&
    Array.isArray(v['pending'])
  );
}
