/**
 * One-time library layout migration (library-layout story): moves every
 * ledger-recorded file still on the OLD `<module>/<manga>/<file>`
 * layout onto the new flat `<manga>/<file>` convention (module suffix
 * on the FOLDER only for duplicates — layout.ts rule 2), updates the
 * recorded ledger rows (path + effective folder), and logs a summary.
 *
 * IDEMPOTENT by detection: a row is old-layout only when its recorded
 * root-relative path is exactly `<row.moduleId>/<row.manga>/<row.fileName>`
 * — the depth-3 shape the pre-change finalizer wrote, segment-matched
 * against the row's own recorded components. saveTo rows live wherever
 * the override resolved (any depth, user-chosen segments) and are left
 * untouched; the one documented edge is a saveTo that literally
 * resolved to `<sanitized module>/<sanitized manga>/<file>` —
 * shape-identical to a default row, migrated with it.
 *
 * FIRST WRITER KEEPS THE CLEAN NAME: rows process in ascending id
 * order, and the clean folder is claimed by the first module to reach
 * it (seeded from rows ALREADY on the new layout — a partial earlier
 * run — and from folders existing on disk with no ledger attribution:
 * an unknown claim, conservative → the newcomer suffixes). No
 * retroactive renames: an already-suffixed folder never collapses back
 * onto a freed clean name.
 *
 * Files not in the ledger are not adopted (no extra logic — the
 * existing rescan/orphan machinery owns them). A file missing at its
 * recorded old path still gets its ledger row re-pointed (the row was
 * missing before; it stays missing at the new location until a rescan
 * re-links). A target already occupied by a stray file is a COLLISION:
 * nothing moves, the row keeps its old-layout path (retried next boot)
 * and the stray stays rescan truth.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LibraryLedgerRow } from './reconcile.js';
import { suffixedMangaFolder } from './layout.js';
import type { SqliteLibraryStore } from './store.js';
import { lexicalRelFromRoot } from '../../fs-walk.js';

export interface LayoutMigrationSummary {
  /** Files moved on disk (and their rows re-pointed). */
  readonly moved: number;
  /** Rows re-pointed whose file was already gone (stays missing). */
  readonly repointed: number;
  /** Rows moved into a suffixed duplicate folder. */
  readonly suffixed: number;
  /** Rows left untouched (already new-layout / outside root / saveTo). */
  readonly skipped: number;
  /** Targets occupied by a stray file — nothing moved, retried next boot. */
  readonly collisions: number;
  /** Unexpected per-row errors (logged; the row keeps its old path). */
  readonly failures: number;
  /** Empty directory shells pruned after the moves (old layout trees). */
  readonly pruned: number;
}

export interface LayoutMigrationDeps {
  readonly store: SqliteLibraryStore;
  /** Absolute library root (the migration is a no-op without rows). */
  readonly root: string;
  readonly log?: (message: string) => void;
}

/** Is this recorded path the OLD depth-3 layout this row itself wrote? */
export function isOldLayoutRow(root: string, row: LibraryLedgerRow): boolean {
  const rel = lexicalRelFromRoot(root, row.path);
  if (rel === undefined) {
    return false;
  }
  const segments = rel.split('/');
  return (
    segments.length === 3 &&
    segments[0] === row.moduleId &&
    segments[1] === row.manga &&
    segments[2] === row.fileName
  );
}

/**
 * Run the one-time migration (idempotent — re-running over a migrated
 * tree finds only new-layout rows and skips them all).
 */
export function migrateLibraryLayout(deps: LayoutMigrationDeps): LayoutMigrationSummary {
  const { store, root, log } = deps;
  const rows = store.allLibraryLedgerRows(); // ascending id — first writer wins

  // Clean-folder claims: sanitized module segment per folder name.
  const claims = new Map<string, string>();
  for (const row of rows) {
    const rel = lexicalRelFromRoot(root, row.path);
    if (rel === undefined) {
      continue;
    }
    const segments = rel.split('/');
    if (segments.length === 2 && segments[0] === row.manga && !claims.has(row.manga)) {
      claims.set(row.manga, row.moduleId);
    }
  }
  // Folders on disk with no ledger attribution: unknown claims.
  const diskFolders = new Set<string>();
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        diskFolders.add(entry.name);
      }
    }
  } catch {
    // root does not exist yet (fresh deployment) — nothing to claim
  }

  let moved = 0;
  let repointed = 0;
  let suffixed = 0;
  let skipped = 0;
  let collisions = 0;
  let failures = 0;
  const persist: Array<{ id: number; path: string; manga: string; bytes?: number; mtimeMs?: number }> = [];

  for (const row of rows) {
    if (!isOldLayoutRow(root, row)) {
      skipped += 1;
      continue;
    }
    try {
      const clean = row.manga;
      const claimant = claims.get(clean);
      // Suffix when a DIFFERENT module holds the clean name, or when an
      // unattributed on-disk folder occupies it (unknown claim).
      const foreign =
        (claimant !== undefined && claimant !== row.moduleId) ||
        (claimant === undefined && diskFolders.has(clean));
      const folder = foreign ? suffixedMangaFolder(clean, row.moduleId) : clean;
      if (folder !== clean) {
        suffixed += 1;
      }
      const targetPath = join(root, folder, row.fileName);
      const sourceExists = existsSync(row.path);
      if (sourceExists && existsSync(targetPath) && row.path !== targetPath) {
        collisions += 1;
        log?.(
          `[library-layout-migration] collision: ${row.path} → ${targetPath} occupied — left in place (rescan truth)`,
        );
        continue;
      }
      if (sourceExists) {
        mkdirSync(dirname(targetPath), { recursive: true });
        renameSync(row.path, targetPath);
        const st = statSync(targetPath);
        persist.push({ id: row.id, path: targetPath, manga: folder, bytes: st.size, mtimeMs: st.mtimeMs });
        moved += 1;
      } else {
        persist.push({ id: row.id, path: targetPath, manga: folder });
        repointed += 1;
      }
      // Register the claim: the module owns the folder it actually
      // took (a suffixed row never claims the clean name).
      if (!claims.has(folder)) {
        claims.set(folder, row.moduleId);
      }
    } catch (error: unknown) {
      failures += 1;
      log?.(
        `[library-layout-migration] failure on row ${String(row.id)} (${row.path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  store.applyLayoutMigration(persist);

  // Post-move hygiene: the old `<module>/<manga>` shells are empty once
  // their files moved — prune empty directories bottom-up so the flat
  // root actually sheds the per-site trees. NEVER touches a dir that
  // still holds anything (non-ledger strays keep their tree — orphan
  // machinery truth) and never the root itself.
  let pruned = 0;
  if (moved > 0 || repointed > 0) {
    pruned = pruneEmptyDirs(root);
  }
  const summary: LayoutMigrationSummary = { moved, repointed, suffixed, skipped, collisions, failures, pruned };
  log?.(
    `[library-layout-migration] done: moved=${String(moved)} repointed=${String(repointed)} ` +
      `suffixed=${String(suffixed)} skipped=${String(skipped)} collisions=${String(collisions)} ` +
      `failures=${String(failures)} prunedDirs=${String(pruned)}`,
  );
  return summary;
}

/** Bottom-up removal of empty dirs under `dir` (never `dir` itself). */
function pruneEmptyDirs(dir: string): number {
  let removed = 0;
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = join(dir, entry.name);
    removed += pruneEmptyDirs(child);
    try {
      // rmdir only succeeds on an EMPTY dir — a dir still holding a
      // stray file (orphan-machinery truth) refuses and stays.
      rmdirSync(child);
      removed += 1;
    } catch {
      // not empty (or already gone) — keep it
    }
  }
  return removed;
}
