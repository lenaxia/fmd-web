import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  downloadedChaptersKey,
  hasChapter,
  linesToText,
  mergeCaseInsensitive,
} from '../../../src/jobs/library/merge.js';

/**
 * Dedupe parity golden tests (DESIGN §7.1/§9; DownloadedChaptersDB.pas:
 * 55, 70-79, 125-128): merged-list semantics must match FMD2's
 * `MergeCaseInsensitive` — sorted case-insensitive output, dupIgnore
 * (first-added case variant survives), duplicates and reorders
 * collapse — with the expected merged strings committed as fixtures.
 */
interface MergeCase {
  readonly name: string;
  readonly inputs: readonly string[];
  readonly expected: string;
}

interface MergeCasesFile {
  readonly $comment: string;
  readonly cases: readonly MergeCase[];
}

interface KeyCase {
  readonly name: string;
  readonly moduleId: string;
  readonly link: string;
  readonly expected: string;
}

interface KeyCasesFile {
  readonly $comment: string;
  readonly cases: readonly KeyCase[];
}

const FIXTURES = join(process.cwd(), 'server/test/jobs/library/fixtures');

function loadFixtures(file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as unknown;
}

describe('mergeCaseInsensitive — FMD2 MergeCaseInsensitive golden parity', () => {
  const doc = loadFixtures('merge-cases.json') as MergeCasesFile;

  for (const testCase of doc.cases) {
    it(testCase.name, () => {
      expect(mergeCaseInsensitive(...testCase.inputs)).toBe(testCase.expected);
    });
  }

  it('fixtures exist (committed expected merged strings)', () => {
    expect(doc.cases.length).toBeGreaterThanOrEqual(10);
  });
});

describe('MergeCaseInsensitive — additional semantic edges', () => {
  it('an empty candidate contributes nothing (SetChapters merge base)', () => {
    expect(mergeCaseInsensitive('', 'b\na\n')).toBe('a\nb\n');
  });

  it('the merge is idempotent', () => {
    const once = mergeCaseInsensitive('B\nA\n', 'a\nC\n');
    expect(mergeCaseInsensitive(once)).toBe(once);
    expect(once).toBe('A\nB\nC\n');
  });

  it('CRLF text from a Windows-shaped source merges identically', () => {
    // 'y' is the first-added variant of its key; 'Z' is the FIRST
    // occurrence of its key (nothing to dedupe against) — it survives
    expect(mergeCaseInsensitive('x\r\ny\r\n', 'Y\r\nZ\r\n')).toBe('x\ny\nZ\n');
  });
});

describe('linesToText / hasChapter — TStrings.Text + favorites-diff membership', () => {
  it('linesToText: LF-joined with trailing LF, empty list → ""', () => {
    expect(linesToText([])).toBe('');
    expect(linesToText(['a'])).toBe('a\n');
    expect(linesToText(['a', 'b'])).toBe('a\nb\n');
  });

  it('hasChapter is case-insensitive (DoCheck IndexOf, uFavoritesManager.pas:364-370)', () => {
    const stored = mergeCaseInsensitive('Chapter 1\nchapter 2\n');
    expect(hasChapter(stored, 'chapter 1')).toBe(true);
    expect(hasChapter(stored, 'CHAPTER 2')).toBe(true);
    expect(hasChapter(stored, 'chapter 3')).toBe(false);
  });

  it('hasChapter works on unsorted raw-inserted lists (new-row :78-79)', () => {
    expect(hasChapter('Z-last\nA-first\n', 'a-first')).toBe(true);
    expect(hasChapter('Z-last\nA-first\n', 'b')).toBe(false);
  });
});

describe('downloadedChaptersKey — LowerCase(ModuleID+Link) golden parity', () => {
  const doc = loadFixtures('key-cases.json') as KeyCasesFile;

  for (const testCase of doc.cases) {
    it(testCase.name, () => {
      expect(downloadedChaptersKey(testCase.moduleId, testCase.link)).toBe(testCase.expected);
    });
  }
});
