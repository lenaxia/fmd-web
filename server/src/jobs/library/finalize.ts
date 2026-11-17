/**
 * Chapter finalize — the atomic move into
 * `library/<module>/<manga>/<chapter>.<ext>` (DESIGN §7.1 step 5, §4
 * "finish atomic renames"). Temp-dir + rename at EVERY boundary so a
 * crash can never expose a partial file at the library path:
 *
 *   1. STAGE    — copy the packed artifact from the job temp dir into a
 *                 per-target stage dir INSIDE the final directory
 *                 (`<targetDir>/.tmp-<token>-stage/`): the stage lives
 *                 on the same filesystem as the commit rename (always
 *                 atomic), the copy absorbs any cross-device job-temp
 *                 difference, and concurrent finalizes of different
 *                 chapters never share litter. The staged file is
 *                 fsynced so the bytes are durable before any rename.
 *   2. RELOCATE — rename the staged file next to its final home under a
 *                 `.tmp-` name (atomic, same fs); the stage dir is
 *                 removed.
 *   3. COMMIT   — rename `.tmp-…` → the final name: the library path
 *                 only ever APPEARS fully-formed (rename is atomic), a
 *                 crash before it leaves only sweepable `.tmp-` litter,
 *                 never a partial file at the target. The directory is
 *                 fsynced best-effort after the commit.
 *
 * Re-finalizing the same chapter replaces the entry the same way (the
 * commit rename swaps the target atomically). `crash` is a fault
 * injection hook (chaos drill, §13.4): throwing from it at any named
 * point simulates dying mid-finalize; `sweepLeftovers` is the recovery
 * path that removes `.tmp-` litter (files or stage dirs) left behind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeChapterExtension, sanitizeFileName, truncateKeepTail } from './filenames.js';

/** Named fault-injection points (§13.4 chaos drill). */
export type FinalizeFaultPoint =
  | 'begin'
  | 'before-stage'
  | 'after-stage'
  | 'before-relocate'
  | 'after-relocate'
  | 'before-commit';

export interface FinalizeRequest {
  /** Library component 1 — sanitized (`library/<module>/…`). */
  readonly moduleId: string;
  /** Library component 2 — sanitized (`…/<manga>/…`). */
  readonly manga: string;
  /** Resolved chapter base name (resolution order §7.1). */
  readonly fileName: string;
  /** Packer output format: zip | cbz | pdf | epub. */
  readonly ext: string;
  /** The packed artifact produced by the pack stage (§7.3). */
  readonly sourcePath: string;
  /** CurrentMaxFileNameLength for the final name (0 = no limit, D5). */
  readonly maxLength?: number;
  /**
   * FMD2 edSaveTo parity (frmMain.pas:5613): custom save directory —
   * when present it REPLACES the `<libraryRoot>/<module>/<manga>`
   * prefix entirely. Relative paths resolve against the library root;
   * the file name keeps §7.1 sanitization either way.
   */
  readonly saveTo?: string;
}

export interface FinalizeResult {
  /** The committed library path (complete or absent — never partial). */
  readonly path: string;
  readonly bytes: number;
  /** true when an existing entry was replaced. */
  readonly replaced: boolean;
}

export interface FinalizerOptions {
  readonly libraryRoot: string;
  /** Deterministic randomness for tests (default crypto.randomBytes). */
  readonly token?: () => string;
  /** Fault injection (chaos drill); throw to simulate a crash. */
  readonly crash?: (point: FinalizeFaultPoint) => void;
  /** fsync staged bytes before the renames (default true). */
  readonly durable?: boolean;
}

function safeComponent(component: string, what: string): string {
  const sanitized = sanitizeFileName(component);
  if (sanitized === '') {
    throw new Error(`library path component ${what} is empty after sanitization`);
  }
  return truncateKeepTail(sanitized, 255);
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Best-effort directory fsync (power-loss hygiene; no-op when unsupported). */
function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // directories are not fsync-able everywhere — best effort only
  }
}

/** Leftover `.tmp-` entries in a finalize target dir (drain before verify). */
export function finalizeLeftovers(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith('.tmp-'));
  } catch {
    return [];
  }
}

export class LibraryFinalizer {
  private readonly token: () => string;

  public constructor(private readonly options: FinalizerOptions) {
    this.token = options.token ?? (() => randomBytes(8).toString('hex'));
  }

  /** The final library path for a request (components sanitized). */
  public targetPath(request: FinalizeRequest): { dir: string; file: string; path: string } {
    const baseName = sanitizeFileName(request.fileName);
    if (baseName === '') {
      throw new Error('chapter fileName is empty after sanitization');
    }
    const ext = normalizeChapterExtension(request.ext);
    const name = truncateKeepTail(baseName, request.maxLength ?? 0);
    // edSaveTo parity: a custom save directory replaces the module/manga
    // prefix (relative values resolve against the library root).
    const dir =
      request.saveTo !== undefined
        ? path.resolve(this.options.libraryRoot, request.saveTo)
        : path.join(
            this.options.libraryRoot,
            safeComponent(request.moduleId, 'moduleId'),
            safeComponent(request.manga, 'manga'),
          );
    const file = `${name}.${ext}`;
    return { dir, file, path: path.join(dir, file) };
  }

  /**
   * Atomic finalize: stage → relocate → commit. On any throw the
   * target path is unchanged (absent-or-complete invariant).
   */
  public finalize(request: FinalizeRequest): FinalizeResult {
    this.options.crash?.('begin');
    const target = this.targetPath(request);
    const replaced = fs.existsSync(target.path);
    const ext = normalizeChapterExtension(request.ext);
    const token = `${process.pid}-${this.token()}`;

    // 1. STAGE — copy into a per-target stage dir (same fs as the
    //    commit rename), then fsync the bytes (§4 "flush … finish
    //    atomic renames").
    fs.mkdirSync(target.dir, { recursive: true });
    const stageDir = path.join(target.dir, `.tmp-${token}-stage`);
    fs.mkdirSync(stageDir, { recursive: true });
    this.options.crash?.('before-stage');
    const stagedPath = path.join(stageDir, `artifact.${ext}`);
    fs.copyFileSync(request.sourcePath, stagedPath);
    if (this.options.durable !== false) {
      fsyncFile(stagedPath);
    }
    this.options.crash?.('after-stage');

    // 2. RELOCATE — atomic rename into the final dir under a `.tmp-`
    //    name (never the target name); drop the empty stage dir.
    this.options.crash?.('before-relocate');
    const pendingPath = path.join(target.dir, `.tmp-${token}-${target.file}`);
    fs.renameSync(stagedPath, pendingPath);
    this.options.crash?.('after-relocate');
    fs.rmdirSync(stageDir);

    // 3. COMMIT — the atomic appearance/swap of the library entry.
    this.options.crash?.('before-commit');
    fs.renameSync(pendingPath, target.path);
    fsyncDir(target.dir);

    return { path: target.path, bytes: fs.statSync(target.path).size, replaced };
  }

  /**
   * Recovery sweep: remove `.tmp-` litter (files or stage dirs) from a
   * finalize target dir (crash leftovers are never referenced — the
   * commit rename is the only writer of the final name).
   */
  public sweepLeftovers(dir: string): number {
    let removed = 0;
    for (const name of finalizeLeftovers(dir)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}
