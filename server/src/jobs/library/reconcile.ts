/**
 * Library ledger↔disk reconciliation (library file-state story,
 * owner-approved design): the PURE decision core behind 'Rescan
 * library' — no fs, no db; the caller feeds walked disk entries +
 * ledger rows and persists the outcomes.
 *
 * Re-linking is CONSERVATIVE by ruling — only a confident match
 * auto-relays a ledger row onto a moved file:
 *
 *   1. CONVENTION — the app's own output layout
 *      `<root>/<manga>/<fileName>` (§7.1 fixed-depth as re-ruled by the
 *      library-layout story: the module is not a path segment; the
 *      recorded `manga` segment IS the effective folder — clean, or the
 *      suffixed duplicate form) points at exactly one unclaimed disk
 *      file (unique by construction);
 *   2. EXACT FILENAME — exactly ONE unclaimed disk file anywhere
 *      under the root carries the same file name at a different
 *      directory.
 *
 * Anything ambiguous (two+ same-name candidates, none of them at the
 * convention slot) surfaces as an orphan+missing PAIR: the row stays
 * `missing` with the candidate paths listed, the files stay unclaimed
 * and appear among the orphans — the user decides (v1: delete the
 * ledger entry or ignore the orphan; interactive adoption deferred).
 */
import { lexicalRelFromRoot, type WalkedFile } from '../../fs-walk.js';

/** The `library_files` ledger row as the reconcile core sees it. */
export interface LibraryLedgerRow {
  readonly id: number;
  /** Sanitized module segment as recorded at finalize. */
  readonly moduleId: string;
  /** Sanitized manga segment as recorded at finalize. */
  readonly manga: string;
  readonly fileName: string;
  /** Recorded absolute path (the §7.1 commit target). */
  readonly path: string;
  readonly bytes: number;
  /** Epoch ms when the row was recorded (finalize time). */
  readonly createdAt: number;
  /** Epoch ms of the last stat-verified truth (null = never). */
  readonly verifiedAt: number | null;
  /** Cached verdict of the last verification (null = never verified). */
  readonly state: 'downloaded' | 'missing' | null;
  /** Disk mtime at the last verification (null = unknown/missing). */
  readonly mtimeMs: number | null;
  /** Download-lane provenance (null on legacy rows). */
  readonly mangaUrl: string | null;
  readonly chapterLink: string | null;
}

export interface ReconcileRelink {
  readonly id: number;
  /** Display form (root-relative) of the former recorded path. */
  readonly fromPath: string;
  /** Display form of the new path. */
  readonly toPath: string;
  /** Absolute joined path the row re-points at (persist target). */
  readonly toAbsPath: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface ReconcileMissing {
  readonly id: number;
  readonly moduleId: string;
  readonly manga: string;
  readonly fileName: string;
  /** Former recorded path, display form (undefined = outside root). */
  readonly path?: string;
  /** Ambiguity signal: unclaimed same-name candidates (display form). */
  readonly candidates: readonly string[];
}

export interface ReconcilePresent {
  readonly id: number;
  readonly relPath: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface ReconcileResult {
  readonly present: readonly ReconcilePresent[];
  readonly relinked: readonly ReconcileRelink[];
  readonly missing: readonly ReconcileMissing[];
  readonly orphans: readonly WalkedFile[];
  /** Rows whose recorded path resolves outside the root (clamped out
   * of the disk reconcile by the guardrail; counted, never listed). */
  readonly outsideRoot: number;
}

export interface ReconcileInput {
  readonly root: string;
  readonly rows: readonly LibraryLedgerRow[];
  readonly disk: readonly WalkedFile[];
}

function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** Pure ledger↔disk reconcile (see module doc for the match rules). */
export function reconcileLibrary(input: ReconcileInput): ReconcileResult {
  const { root, rows, disk } = input;
  const diskByRel = new Map<string, WalkedFile>(disk.map((file): [string, WalkedFile] => [file.relPath, file]));
  // Claimed = rel paths bound to a ledger row (present or re-linked) —
  // candidates draw ONLY from unclaimed files.
  const claimed = new Set<string>();

  const present: ReconcilePresent[] = [];
  const relinked: ReconcileRelink[] = [];
  const missingRows: Array<{ row: LibraryLedgerRow; display: string | undefined; candidates: readonly string[] }> = [];
  let outsideRoot = 0;

  // Pass 1 — presence at the recorded path (lexical rel against the
  // walk's rel space; recorded paths are finalize-committed children).
  const pending: LibraryLedgerRow[] = [];
  for (const row of rows) {
    const rel = lexicalRelFromRoot(root, row.path);
    if (rel === undefined) {
      outsideRoot += 1;
      continue;
    }
    const onDisk = diskByRel.get(rel);
    if (onDisk !== undefined) {
      claimed.add(rel);
      present.push({ id: row.id, relPath: rel, bytes: onDisk.bytes, mtimeMs: onDisk.mtimeMs });
    } else {
      pending.push(row);
    }
  }

  // Pass 2 — confident re-links for the rows whose file is not at its
  // recorded path (deterministic: ascending id).
  const byId = [...pending].sort((a, b): number => a.id - b.id);
  for (const row of byId) {
    // Rule 1 — CONVENTION: <manga>/<fileName> — the recorded manga
    // segment IS the effective folder (clean, or the module-suffixed
    // duplicate form); the module is not a path segment.
    const conventionRel = `${row.manga}/${row.fileName}`;
    const convention = diskByRel.get(conventionRel);
    if (convention !== undefined && !claimed.has(conventionRel)) {
      claimed.add(conventionRel);
      relinked.push({
        id: row.id,
        fromPath: lexicalRelFromRoot(root, row.path) ?? row.path,
        toPath: conventionRel,
        toAbsPath: convention.absPath,
        bytes: convention.bytes,
        mtimeMs: convention.mtimeMs,
      });
      continue;
    }
    // Rule 2 — EXACT FILENAME, unique unclaimed candidate.
    const name = baseName(row.fileName);
    const candidates = disk.filter(
      (file): boolean => !claimed.has(file.relPath) && baseName(file.relPath) === name,
    );
    if (candidates.length === 1) {
      const only = candidates[0] as WalkedFile;
      claimed.add(only.relPath);
      relinked.push({
        id: row.id,
        fromPath: lexicalRelFromRoot(root, row.path) ?? row.path,
        toPath: only.relPath,
        toAbsPath: only.absPath,
        bytes: only.bytes,
        mtimeMs: only.mtimeMs,
      });
      continue;
    }
    // Ambiguous (2+) or none: the row stays missing; same-name files
    // stay unclaimed → they surface as orphans (the PAIR).
    missingRows.push({
      row,
      display: lexicalRelFromRoot(root, row.path),
      candidates: candidates.map((file): string => file.relPath),
    });
  }

  // Pass 3 — orphans: every walked file no ledger row claims.
  const orphans = disk.filter((file): boolean => !claimed.has(file.relPath));

  return {
    present,
    relinked,
    missing: missingRows.map(({ row, display, candidates }): ReconcileMissing => ({
      id: row.id,
      moduleId: row.moduleId,
      manga: row.manga,
      fileName: row.fileName,
      ...(display !== undefined ? { path: display } : {}),
      candidates,
    })),
    orphans,
    outsideRoot,
  };
}
