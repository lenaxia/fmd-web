import { describe, expect, it } from 'vitest';
import { crc32, readZipball, ZipballError } from '../../../src/sync/modules/zipball.js';
import { buildFixtureZipball, type FixtureFile } from './fixture-zipball.js';

/**
 * Zipball reader units: CRC-32 vector, stored roundtrip, and the loud
 * structural refusals (truncation, CRC mismatch, not-a-zip). The
 * integration suite covers the deflate path via real archives.
 */

describe('zipball reader', (): void => {
  it('computes the standard CRC-32 check vector', (): void => {
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('roundtrips stored entries (single root, nested dirs, binary payload)', (): void => {
    const files: FixtureFile[] = [
      { path: 'modules/One.lua', content: 'return 1\n' },
      { path: 'modules/nested/Two.lua', content: 'return { ok = true }\n' },
      { path: 'assets/blob.bin', content: Buffer.from([0, 1, 2, 255, 254, 0x80]) },
    ];
    const zip = buildFixtureZipball('FMD2-97c903b340', files, '');
    const entries = readZipball(zip.bytes);
    expect(entries.map((e) => e.name)).toEqual([
      'FMD2-97c903b340/modules/One.lua',
      'FMD2-97c903b340/modules/nested/Two.lua',
      'FMD2-97c903b340/assets/blob.bin',
    ]);
    expect(entries.map((e) => e.data.toString('utf8'))).toEqual([
      'return 1\n',
      'return { ok = true }\n',
      Buffer.from([0, 1, 2, 255, 254, 0x80]).toString('utf8'),
    ]);
  });

  it('refuses a truncated archive', (): void => {
    const zip = buildFixtureZipball('FMD2-97c903b340', [{ path: 'a.lua', content: 'x' }]);
    expect(() => readZipball(zip.bytes.subarray(0, zip.bytes.length - 10))).toThrow(ZipballError);
  });

  it('refuses a corrupted entry payload (CRC mismatch)', (): void => {
    const name = 'FMD2-97c903b340/modules/One.lua';
    const zip = buildFixtureZipball('FMD2-97c903b340', [{ path: 'modules/One.lua', content: 'return 1\n' }], '');
    const corrupt = Buffer.from(zip.bytes);
    const dataStart = 30 + Buffer.byteLength(name); // first entry's data begins after its local header + name
    corrupt[dataStart] = (corrupt[dataStart] ?? 0) ^ 0xff;
    expect(() => readZipball(corrupt)).toThrow(/crc32 mismatch/);
  });

  it('refuses input that is not a zip archive', (): void => {
    expect(() => readZipball(Buffer.from('definitely not a zip archive'))).toThrow(ZipballError);
  });
});
