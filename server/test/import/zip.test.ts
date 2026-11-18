// @vitest-environment node
/**
 * The import zip reader: genuine archiver-produced archives (deflate),
 * STORE entries, nested directory layouts, and every corruption class
 * mapping to a loud ZipError (→ typed 400 at the API boundary).
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import archiver from 'archiver';
import { crc32Of, readZip, ZipError } from '../../src/import/fmd2/zip.js';

async function zip(entries: readonly { name: string; data: Buffer; store?: boolean }[]): Promise<Buffer> {
  const archive = archiver('zip', {});
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject): void => {
    archive.on('data', (chunk: Buffer): void => {
      chunks.push(chunk);
    });
    archive.on('end', (): void => resolve());
    archive.on('error', (err): void => reject(err));
  });
  for (const entry of entries) {
    archive.append(entry.data, { name: entry.name, store: entry.store === true });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

describe('import zip reader', (): void => {
  it('reads deflate and store entries with nested paths', async (): Promise<void> => {
    const buffer = await zip([
      { name: 'userdata/favorites.db', data: Buffer.from('sqlite-ish-bytes') },
      { name: 'userdata/settings.json', data: Buffer.from('{"connections":{}}'), store: true },
    ]);
    const entries = readZip(buffer);
    expect(entries.map((entry): string => entry.name)).toEqual(['userdata/favorites.db', 'userdata/settings.json']);
    expect(entries[0]?.data.toString()).toBe('sqlite-ish-bytes');
    expect(entries[1]?.data.toString()).toBe('{"connections":{}}');
  });

  it('directory records surface as isDirectory entries', async (): Promise<void> => {
    const buffer = await zip([{ name: 'userdata/', data: Buffer.alloc(0) }]);
    const entries = readZip(buffer);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isDirectory).toBe(true);
  });

  it('rejects non-zip bytes loudly', (): void => {
    expect((): ReturnType<typeof readZip> => readZip(Buffer.from('plainly not a zip'))).toThrow(ZipError);
  });

  it('rejects a truncated archive (central directory gone)', async (): Promise<void> => {
    const buffer = await zip([{ name: 'a.db', data: Buffer.alloc(64, 1) }]);
    const truncated = buffer.subarray(0, Math.floor(buffer.length / 2));
    expect((): ReturnType<typeof readZip> => readZip(truncated)).toThrow(/corrupt zip|no end-of-central-directory/);
  });

  it('rejects a CRC mismatch (bit-flipped payload)', async (): Promise<void> => {
    const buffer = await zip([{ name: 'a.db', data: Buffer.from('chapter data that matters') }]);
    // Flip one byte inside the compressed payload region (after the
    // local header; before the central directory).
    const flipped = Buffer.from(buffer);
    flipped[40] = (flipped[40] ?? 0) ^ 0xff;
    expect((): ReturnType<typeof readZip> => readZip(flipped)).toThrow(ZipError);
  });

  it('handles a trailing zip comment (EOCD scan-back)', async (): Promise<void> => {
    const buffer = await zip([{ name: 'a.txt', data: Buffer.from('x') }]);
    const withComment = Buffer.concat([buffer, Buffer.from('a zip comment')]);
    const entries = readZip(withComment);
    expect(entries[0]?.name).toBe('a.txt');
  });
});

describe('crc32Of', (): void => {
  it('matches the reference CRC-32 vectors', (): void => {
    expect(crc32Of(Buffer.alloc(0))).toBe(0x00000000);
    expect(crc32Of(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

// Keep the deflate import honest (zip.ts parity — method 8 is raw deflate).
void deflateRawSync;
