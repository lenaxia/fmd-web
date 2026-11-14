import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeChapterExtension,
  resolveChapterFileName,
  sanitizeFileName,
  truncateKeepTail,
  type ChapterFileNameParts,
} from '../../../src/jobs/library/filenames.js';

/**
 * Filename golden tests (DESIGN §7.1): resolution order (module
 * FileNames[] → SaveImage return → filename template → chapter name),
 * tail-keeping truncation over CurrentMaxFileNameLength (0 = unlimited,
 * D5) and the path-unsafe sanitization table (uBaseUnit.pas:59-60 set,
 * :1382-1394 — exactly the Symbols set, incl. tab #9 and ';', is
 * deleted; no general control sweep; FPC Trim per :2123) — all
 * table-driven from committed fixtures.
 */
interface StringTableCase {
  readonly input: string;
  readonly expected: string;
  readonly maxLength?: number;
}

interface ResolveCase {
  readonly name: string;
  readonly parts: Record<string, unknown>;
  readonly expected?: string;
  readonly throws?: boolean;
}

interface ExtensionCase {
  readonly input: string;
  readonly expected?: string;
  readonly throws?: boolean;
}

interface FilenameCasesFile {
  readonly $comment: string;
  readonly sanitize: readonly StringTableCase[];
  readonly truncate: readonly StringTableCase[];
  readonly resolve: readonly ResolveCase[];
  readonly extensions: readonly ExtensionCase[];
}

const doc = JSON.parse(
  readFileSync(
    join(process.cwd(), 'server/test/jobs/library/fixtures/filename-cases.json'),
    'utf8',
  ),
) as FilenameCasesFile;

describe('sanitizeFileName — RemoveSymbols table (set :59-60, loop :1382-1394)', () => {
  for (const testCase of doc.sanitize) {
    it(JSON.stringify(testCase.input), () => {
      expect(sanitizeFileName(testCase.input)).toBe(testCase.expected);
    });
  }

  it('is idempotent', () => {
    const once = sanitizeFileName('a/b:c"???');
    expect(sanitizeFileName(once)).toBe(once);
  });
});

describe('truncateKeepTail — tail survival, 0 = unlimited (D5, :543-550)', () => {
  for (const testCase of doc.truncate) {
    it(`${JSON.stringify(testCase.input)} @ max=${String(testCase.maxLength)}`, () => {
      expect(truncateKeepTail(testCase.input, testCase.maxLength ?? 0)).toBe(testCase.expected);
    });
  }
});

describe('resolveChapterFileName — §7.1 resolution order table', () => {
  for (const testCase of doc.resolve) {
    const parts = testCase.parts as ChapterFileNameParts;
    if (testCase.throws === true) {
      it(`${testCase.name} — throws`, () => {
        expect(() => resolveChapterFileName(parts)).toThrow();
      });
    } else {
      it(testCase.name, () => {
        expect(resolveChapterFileName(parts)).toBe(testCase.expected ?? '');
      });
    }
  }
});

describe('normalizeChapterExtension — packer formats', () => {
  for (const testCase of doc.extensions) {
    if (testCase.throws === true) {
      it(`${JSON.stringify(testCase.input)} — throws`, () => {
        expect(() => normalizeChapterExtension(testCase.input)).toThrow();
      });
    } else {
      it(JSON.stringify(testCase.input), () => {
        expect(normalizeChapterExtension(testCase.input)).toBe(testCase.expected ?? '');
      });
    }
  }
});
