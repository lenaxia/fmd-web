/**
 * [file-state] Shared walker seam + reconcile core unit tests:
 * dotfile skipping, symlink-escape rejection (the realpath clamp),
 * moved-within-root re-linking (exact-filename rule + naming
 * convention rule), the ambiguity orphan+missing pair, missing/orphan
 * classification, out-of-root rows, and the rescan diff-report shape.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  displayFromRoot,
  isUnderRoot,
  lexicalRelFromRoot,
  rootAnchor,
  walkTree,
} from '../../../src/fs-walk.js';
import { reconcileLibrary, type LibraryLedgerRow } from '../../../src/jobs/library/reconcile.js';

let rootDir = '';

afterEach(() => {
  if (rootDir !== '') rmSync(rootDir, { recursive: true, force: true });
  rootDir = '';
});

function makeRoot(): string {
  rootDir = join(tmpdir(), `fmd-filestate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

function put(root: string, rel: string, bytes = 8): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, 7));
}

function row(overrides: Partial<LibraryLedgerRow> & { id: number; path: string }): LibraryLedgerRow {
  return {
    moduleId: 'modulea',
    manga: 'mangam',
    fileName: 'ch-001.cbz',
    bytes: 8,
    createdAt: 1_700_000_000_000,
    verifiedAt: null,
    state: null,
    mtimeMs: null,
    mangaUrl: 'https://ex.org/manga/x',
    chapterLink: 'https://ex.org/manga/x/1',
    ...overrides,
  };
}

// ── walker seam ────────────────────────────────────────────────────────

describe('walkTree (shared seam)', (): void => {
  it('skips dotfiles when asked (prunes .tmp- litter) and keeps them otherwise', (): void => {
    const root = makeRoot();
    put(root, 'a/b/ch.cbz');
    put(root, 'a/.hidden');
    put(root, 'a/b/.tmp-123-stage/artifact.cbz');
    const skipped = walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }).map((f) => f.relPath);
    expect(skipped).toEqual(['a/b/ch.cbz']);
    const kept = walkTree(root).map((f) => f.relPath);
    expect(kept).toContain('a/.hidden');
    expect(kept).toContain('a/b/.tmp-123-stage/artifact.cbz');
  });

  it('rejects symlink escapes (skipped, never listed) and admits in-root symlinked files', (): void => {
    const root = makeRoot();
    const outside = join(rootDir, '..');
    put(root, 'in/real.cbz', 5);
    mkdirSync(join(root, 'links'));
    symlinkSync(join(root, 'in', 'real.cbz'), join(root, 'links', 'inside.cbz'));
    symlinkSync(join(outside, 'fmd-walk-outside-target.bin'), join(root, 'links', 'escape.cbz'));
    const rels = walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }).map((f) => f.relPath);
    expect(rels).toContain('in/real.cbz');
    expect(rels).toContain('links/inside.cbz');
    expect(rels).not.toContain('links/escape.cbz');
  });
});

// ── realpath clamp helpers ─────────────────────────────────────────────

describe('realpath clamp', (): void => {
  it('isUnderRoot: inside true, outside false, missing false', (): void => {
    const root = makeRoot();
    put(root, 'a/ch.cbz');
    const anchor = rootAnchor(root);
    expect(isUnderRoot(anchor, join(root, 'a', 'ch.cbz'))).toBe(true);
    expect(isUnderRoot(anchor, join(root, '..', 'elsewhere.cbz'))).toBe(false);
    expect(isUnderRoot(anchor, join(root, 'a', 'gone.cbz'))).toBe(false);
  });

  it('lexicalRelFromRoot + displayFromRoot: root-relative display, undefined outside', (): void => {
    const root = makeRoot();
    put(root, 'a/ch.cbz');
    const anchor = rootAnchor(root);
    expect(lexicalRelFromRoot(root, join(root, 'a', 'ch.cbz'))).toBe('a/ch.cbz');
    expect(lexicalRelFromRoot(root, join(root, '..', 'outside.cbz'))).toBeUndefined();
    // Missing path: display still resolves lexically (former path).
    expect(displayFromRoot(anchor, root, join(root, 'a', 'deleted.cbz'))).toBe('a/deleted.cbz');
    expect(displayFromRoot(anchor, root, join(root, '..', 'x.cbz'))).toBeUndefined();
  });
});

// ── reconcile core ─────────────────────────────────────────────────────

describe('reconcileLibrary', (): void => {
  it('present at recorded path; deleted file stays missing; unclaimed disk file is an orphan', (): void => {
    const root = makeRoot();
    put(root, 'mangam/ch-001.cbz');
    put(root, 'stray/orphan-001.cbz', 33);
    const result = reconcileLibrary({
      root,
      rows: [
        row({ id: 1, path: join(root, 'mangam/ch-001.cbz') }),
        row({ id: 2, path: join(root, 'mangam/ch-002.cbz'), fileName: 'ch-002.cbz' }),
      ],
      disk: walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }),
    });
    expect(result.present.map((p) => p.id)).toEqual([1]);
    expect(result.relinked).toEqual([]);
    expect(result.missing.map((m) => m.id)).toEqual([2]);
    expect(result.missing[0]?.path).toBe('mangam/ch-002.cbz');
    expect(result.missing[0]?.candidates).toEqual([]);
    expect(result.orphans.map((o) => o.relPath)).toEqual(['stray/orphan-001.cbz']);
    expect(result.orphans[0]?.bytes).toBe(33);
    expect(result.outsideRoot).toBe(0);
  });

  it('moved within root, exact filename at a different directory → re-link (former path kept)', (): void => {
    const root = makeRoot();
    // The file MOVED: recorded under mangam, lives under 'imported'.
    put(root, 'imported/mangam/ch-001.cbz', 12);
    const result = reconcileLibrary({
      root,
      rows: [row({ id: 7, path: join(root, 'mangam/ch-001.cbz') })],
      disk: walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }),
    });
    expect(result.present).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.orphans).toEqual([]);
    expect(result.relinked).toHaveLength(1);
    const relink = result.relinked[0];
    expect(relink?.id).toBe(7);
    expect(relink?.fromPath).toBe('mangam/ch-001.cbz');
    expect(relink?.toPath).toBe('imported/mangam/ch-001.cbz');
    expect(relink?.bytes).toBe(12);
  });

  it('moved back onto the naming-convention slot (saveTo row) → convention re-link wins', (): void => {
    const root = makeRoot();
    // Recorded with a saveTo override OUTSIDE the convention; the file
    // sits at the app's own output slot (`<manga>/<file>`, flat).
    put(root, 'mangam/ch-009.cbz', 40);
    // A same-name distractor elsewhere: with it, the exact-filename
    // rule alone would be AMBIGUOUS — only the CONVENTION rule can
    // produce a re-link (the test discriminates rule 1 from rule 2).
    put(root, 'elsewhere/ch-009.cbz', 6);
    const result = reconcileLibrary({
      root,
      rows: [
        row({
          id: 9,
          fileName: 'ch-009.cbz',
          path: join(root, 'custom-dir/ch-009.cbz'),
        }),
      ],
      disk: walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }),
    });
    expect(result.relinked).toHaveLength(1);
    expect(result.relinked[0]?.toPath).toBe('mangam/ch-009.cbz');
    expect(result.relinked[0]?.fromPath).toBe('custom-dir/ch-009.cbz');
    // The distractor stays unclaimed → orphan (not swallowed by the
    // re-link, not an ambiguity blocker).
    expect(result.orphans.map((o) => o.relPath)).toEqual(['elsewhere/ch-009.cbz']);
    expect(result.missing).toEqual([]);
  });

  it('[library-layout] the convention slot is the flat effective folder — suffixed duplicate rows re-link onto the suffixed slot', (): void => {
    const root = makeRoot();
    // A duplicate-collision row records the SUFFIXED folder as its
    // manga segment (`mangam [moduleb]`); the module is not a path
    // segment anywhere.
    put(root, 'mangam [moduleb]/ch-010.cbz', 21);
    // Same-name distractor: exact-filename alone would be AMBIGUOUS —
    // only the flat CONVENTION slot (`<row.manga>/<file>`) re-links.
    // Under the old 3-segment `<module>/<manga>/<file>` convention
    // this row would stay missing with BOTH files orphaned.
    put(root, 'imported/stray/ch-010.cbz', 5);
    const result = reconcileLibrary({
      root,
      rows: [
        row({
          id: 10,
          moduleId: 'moduleb',
          manga: 'mangam [moduleb]',
          fileName: 'ch-010.cbz',
          path: join(root, 'imported/moduleb/ch-010.cbz'),
        }),
      ],
      disk: walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }),
    });
    expect(result.relinked).toHaveLength(1);
    expect(result.relinked[0]?.toPath).toBe('mangam [moduleb]/ch-010.cbz');
    expect(result.relinked[0]?.fromPath).toBe('imported/moduleb/ch-010.cbz');
    expect(result.missing).toEqual([]);
    expect(result.orphans.map((o) => o.relPath)).toEqual(['imported/stray/ch-010.cbz']);
  });

  it('ambiguous same-name candidates → orphan+missing PAIR, never auto-linked', (): void => {
    const root = makeRoot();
    put(root, 'one/ch-001.cbz', 3);
    put(root, 'two/ch-001.cbz', 5);
    const result = reconcileLibrary({
      root,
      rows: [row({ id: 3, path: join(root, 'mangam/ch-001.cbz') })],
      disk: walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }),
    });
    expect(result.relinked).toEqual([]);
    expect(result.missing).toHaveLength(1);
    const missing = result.missing[0];
    expect(missing?.id).toBe(3);
    expect(missing?.candidates).toEqual(['one/ch-001.cbz', 'two/ch-001.cbz']);
    // The pair: both candidates stay unclaimed → orphans.
    expect(result.orphans.map((o) => o.relPath).sort()).toEqual(['one/ch-001.cbz', 'two/ch-001.cbz']);
  });

  it('a claimed file is never an orphan or a second candidate (present row claims its path)', (): void => {
    const root = makeRoot();
    put(root, 'mangam/ch-001.cbz');
    put(root, 'copy/ch-001.cbz', 9);
    const result = reconcileLibrary({
      root,
      rows: [
        row({ id: 1, path: join(root, 'mangam/ch-001.cbz') }),
        row({ id: 2, path: join(root, 'gone/ch-001.cbz'), fileName: 'ch-001.cbz' }),
      ],
      disk: walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }),
    });
    // Row 1 present claims its path; row 2's unique remaining candidate
    // is copy/ch-001.cbz → confident re-link.
    expect(result.present.map((p) => p.id)).toEqual([1]);
    expect(result.relinked.map((r) => r.id)).toEqual([2]);
    expect(result.relinked[0]?.toPath).toBe('copy/ch-001.cbz');
    expect(result.orphans).toEqual([]);
  });

  it('rows recorded outside the root are counted, never listed or reconciled', (): void => {
    // A parent dir holds BOTH the root and the outside saveTo target —
    // the recorded path is a sibling, not a child.
    const parent = join(tmpdir(), `fmd-filestate-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(parent, { recursive: true });
    const root = join(parent, 'library');
    mkdirSync(root, { recursive: true });
    const outsideDir = join(parent, 'outside-save');
    mkdirSync(outsideDir, { recursive: true });
    try {
      put(root, 'mangam/ch-001.cbz');
      const outside = join(outsideDir, 'ch-777.cbz');
      writeFileSync(outside, Buffer.alloc(4, 1));
      const result = reconcileLibrary({
        root,
        rows: [
          row({ id: 1, path: join(root, 'mangam/ch-001.cbz') }),
          row({ id: 77, path: outside, fileName: 'ch-777.cbz' }),
        ],
        disk: walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }),
      });
      expect(result.outsideRoot).toBe(1);
      expect(result.missing.map((m) => m.id)).not.toContain(77);
      expect(result.orphans.map((o) => o.relPath)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('dotfiles on disk are invisible to the reconcile (never orphans, never candidates)', (): void => {
    const root = makeRoot();
    put(root, 'mangam/.tmp-1-ch-001.cbz');
    put(root, '.DS_Store');
    const result = reconcileLibrary({
      root,
      rows: [row({ id: 1, path: join(root, 'mangam/ch-001.cbz') })],
      disk: walkTree(root, { skipDotfiles: true, followSymlinkedFiles: true }),
    });
    expect(result.orphans).toEqual([]);
    expect(result.missing[0]?.candidates).toEqual([]);
  });
});
