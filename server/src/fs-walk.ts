/**
 * Shared filesystem tree-walk seam (library file-state story): ONE
 * recursive `withFileTypes` walker serving every server-side disk
 * walk — the engine's staged-validation inventory (its historical
 * private `walk()`, now delegating here with the exact same
 * traversal) and the library-root rescan/verify walks. Reuse, not a
 * fork: the two consumers differ ONLY in options.
 *
 * Placement: a NEUTRAL top-level module by necessity — the engine
 * boundary gate points engine dependencies strictly inward (engine
 * may not import app layers such as jobs/), while app layers may not
 * deep-import engine submodules; both MAY import this leaf (node
 * builtins only, zero domain imports).
 *
 * Guardrails baked into the options the library consumer sets
 * (owner-approved design):
 *   - dotfiles skipped (`skipDotfiles` — also prunes the finalizer's
 *     `.tmp-` stage litter);
 *   - symlinked FILES admitted only when their realpath stays under
 *     the walk root (`followSymlinkedFiles` + the {@link isUnderRoot}
 *     clamp) — a symlink escaping the root is rejected (skipped),
 *     never listed;
 *   - symlinked DIRECTORIES are never followed (a conservative walk;
 *     the recorded-path clamp covers the rest).
 */
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { posix } from 'node:path';

/** One walked file: root-relative posix display path + stat metadata. */
export interface WalkedFile {
  /** Posix path relative to the walk root (display form). */
  readonly relPath: string;
  /** Joined absolute path (NOT realpath — display/ref join only). */
  readonly absPath: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface WalkTreeOptions {
  /** Skip entries whose name starts with '.' (default false — the
   * staged-validation inventory keeps its historical behavior). */
  readonly skipDotfiles?: boolean;
  /** Admit symlinked files whose realpath resolves under the root
   * (default false — plain `isFile()` dirents only). Symlinks whose
   * realpath escapes the root are ALWAYS skipped. */
  readonly followSymlinkedFiles?: boolean;
}

interface WalkInternalOptions extends Required<WalkTreeOptions> {
  readonly rootReal: string;
}

/**
 * Recursive tree walk (readdir order, depth-first, directories
 * recursed in place — byte-for-byte the staged-validation traversal
 * when both options are false).
 */
export function walkTree(root: string, opts?: WalkTreeOptions): readonly WalkedFile[] {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return []; // unresolvable root (never created / dangling symlink) — nothing to walk
  }
  const internal: WalkInternalOptions = {
    skipDotfiles: opts?.skipDotfiles ?? false,
    followSymlinkedFiles: opts?.followSymlinkedFiles ?? false,
    rootReal,
  };
  return walkDir(root, '', internal);
}

function walkDir(root: string, prefix: string, opts: WalkInternalOptions): WalkedFile[] {
  const files: WalkedFile[] = [];
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return files; // unreadable subtree — skipped, never fatal
  }
  for (const entry of entries) {
    if (opts.skipDotfiles && entry.name.startsWith('.')) {
      continue;
    }
    const rel = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(root, rel, opts));
      continue;
    }
    if (entry.isFile()) {
      // Plain file: a plain stat yields size/mtime; a failure degrades
      // to zeros rather than killing the walk (the entry existed at
      // readdir time — a concurrent delete is not our problem).
      try {
        const abs = join(root, rel);
        const st = statSync(abs);
        files.push({ relPath: posix.normalize(rel), absPath: abs, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        files.push({ relPath: posix.normalize(rel), absPath: join(root, rel), bytes: 0, mtimeMs: 0 });
      }
      continue;
    }
    if (entry.isSymbolicLink() && opts.followSymlinkedFiles) {
      // Symlinked file: admit ONLY when its realpath stays under the
      // walk root (realpath comparison — an escaping symlink is a
      // reject/skip, never a listed path). Anything else (dangling,
      // directory target, socket/pipe) is skipped.
      const abs = join(root, rel);
      try {
        const st = statSync(abs); // follows the link
        if (st.isFile() && isUnderRoot(opts.rootReal, abs)) {
          files.push({ relPath: posix.normalize(rel), absPath: abs, bytes: st.size, mtimeMs: st.mtimeMs });
        }
      } catch {
        // dangling or unreachable — skipped
      }
    }
  }
  return files;
}

/**
 * realpath clamp: `candidate` resolves (symlinks followed) to a path
 * strictly under `rootReal` (the root's OWN realpath — precompute
 * once per operation via {@link rootAnchor}). Missing/unresolvable
 * paths resolve false.
 */
export function isUnderRoot(rootReal: string, candidate: string): boolean {
  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    return false;
  }
  return isRelUnder(real, rootReal);
}

/** The root's realpath anchor for {@link isUnderRoot} comparisons. */
export function rootAnchor(root: string): string {
  return realpathSync(root);
}

/**
 * Lexical (no-realpath) root-relative form of an absolute path — the
 * recorded-path → display mapping for files that may be MISSING (a
 * realpath of a deleted path throws). Escaping paths ('..' segments)
 * resolve undefined: out-of-root recorded paths are never displayed.
 */
export function lexicalRelFromRoot(root: string, absPath: string): string | undefined {
  const rel = relative(resolve(root), resolve(absPath));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sepOf(rel)}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel.split('\\').join('/');
}

function sepOf(rel: string): string {
  return rel.includes('\\') ? '\\' : '/';
}

/**
 * Display form for absolute paths that may not exist: realpath clamp
 * when the file exists (symlink-escape proof), the lexical form
 * otherwise. Always undefined for out-of-root paths.
 */
export function displayFromRoot(rootReal: string, root: string, absPath: string): string | undefined {
  try {
    const real = realpathSync(resolve(absPath));
    if (!isRelUnder(real, rootReal)) {
      return undefined;
    }
    return lexicalRelFromRoot(root, absPath);
  } catch {
    return lexicalRelFromRoot(root, absPath);
  }
}

function isRelUnder(real: string, rootReal: string): boolean {
  const rel = relative(rootReal, real);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sepOf(rel)}`) && !isAbsolute(rel);
}
