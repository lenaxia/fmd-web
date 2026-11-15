import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { ReadinessProbe, type ProbeCheck, type ReadinessProbeOptions } from './health.js';

/**
 * Backup/restore (DESIGN.md §9): "backup = documented `sqlite3 .backup`
 * + file copy; restore validated at startup".
 *
 * - {@link backupDataDir} snapshots `<dataDir>` into a backup directory:
 *   every SQLite file (app.db queue/library, catalogs, FTS sidecars) via
 *   better-sqlite3's `db.backup()` — the SAME online backup API as
 *   `sqlite3 .backup`, consistent while writers run (coalesced progress
 *   flushes keep flowing; no stop-the-world required) — and every other
 *   regular artifact (module tree, receipts, sync-state) via a plain
 *   file copy. `-journal`/`-wal`/`-shm` sidecars are excluded: the
 *   backup API already folds their content into the snapshot, and
 *   copying a live sidecar would be a torn read.
 * - {@link restoreDataDir} copies the snapshot back over `<dataDir>`
 *   (overwrites matching paths; unrelated newer files are left alone —
 *   conservative restore) and then RUNS THE READINESS CHECKS as the
 *   restore validation (§9 "restore validated at startup"): app db
 *   opens + answers, catalogs attachable, lua tree present. The
 *   rehearsed path (backup → corrupt → restore → readyz green) is a
 *   test in `server/test/observability/`.
 */

/** SQLite sidecars that must never be copied (the backup API folds them). */
function isSqliteSidecar(name: string): boolean {
  return name.endsWith('-journal') || name.endsWith('-wal') || name.endsWith('-shm');
}

function isDbFile(name: string): boolean {
  return name.endsWith('.db') && !isSqliteSidecar(name);
}

/** Walk a directory tree, returning regular files (relative paths). */
function walkFiles(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkFiles(root, full));
    } else if (stat.isFile()) {
      out.push(relative(root, full));
    }
  }
  return out.sort();
}

export interface BackupReport {
  readonly backupDir: string;
  /** SQLite files snapshotted via the online backup API. */
  readonly dbFiles: readonly string[];
  /** Non-DB artifacts copied verbatim. */
  readonly copiedFiles: readonly string[];
  readonly bytes: number;
}

export interface BackupOptions {
  readonly dataDir: string;
  readonly backupDir: string;
}

/** Snapshot `<dataDir>` → `<backupDir>` (§9). Creates the backup dir. */
export async function backupDataDir(options: BackupOptions): Promise<BackupReport> {
  const { dataDir, backupDir } = options;
  if (!existsSync(dataDir)) {
    throw new Error(`backup: data dir missing: ${dataDir}`);
  }
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(backupDir, { recursive: true });

  const all = walkFiles(dataDir);
  const dbFiles: string[] = [];
  const copiedFiles: string[] = [];
  let bytes = 0;

  for (const rel of all) {
    const source = join(dataDir, rel);
    const dest = join(backupDir, rel);
    const name = rel.split(/[\\/]/).pop() ?? '';
    if (isSqliteSidecar(name)) {
      // Live WAL/journal state is folded into the db snapshot by the
      // backup API — a copied sidecar would be a torn read.
      continue;
    }
    if (isDbFile(name)) {
      mkdirSync(dirname(dest), { recursive: true });
      const db = new Database(source, { readonly: true });
      try {
        // Online backup API (sqlite3 .backup equivalent): consistent
        // snapshot even while writers append (WAL/journal folded in).
        await db.backup(dest);
      } finally {
        db.close();
      }
      dbFiles.push(rel);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(source, dest);
      copiedFiles.push(rel);
    }
    bytes += statSync(dest).size;
  }
  return { backupDir, dbFiles, copiedFiles, bytes };
}

export interface RestoreReport {
  readonly restoredFiles: readonly string[];
  /** §9 restore validation = the readiness checks (all must pass). */
  readonly validation: readonly ProbeCheck[];
  readonly valid: boolean;
}

export interface RestoreOptions {
  readonly backupDir: string;
  readonly dataDir: string;
  /** Probe options for the post-restore validation (dirs default). */
  readonly probe?: ReadinessProbeOptions;
}

/**
 * Copy the snapshot back over `<dataDir>` and validate (§9): matching
 * paths are overwritten atomically (tmp + rename per file); files that
 * the snapshot does not carry are left untouched.
 */
export function restoreDataDir(options: RestoreOptions): RestoreReport {
  const { backupDir, dataDir } = options;
  if (!existsSync(backupDir)) {
    throw new Error(`restore: backup dir missing: ${backupDir}`);
  }
  const restoredFiles: string[] = [];
  for (const rel of walkFiles(backupDir)) {
    const source = join(backupDir, rel);
    const dest = join(dataDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.restore-tmp`;
    cpSync(source, tmp);
    renameSync(tmp, dest);
    restoredFiles.push(rel);
  }
  const probe = new ReadinessProbe({ dataDir, ...options.probe });
  const validation = probe.checks();
  return {
    restoredFiles,
    validation,
    valid: validation.every((check) => check.ok),
  };
}

/** The §9 startup validation, standalone (probe checks over a data dir). */
export function validateDataDir(dataDir: string, probeOptions: Omit<ReadinessProbeOptions, 'dataDir'> = {}): readonly ProbeCheck[] {
  return new ReadinessProbe({ dataDir, ...probeOptions }).checks();
}
