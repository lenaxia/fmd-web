import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LibraryFinalizer,
  finalizeLeftovers,
  type FinalizeFaultPoint,
  type FinalizeRequest,
} from '../../../src/jobs/library/finalize.js';
import { mkTmpDir, rmDir } from '../helpers.js';

/**
 * Atomicity drill (DESIGN §7.1 step 5, §13.4 chaos): a fault-injected
 * crash at EVERY finalize boundary must never leave a partial file at
 * the library path — the target is absent-or-complete (temp-dir + rename
 * at every boundary; `.tmp-` litter is sweepable, never referenced).
 */

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const FAULT_POINTS: readonly FinalizeFaultPoint[] = [
  'begin',
  'before-stage',
  'after-stage',
  'before-relocate',
  'after-relocate',
  'before-commit',
];

function request(
  sourcePath: string,
  fileName = 'Chapter 5',
  ext = 'cbz',
  maxLength?: number,
): FinalizeRequest {
  return {
    moduleId: MODULE,
    manga: 'My/Manga: Title?',
    fileName,
    ext,
    sourcePath,
    ...(maxLength !== undefined ? { maxLength } : {}),
  };
}

function makeSource(dir: string, bytes: Uint8Array): string {
  const file = path.join(dir, 'packed-artifact.bin');
  fs.writeFileSync(file, bytes);
  return file;
}

let dir = '';

afterEach(() => {
  if (dir !== '') rmDir(dir);
  dir = '';
});

describe('LibraryFinalizer — happy path', () => {
  it('commits the artifact at library/<module>/<manga>/<name>.<ext> with sanitized components', () => {
    dir = mkTmpDir('lib-finalize-ok');
    const root = path.join(dir, 'library');
    const source = makeSource(dir, new Uint8Array([1, 2, 3, 4, 5]));
    const finalizer = new LibraryFinalizer({ libraryRoot: root });
    const result = finalizer.finalize(request(source));
    const expectedPath = path.join(
      root,
      MODULE,
      'MyManga Title',
      'Chapter 5.cbz',
    );
    expect(result.path).toBe(expectedPath);
    expect(result.bytes).toBe(5);
    expect(result.replaced).toBe(false);
    expect(fs.readFileSync(expectedPath)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    // no litter anywhere (the per-target stage dir is removed on success)
    expect(finalizeLeftovers(path.join(root, MODULE, 'MyManga Title'))).toEqual([]);
  });

  it('replacing an entry swaps the file atomically (replaced=true, new bytes)', () => {
    dir = mkTmpDir('lib-finalize-replace');
    const root = path.join(dir, 'library');
    const finalizer = new LibraryFinalizer({ libraryRoot: root });
    const first = finalizer.finalize(request(makeSource(dir, new Uint8Array([1]))));
    const second = finalizer.finalize(request(makeSource(dir, new Uint8Array([9, 9, 9])), 'Chapter 5'));
    expect(second.path).toBe(first.path);
    expect(second.replaced).toBe(true);
    expect(fs.readFileSync(first.path)).toEqual(Buffer.from([9, 9, 9]));
  });

  it('rejects unknown extensions and unsanitizable components', () => {
    dir = mkTmpDir('lib-finalize-guard');
    const finalizer = new LibraryFinalizer({ libraryRoot: path.join(dir, 'library') });
    const source = makeSource(dir, new Uint8Array([1]));
    expect(() => finalizer.finalize(request(source, 'X', 'rar'))).toThrow(/unknown chapter format/);
    expect(() => finalizer.finalize(request(source, '???*|'))).toThrow(/empty after sanitization/);
    expect(() =>
      finalizer.finalize({ ...request(source), moduleId: '???' }),
    ).toThrow(/moduleId/);
  });

  it('tail-truncates the final name when over maxLength (D5)', () => {
    dir = mkTmpDir('lib-finalize-trunc');
    const root = path.join(dir, 'library');
    const finalizer = new LibraryFinalizer({ libraryRoot: root });
    const result = finalizer.finalize(
      request(makeSource(dir, new Uint8Array([1])), 'an-extraordinarily-long-name', 'cbz', 25),
    );
    expect(path.basename(result.path)).toBe('extraordinarily-long-name.cbz');
  });
});

describe('LibraryFinalizer — fault-injected crash drill (absent-or-complete invariant)', () => {
  for (const point of FAULT_POINTS) {
    it(`crash at ${point} leaves the target absent, never partial`, () => {
      dir = mkTmpDir(`lib-finalize-crash-${point}`);
      const root = path.join(dir, 'library');
      const source = makeSource(dir, new Uint8Array([1, 2, 3]));
      const finalizer = new LibraryFinalizer({
        libraryRoot: root,
        token: () => 'fixed-token',
        crash: (hit) => {
          if (hit === point) {
            throw new Error(`simulated crash at ${point}`);
          }
        },
      });
      const target = finalizer.targetPath(request(source)).path;
      expect(() => finalizer.finalize(request(source))).toThrow(`simulated crash at ${point}`);
      // the invariant: no partial file at the library path
      expect(fs.existsSync(target)).toBe(false);
      // any pre-commit litter is sweepable
      finalizer.sweepLeftovers(path.dirname(target));
      expect(finalizeLeftovers(path.dirname(target))).toEqual([]);
    });
  }

  it('crash at before-commit during a REPLACE keeps the OLD complete file', () => {
    dir = mkTmpDir('lib-finalize-crash-replace');
    const root = path.join(dir, 'library');
    const finalizer = new LibraryFinalizer({ libraryRoot: root });
    const first = finalizer.finalize(request(makeSource(dir, new Uint8Array([1, 1]))));

    const crasher = new LibraryFinalizer({
      libraryRoot: root,
      crash: (hit) => {
        if (hit === 'before-commit') {
          throw new Error('simulated crash mid-replace');
        }
      },
    });
    const target = first.path;
    expect(() =>
      crasher.finalize(request(makeSource(dir, new Uint8Array([7, 7, 7])), 'Chapter 5')),
    ).toThrow('simulated crash mid-replace');
    // old entry still complete and intact
    expect(fs.readFileSync(target)).toEqual(Buffer.from([1, 1]));
    // the staged new bytes sit sweepable, not at the target
    const targetDir = path.dirname(target);
    const litter = finalizeLeftovers(targetDir);
    expect(litter.length).toBe(1);
    expect(fs.readFileSync(path.join(targetDir, litter[0] ?? ''))).toEqual(Buffer.from([7, 7, 7]));
    crasher.sweepLeftovers(targetDir);
    expect(finalizeLeftovers(targetDir)).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(Buffer.from([1, 1]));
  });

  it('a crash after staging leaves only sweepable stage litter in the target dir', () => {
    dir = mkTmpDir('lib-finalize-crash-stage');
    const root = path.join(dir, 'library');
    const finalizer = new LibraryFinalizer({
      libraryRoot: root,
      crash: (hit) => {
        if (hit === 'after-stage') {
          throw new Error('boom');
        }
      },
    });
    const target = finalizer.targetPath(request(makeSource(dir, new Uint8Array([1])))).path;
    expect(() =>
      finalizer.finalize(request(makeSource(dir, new Uint8Array([1])))),
    ).toThrow('boom');
    // the target dir exists but holds only the stage litter — never the
    // final name, never partial bytes under it
    expect(fs.existsSync(target)).toBe(false);
    const targetDir = path.dirname(target);
    expect(finalizeLeftovers(targetDir).length).toBe(1);
    finalizer.sweepLeftovers(targetDir);
    expect(finalizeLeftovers(targetDir)).toEqual([]);
  });
});
