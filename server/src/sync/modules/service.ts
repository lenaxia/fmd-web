import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SyncPin } from '../pin.js';
import type { HostLogger } from '@fmd/contract';
import {
  createHostLogBuffer,
  type ModuleHostFactory,
  type StagedTreeValidation,
} from '../../engine/facade.js';
import type { ModuleSyncConfig } from './config.js';
import { ModuleSyncConfigError } from './config.js';
import { codeloadZipballUrl } from './config.js';
import type { ModuleArchiveFetcher } from './fetch.js';
import { CodeloadArchiveFetcher, expectedTarballRoot, githubTarballUrl, ModuleSyncFetchError } from './fetch.js';
import type { SyncStateEntry, SyncStateStore, ModuleSyncReport } from './state.js';
import { FileSyncStateStore } from './state.js';
import type { ModuleInventoryEntry } from './diff.js';
import { diffModuleInventories } from './diff.js';
import { installStagedTree } from './swap.js';
import { readTarGz } from './tarball.js';
import { readZipball, type ZipballEntry } from './zipball.js';

/**
 * ModuleSyncService (DESIGN.md §6, §8.5, D9): fetch the FMD2 repo `lua/`
 * subtree at a PINNED commit (codeload zipball), stage it into a temp dir
 * on the data volume, run the strict Init-pass validation on the staged
 * tree, then atomically swap it into `data/lua/` and record
 * sync_state(repo, sha, fetched_at, report). The report carries a module
 * diff vs the previous pin (added/removed/changed by ID/Name) for the D9
 * review gate. `FMD_LUA_DIR` replaces the fetch with a local tree for
 * development (same staging/validation/swap path). Auto-bump is disabled
 * by design: this service syncs to the configured pin only.
 */

export type ModuleSyncFailureReason =
  | 'config'
  | 'fetch-failed'
  | 'zip-corrupt'
  | 'sha-mismatch'
  | 'local-dir-missing'
  | 'staged-init-failed';

export class ModuleSyncError extends Error {
  constructor(
    readonly reason: ModuleSyncFailureReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ModuleSyncError';
  }
}

export interface ModuleSyncResult {
  readonly sha: string;
  readonly previousSha: string | null;
  readonly source: ModuleSyncReport['source'];
  readonly targetDir: string;
  readonly report: ModuleSyncReport;
}

export interface ModuleSyncDeps {
  readonly fetcher?: ModuleArchiveFetcher;
  readonly stateStore?: SyncStateStore;
  readonly logger?: HostLogger;
  /** Injectable clock for deterministic `fetched_at` (tests). */
  readonly now?: () => string;
  /**
   * Lua host factory (injected by the composition root): feeds the
   * staged-tree Init-pass validation behind the contract interface.
   */
  readonly hostFactory: ModuleHostFactory;
}

export interface ModuleSyncService {
  /** Fetch → stage → validate → atomic swap → record. Never mutates `data/lua/` on refusal. */
  sync(): Promise<ModuleSyncResult>;
}

/**
 * GitHub codeload names the zipball root `<RepoName>-<first 10 hex of the
 * SHA>` — e.g. `FMD2-97c903b340`. Verifying the extracted root against the
 * configured pin is the SHA-mismatch guard: a response for any other ref
 * (branch, tag, other commit — or an archive whose root lies about the
 * request) is refused before a single file touches the data dir.
 */
export function expectedZipballRoot(repo: string, sha: string): string {
  return `${basename(repo)}-${sha.slice(0, 10)}`;
}

export function createModuleSyncService(
  config: ModuleSyncConfig,
  deps: ModuleSyncDeps,
): ModuleSyncService {
  if (config.autoBump) {
    throw new ModuleSyncConfigError(
      'auto-bump cannot be enabled (D9): sync runs against the configured pin only — ' +
        'a pin bump is a deployment act (PR + module-diff report).',
    );
  }
  const fetcher = deps.fetcher ?? new CodeloadArchiveFetcher();
  const stateStore = deps.stateStore ?? new FileSyncStateStore(join(config.dataDir, 'sync-state.json'));
  const logger = deps.logger ?? createHostLogBuffer();
  const now = deps.now ?? ((): string => new Date().toISOString());

  return {
    async sync(): Promise<ModuleSyncResult> {
      const previous = await stateStore.get(config.repo);
      const previousSha = previous?.sha ?? null;
      const previousInventory: readonly ModuleInventoryEntry[] = previous?.report.inventory ?? [];

      mkdirSync(config.dataDir, { recursive: true });
      const workDir = mkdtempSync(join(config.dataDir, `.sync-${randomBytes(4).toString('hex')}-`));
      const stagedDir = join(workDir, 'lua');
      try {
        const source: ModuleSyncReport['source'] =
          config.luaDirOverride !== undefined ? 'local-dir' : 'codeload';
        if (source === 'local-dir') {
          stageLocalDir(config.luaDirOverride as string, stagedDir);
        } else {
          await stageArchiveSubtree(config, fetcher, stagedDir);
        }

        // The staged Init-pass validator is behind the engine production
        // door (its module transitively imports the shim installer →
        // wasmoon): loaded lazily HERE so the app's static graph — and a
        // substituted substrate's boot path — stays wasmoon-free.
        const { validateStagedLuaTree, StagedInitError } = await import('../../engine/index.js');
        let validation: StagedTreeValidation;
        try {
          validation = await validateStagedLuaTree(stagedDir, logger, {
            previousInventory,
            hostFactory: deps.hostFactory,
          });
        } catch (error) {
          if (error instanceof StagedInitError) {
            throw new ModuleSyncError(
              'staged-init-failed',
              `refusing to install: staged tree failed Init-pass validation — ${error.message}`,
              { failures: error.failures, ...(error.toleranceReason !== undefined ? { toleranceReason: error.toleranceReason } : {}) },
            );
          }
          throw error;
        }

        const { targetDir } = installStagedTree(stagedDir, join(config.dataDir, 'lua'));

        const fetchedAt = now();
        const report: ModuleSyncReport = {
          repo: config.repo,
          sha: config.sha,
          fetchedAt,
          source,
          previousSha,
          luaFiles: validation.luaFiles,
          moduleFiles: validation.moduleFiles,
          otherFiles: validation.otherFiles,
          modules: validation.inventory.length,
          warnings: validation.warnings,
          failures: validation.failures.map((failure) => ({
            file: failure.file,
            firstError: failure.errors[0] ?? 'unknown error',
          })),
          diff: diffModuleInventories(previousInventory, validation.inventory),
          inventory: validation.inventory,
        };
        const entry: SyncStateEntry = {
          repo: config.repo,
          sha: config.sha,
          fetchedAt,
          report,
        };
        await stateStore.record(entry);

        return {
          sha: config.sha,
          previousSha,
          source,
          targetDir,
          report,
        };
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  };
}

/** Development override (`FMD_LUA_DIR`): copy the local tree into staging. */
function stageLocalDir(luaDir: string, stagedDir: string): void {
  if (!existsSync(luaDir)) {
    throw new ModuleSyncError('local-dir-missing', `FMD_LUA_DIR does not exist: ${luaDir}`);
  }
  cpSync(luaDir, stagedDir, { recursive: true });
}

/**
 * Fetch the pinned tree (zipball → tarball fallback chain), verify its
 * root directory against the pin (per-format convention), and extract
 * only the `lua/` subtree into the staging dir.
 */
async function stageArchiveSubtree(
  config: ModuleSyncConfig,
  fetcher: ModuleArchiveFetcher,
  stagedDir: string,
): Promise<void> {
  const pin: SyncPin = { repo: config.repo, sha: config.sha };
  const urls = {
    zipball: codeloadZipballUrl(config.repo, config.sha, config.codeloadBaseUrl),
    tarball: githubTarballUrl(config.repo, config.sha, config.tarballApiBaseUrl),
  };
  let archive: Awaited<ReturnType<ModuleArchiveFetcher['fetchArchive']>>;
  try {
    archive = await fetcher.fetchArchive(urls);
  } catch (error) {
    if (error instanceof ModuleSyncFetchError) {
      throw new ModuleSyncError('fetch-failed', error.message, {
        repo: pin.repo,
        sha: pin.sha,
        fetchKind: error.kind,
        attempts: error.attempts,
      });
    }
    throw new ModuleSyncError('fetch-failed', errorMessage(error), { repo: pin.repo, sha: pin.sha });
  }

  let entries: ZipballEntry[];
  try {
    entries = archive.format === 'zip' ? readZipball(archive.bytes) : readTarGz(archive.bytes);
  } catch (error) {
    throw new ModuleSyncError(
      'zip-corrupt',
      `${archive.endpoint} for ${config.sha} is not a readable archive: ${errorMessage(error)}`,
    );
  }

  const root = verifyArchiveRoot(entries, config.repo, config.sha, archive.format);
  // explicit trailing slash: posix.join(root, 'lua', '') drops it, which
  // would leave a leading '/' on every sliced relative path
  const subtreePrefix = `${root}/lua/`;
  const subtree = entries.filter((entry) => entry.name.startsWith(subtreePrefix));
  if (subtree.length === 0) {
    throw new ModuleSyncError(
      'zip-corrupt',
      `${archive.endpoint} for ${config.sha} contains no lua/ subtree (expected ${subtreePrefix}*)`,
    );
  }
  for (const entry of subtree) {
    const relative = safeSubtreeRelative(entry.name, subtreePrefix);
    const target = join(stagedDir, relative);
    // zip-slip containment assert (belt to the segment guard's suspenders):
    // the resolved target must stay inside the staging dir
    if (!resolve(target).startsWith(resolve(stagedDir) + sep)) {
      throw new ModuleSyncError(
        'zip-corrupt',
        `zipball entry escapes the lua/ subtree: ${entry.name} (resolved outside staging)`,
      );
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
}

/**
 * Zip-slip guard (§8.5): the path under the staged tree is the zipball name
 * minus the `<root>/lua/` prefix — it must be a clean relative path. Any
 * traversal (`..`), current-dir (`.`), empty, or backslash segment is a
 * crafted escape and refuses the sync before a single byte is written.
 */
export function safeSubtreeRelative(entryName: string, subtreePrefix: string): string {
  const relative = entryName.startsWith(subtreePrefix) ? entryName.slice(subtreePrefix.length) : '';
  const segments = relative.split('/');
  if (
    relative === '' ||
    segments.some((segment) => segment === '..' || segment === '.' || segment === '' || segment.includes('\\'))
  ) {
    throw new ModuleSyncError(
      'zip-corrupt',
      `zipball entry escapes the lua/ subtree: ${entryName} (traversal or malformed segment)`,
    );
  }
  return relative;
}

/**
 * The archive root dir must be exactly the pin's expected root for the
 * format: `<Repo>-<sha10>` (zipball/codeload) or `<owner>-<Repo>-<sha7>`
 * (tarball/api.github.com — verified live).
 */
function verifyArchiveRoot(
  entries: readonly ZipballEntry[],
  repo: string,
  sha: string,
  format: 'zip' | 'tar-gzip',
): string {
  const roots = new Set<string>();
  for (const entry of entries) {
    const firstSegment = entry.name.split('/')[0];
    if (firstSegment === undefined || firstSegment === '') {
      throw new ModuleSyncError('zip-corrupt', `archive entry escapes the archive root: ${entry.name}`);
    }
    roots.add(firstSegment);
  }
  if (roots.size !== 1) {
    throw new ModuleSyncError(
      'zip-corrupt',
      `archive must contain a single root directory, found: ${[...roots].sort().join(', ') || '(none)'}`,
    );
  }
  const root = [...roots][0] as string;
  const expected = format === 'zip' ? expectedZipballRoot(repo, sha) : expectedTarballRoot(repo, sha);
  if (root.toLowerCase() !== expected.toLowerCase()) {
    throw new ModuleSyncError(
      'sha-mismatch',
      `SHA mismatch: requested ${sha} but the ${format === 'zip' ? 'zipball' : 'tarball'} root is "${root}" ` +
        `(expected "${expected}") — refusing to install`,
      { expectedRoot: expected, actualRoot: root, sha },
    );
  }
  return root;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
