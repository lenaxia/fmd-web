/**
 * edSaveTo parity (FMD2 frmMain.pas:5613): a custom save directory
 * REPLACES the `<libraryRoot>/<module>/<manga>` prefix at finalize —
 * relative values resolve against the library root, absolute values
 * are used verbatim, and the file name keeps §7.1 sanitization.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryFinalizer, type FinalizeRequest } from '../../../src/jobs/library/finalize.js';
import { mkTmpDir, rmDir } from '../helpers.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';

describe('LibraryFinalizer — saveTo override (edSaveTo parity)', (): void => {
  let dir: string;
  let root: string;
  let finalizer: LibraryFinalizer;

  beforeEach(() => {
    dir = mkTmpDir('finalize-saveto');
    root = path.join(dir, 'library');
    finalizer = new LibraryFinalizer({ libraryRoot: root });
  });

  afterEach(() => {
    rmDir(dir);
  });

  function request(saveTo?: string): FinalizeRequest {
    return {
      moduleId: MODULE,
      manga: 'Fixture Manga',
      fileName: 'Chapter 1',
      ext: 'zip',
      sourcePath: '',
      ...(saveTo !== undefined ? { saveTo } : {}),
    };
  }

  it('default path stays library/<module>/<manga> (regression)', (): void => {
    const target = finalizer.targetPath(request());
    expect(target.dir).toBe(path.join(root, MODULE, 'Fixture Manga'));
  });

  it('a RELATIVE saveTo replaces the module/manga prefix, resolved against the library root', (): void => {
    const target = finalizer.targetPath(request('custom/dir'));
    expect(target.dir).toBe(path.resolve(root, 'custom/dir'));
    expect(target.dir).not.toContain(MODULE);
    expect(target.path).toBe(path.join(path.resolve(root, 'custom/dir'), 'Chapter 1.zip'));
  });

  it('an ABSOLUTE saveTo is used verbatim', (): void => {
    const absolute = path.join(dir, 'elsewhere');
    const target = finalizer.targetPath(request(absolute));
    expect(target.dir).toBe(absolute);
    expect(target.path.endsWith('Chapter 1.zip')).toBe(true);
  });

  it('finalize commits the artifact under the saveTo directory (atomic path unchanged)', (): void => {
    const source = path.join(dir, 'packed.zip');
    fs.writeFileSync(source, Buffer.from('artifact-bytes'));
    const target = finalizer.targetPath(request('custom/dir'));
    const result = finalizer.finalize({ ...request('custom/dir'), sourcePath: source });

    expect(result.path).toBe(target.path);
    expect(fs.existsSync(target.path)).toBe(true);
    expect(fs.readFileSync(target.path).toString()).toBe('artifact-bytes');
  });

  it('the file name keeps §7.1 sanitization inside a saveTo directory', (): void => {
    const target = finalizer.targetPath({ ...request('out'), fileName: 'Bad/Name: 2?' });
    expect(path.basename(target.path)).toBe('BadName 2.zip');
  });
});
