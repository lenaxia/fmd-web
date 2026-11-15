import { describe, expect, it } from 'vitest';
import { composeFileName } from '../../../src/jobs/download/filenames.js';

/**
 * Module filename flow (DESIGN §7.1, uDownloadsManager.pas:530-550 +
 * FMDOptions.pas:26): FileNames[] honored when FileNames.Count =
 * PageLinks.Count, `%.3d` index fallback, the `%FILENAME%` custom-rename
 * template (empty CustomFileName defaults to '%FILENAME%',
 * :1112-1114), and tail-truncation when CurrentMaxFileNameLength > 0
 * (Delete from the HEAD — the TAIL survives, D5 Windows-parity).
 */
describe('composeFileName — FileNames[] honored (:531-533)', () => {
  it('uses FileNames[WorkId] when FileNames length matches PageLinks count', () => {
    expect(composeFileName(0, ['a.jpg', 'b.jpg'], 2, '', 0)).toBe('a.jpg');
    expect(composeFileName(1, ['a.jpg', 'b.jpg'], 2, '', 0)).toBe('b.jpg');
  });

  it('falls back to the %.3d index when FileNames does not align', () => {
    expect(composeFileName(0, [], 5, '', 0)).toBe('001');
    expect(composeFileName(2, ['only-one'], 5, '', 0)).toBe('003');
    expect(composeFileName(11, ['only-one'], 5, '', 0)).toBe('012');
    expect(composeFileName(999, [], 5, '', 0)).toBe('1000');
  });

  it('falls back to the %.3d index when the FileNames entry is empty', () => {
    expect(composeFileName(0, ['', 'b.jpg'], 2, '', 0)).toBe('001');
    expect(composeFileName(1, ['', 'b.jpg'], 2, '', 0)).toBe('b.jpg');
  });

  it('out-of-range WorkId falls back to the index', () => {
    expect(composeFileName(7, ['a.jpg'], 1, '', 0)).toBe('008');
  });
});

describe('composeFileName — %FILENAME% template (:542, FMDOptions.pas:26)', () => {
  it('empty template defaults to %FILENAME% (:1112-1114)', () => {
    expect(composeFileName(3, [], 5, '', 0)).toBe('004');
  });

  it('replaces every %FILENAME% occurrence with the composed base name', () => {
    expect(composeFileName(0, ['cover'], 1, '%FILENAME%', 0)).toBe('cover');
    expect(composeFileName(0, [], 1, 'page-%FILENAME%', 0)).toBe('page-001');
    expect(composeFileName(2, [], 5, '%FILENAME%_%FILENAME%', 0)).toBe('003_003');
  });

  it('the FileNames entry rides through the template too (:531→:542 order)', () => {
    expect(composeFileName(1, ['x', 'custom-name'], 2, 'img-%FILENAME%.bin', 0)).toBe(
      'img-custom-name.bin',
    );
  });
});

describe('composeFileName — tail truncation (:543-550, D5)', () => {
  it('keeps the TAIL when over CurrentMaxFileNameLength (Delete from head)', () => {
    // 'page-001' (8) with max 5 → Delete(s,1,3) → 'e-001'
    expect(composeFileName(0, [], 5, 'page-%FILENAME%', 5)).toBe('e-001');
  });

  it('leaves short names untouched', () => {
    expect(composeFileName(0, [], 5, '', 32)).toBe('001');
    expect(composeFileName(0, ['ab'], 1, '', 2)).toBe('ab');
  });

  it('maxLength 0 means no limit (D5: CurrentMaxFileNameLength=0)', () => {
    const long = 'x'.repeat(500);
    expect(composeFileName(0, [long], 1, '', 0)).toBe(long);
  });

  it('truncation applies after the template expansion', () => {
    // 'img-001' (7) with max 6 → Delete(s,1,1) → 'mg-001'
    expect(composeFileName(0, [], 5, 'img-%FILENAME%', 6)).toBe('mg-001');
  });

  it('a maxLength of exactly the length is a no-op', () => {
    expect(composeFileName(0, [], 5, '', 3)).toBe('001');
  });
});
