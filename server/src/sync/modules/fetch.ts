/**
 * Module-archive fetch chain (launch defect (d): codeload zipball 500s):
 * the pinned tree is fetched zipball-first from codeload, and when that
 * leg is unreachable or answers 5xx (observed in the wild: HTTP 500 from
 * codeload on this network while the api.github.com tarball endpoint
 * serves the same commit fine) the chain falls back ONCE to the
 * `api.github.com/repos/<owner>/<repo>/tarball/<sha>` endpoint.
 * `FMD_LUA_DIR` remains the manual escape hatch (the chain never runs
 * under the local-dir override).
 *
 * Root-name conventions differ by endpoint and are verified downstream:
 *   zipball  → `<Repo>-<sha10>`      (codeload)
 *   tarball  → `<owner>-<Repo>-<sha7>` (api.github.com, verified live)
 *
 * Every failure is typed (`ModuleSyncFetchError` carries the kind AND
 * the full attempt chain) — nothing fails silently.
 */

export type ArchiveFormat = 'zip' | 'tar-gzip';
export type ModuleSyncFetchEndpoint = 'zipball' | 'tarball';
export type ModuleSyncFetchFailureKind = 'unreachable' | 'http-error' | 'too-large';

export interface FetchAttempt {
  readonly endpoint: ModuleSyncFetchEndpoint;
  readonly url: string;
  readonly status?: number;
}

export class ModuleSyncFetchError extends Error {
  constructor(
    readonly kind: ModuleSyncFetchFailureKind,
    message: string,
    readonly attempts: readonly FetchAttempt[],
  ) {
    super(message);
    this.name = 'ModuleSyncFetchError';
  }
}

export interface FetchedArchive {
  readonly bytes: Uint8Array;
  readonly format: ArchiveFormat;
  /** Which endpoint served the bytes (report + evidence surface). */
  readonly endpoint: ModuleSyncFetchEndpoint;
}

export interface ArchiveUrls {
  readonly zipball: string;
  readonly tarball: string;
}

export interface ModuleArchiveFetcher {
  fetchArchive(urls: ArchiveUrls): Promise<FetchedArchive>;
}

export interface FetchOptions {
  readonly timeoutMs?: number;
  /** Refuse archives larger than this (a module-tree archive is ~tens of MiB). */
  readonly maxBytes?: number;
}

export const DEFAULT_ARCHIVE_TIMEOUT_MS = 60_000;
export const DEFAULT_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;

/** api.github.com tarball URL for a pinned commit. */
export function githubTarballUrl(repo: string, sha: string, apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}/repos/${repo}/tarball/${sha}`;
}

/** api.github.com tarball root convention: `<owner>-<Repo>-<sha7>` (verified live). */
export function expectedTarballRoot(repo: string, sha: string): string {
  const owner = repo.includes('/') ? (repo.split('/')[0] as string) : repo;
  const name = repo.includes('/') ? (repo.split('/')[1] as string) : repo;
  return `${owner}-${name}-${sha.slice(0, 7)}`;
}

type LegResult =
  | {
      readonly ok: true;
      readonly archive: FetchedArchive;
    }
  | {
      readonly ok: false;
      readonly kind: ModuleSyncFetchFailureKind;
      readonly status?: number;
      readonly message: string;
    };

export class CodeloadArchiveFetcher implements ModuleArchiveFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: FetchOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;
  }

  async fetchArchive(urls: ArchiveUrls): Promise<FetchedArchive> {
    const attempts: FetchAttempt[] = [];
    const zipball = await this.fetchLeg('zipball', urls.zipball, 'zip', attempts);
    if (zipball.ok) {
      return zipball.archive;
    }
    // Fallback fires ONLY on 5xx / unreachable: a 4xx (wrong pin/ref) or
    // an over-cap body is a configuration/supply-chain problem the
    // tarball endpoint would repeat — fail fast with the typed cause.
    if (zipball.kind === 'unreachable' || (zipball.kind === 'http-error' && (zipball.status ?? 0) >= 500)) {
      const tarball = await this.fetchLeg('tarball', urls.tarball, 'tar-gzip', attempts);
      if (tarball.ok) {
        return tarball.archive;
      }
      throw new ModuleSyncFetchError(tarball.kind, tarball.message, [...attempts]);
    }
    throw new ModuleSyncFetchError(zipball.kind, zipball.message, [...attempts]);
  }

  /** One endpoint attempt — records into `attempts`, never throws. */
  private async fetchLeg(
    endpoint: ModuleSyncFetchEndpoint,
    url: string,
    format: ArchiveFormat,
    attempts: FetchAttempt[],
  ): Promise<LegResult> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
    } catch (error) {
      attempts.push({ endpoint, url });
      return { ok: false, kind: 'unreachable', message: `${endpoint} fetch failed (${url}): ${errorMessage(error)}` };
    }
    if (response.status !== 200) {
      response.body?.cancel();
      attempts.push({ endpoint, url, status: response.status });
      return {
        ok: false,
        kind: 'http-error',
        status: response.status,
        message: `${endpoint} fetch failed (${url}): HTTP ${response.status}`,
      };
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxBytes) {
      attempts.push({ endpoint, url, status: response.status });
      return {
        ok: false,
        kind: 'too-large',
        message: `${endpoint} fetch failed (${url}): ${buffer.byteLength} bytes exceeds the ${this.maxBytes}-byte cap`,
      };
    }
    attempts.push({ endpoint, url, status: response.status });
    return { ok: true, archive: { bytes: new Uint8Array(buffer), format, endpoint } };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
