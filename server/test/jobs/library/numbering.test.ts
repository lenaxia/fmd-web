/**
 * `<numbering>` (D1 §7): the zero-padded 1-based list ordinal — FMD2's
 * own `Format('%.4d', [i + 1])` semantics (uSilentThread.pas:338),
 * never a number parsed from a chapter title (D1 §5; the
 * no-chapter-number-parsing gate). Width floor 4, widened by the
 * digit-padding setting ("the existing digit-padding setting governs
 * the minimum width").
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAPTER_NAME_TEMPLATE,
  formatChapterNumbering,
} from '../../../src/jobs/library/filenames.js';

describe('formatChapterNumbering — FMD2 %.4d parity, D1 §7', (): void => {
  it('pads to FMD2’s own minimum width 4 (Format(‘%.4d’, [i + 1]))', (): void => {
    expect(formatChapterNumbering(1, 0)).toBe('0001');
    expect(formatChapterNumbering(42, 0)).toBe('0042');
    expect(formatChapterNumbering(1234, 0)).toBe('1234');
    expect(formatChapterNumbering(12345, 0)).toBe('12345');
  });

  it('the digit-padding setting widens the minimum (never narrows)', (): void => {
    expect(formatChapterNumbering(7, 6)).toBe('000007');
    expect(formatChapterNumbering(7, 4)).toBe('0007');
    expect(formatChapterNumbering(7, 2)).toBe('0007');
    expect(formatChapterNumbering(7, undefined)).toBe('0007');
  });

  it('an absent position yields ’’ (position unknown → chapter-name-only filename)', (): void => {
    expect(formatChapterNumbering(undefined, 4)).toBe('');
  });

  it('the frozen default template is exactly %NUMBERING% %CHAPTER% (D1 §7)', (): void => {
    expect(DEFAULT_CHAPTER_NAME_TEMPLATE).toBe('%NUMBERING% %CHAPTER%');
  });
});
