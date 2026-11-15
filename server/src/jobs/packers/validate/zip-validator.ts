import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { crc32, inflateRawSync } from 'node:zlib';

/**
 * ZIP validator — a real central-directory walk (§13 packer outputs):
 * locates the End Of Central Directory record, walks every central
 * directory entry in stored order, then re-opens each entry through its
 * LOCAL header and verifies name consistency, sizes, and CRC32.
 * Supports the two methods the packers emit (0 = stored, 8 = deflate)
 * plus classic EOCD layout (no ZIP64 — pack outputs are far below the
 * 4 GiB classic boundary).
 */

export interface ZipCentralEntry {
  readonly name: string;
  /** 0 = stored, 8 = deflate. */
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
}

export interface ZipCentralWalk {
  readonly entries: ZipCentralEntry[];
  readonly eocdOffset: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
  readonly entryCount: number;
}

export interface ZipEntryCheck {
  readonly name: string;
  readonly method: number;
  readonly size: number;
  readonly crcOk: boolean;
  readonly sizeOk: boolean;
  readonly localNameMatches: boolean;
}

export interface ZipValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly entries: ZipEntryCheck[];
  readonly entryCount: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
/** Sanity bound for a central directory buffer (100k entries ≈ 14 MB). */
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
/** Sanity bound for a single inflated entry (malformed-size guard). */
const MAX_INFLATED_ENTRY_BYTES = 512 * 1024 * 1024;

function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

async function readSpan(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

/**
 * Walk the central directory: EOCD scan from the tail, then every
 * entry in stored (archive) order — this is the order test source.
 */
export async function walkZipCentralDirectory(filePath: string): Promise<ZipCentralWalk> {
  const fh = await open(filePath, 'r');
  try {
    const fileSize = (await fh.stat()).size;
    const tailLength = Math.min(fileSize, EOCD_MIN_LENGTH + 0xffff);
    const tail = await readSpan(fh, fileSize - tailLength, tailLength);
    let eocdRelative = -1;
    for (let i = tail.length - EOCD_MIN_LENGTH; i >= 0; i -= 1) {
      if (u32(tail, i) === EOCD_SIGNATURE) {
        eocdRelative = i;
        break;
      }
    }
    if (eocdRelative < 0) {
      throw new Error('no End Of Central Directory record found (not a readable ZIP)');
    }
    const tailBase = fileSize - tailLength;
    const eocd = tail.subarray(eocdRelative);
    const entryCount = u16(eocd, 10);
    const centralDirectorySize = u32(eocd, 12);
    const centralDirectoryOffset = u32(eocd, 16);
    if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error('central directory exceeds the validator bound');
    }
    if (centralDirectoryOffset + centralDirectorySize > fileSize) {
      throw new Error('central directory extends past end of file');
    }
    const central = await readSpan(fh, centralDirectoryOffset, centralDirectorySize);
    const entries: ZipCentralEntry[] = [];
    let pos = 0;
    for (let i = 0; i < entryCount; i += 1) {
      if (pos + 46 > central.length || u32(central, pos) !== CENTRAL_SIGNATURE) {
        throw new Error(`central directory entry ${i} is corrupt or truncated`);
      }
      const nameLength = u16(central, pos + 28);
      const extraLength = u16(central, pos + 30);
      const commentLength = u16(central, pos + 32);
      const name = central.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
      entries.push({
        name,
        method: u16(central, pos + 10),
        crc32: u32(central, pos + 16),
        compressedSize: u32(central, pos + 20),
        size: u32(central, pos + 24),
        localHeaderOffset: u32(central, pos + 42),
      });
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return {
      entries,
      eocdOffset: tailBase + eocdRelative,
      centralDirectoryOffset,
      centralDirectorySize,
      entryCount,
    };
  } finally {
    await fh.close();
  }
}

async function readEntryBytes(
  filePath: string,
  entry: ZipCentralEntry,
): Promise<{ data: Buffer; localNameMatches: boolean }> {
  const fh = await open(filePath, 'r');
  try {
    const local = await readSpan(fh, entry.localHeaderOffset, 30);
    if (local.length < 30 || u32(local, 0) !== LOCAL_SIGNATURE) {
      throw new Error(`local header signature missing at ${entry.localHeaderOffset}`);
    }
    const localNameLength = u16(local, 26);
    const localExtraLength = u16(local, 28);
    const localName = (
      await readSpan(fh, entry.localHeaderOffset + 30, localNameLength)
    ).toString('utf8');
    const dataOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = await readSpan(fh, dataOffset, entry.compressedSize);
    if (compressed.length < entry.compressedSize) {
      throw new Error('data truncated');
    }
    let data: Buffer;
    if (entry.method === 0) {
      data = Buffer.from(compressed);
    } else if (entry.method === 8) {
      data = inflateRawSync(compressed);
      if (data.length > MAX_INFLATED_ENTRY_BYTES) {
        throw new Error('inflated size exceeds the validator bound');
      }
    } else {
      throw new Error(`unsupported method ${entry.method}`);
    }
    return { data, localNameMatches: localName === entry.name };
  } finally {
    await fh.close();
  }
}

/** Convenience: find + verify + return one entry's bytes. */
export async function readZipEntry(filePath: string, name: string): Promise<Buffer> {
  const walk = await walkZipCentralDirectory(filePath);
  const entry = walk.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`entry not found: ${name}`);
  }
  return (await readEntryBytes(filePath, entry)).data;
}

/**
 * Full structural validation: EOCD, central walk (entry count), and
 * per-entry local-header/name/size/CRC32 verification. When
 * `expectedNames` is given the entry sequence must match exactly —
 * that is the ZIP entry-order (chapter page order) check.
 */
export async function validateZipArchive(
  filePath: string,
  expectedNames?: readonly string[],
): Promise<ZipValidationResult> {
  const errors: string[] = [];
  const checks: ZipEntryCheck[] = [];
  let walk: ZipCentralWalk;
  try {
    walk = await walkZipCentralDirectory(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [message], entries: [], entryCount: 0 };
  }
  if (walk.entries.length !== walk.entryCount) {
    errors.push(`entry count mismatch: EOCD says ${walk.entryCount}, central directory holds ${walk.entries.length}`);
  }
  if (expectedNames !== undefined) {
    if (walk.entries.length !== expectedNames.length) {
      errors.push(`entry count ${walk.entries.length} does not match expected ${expectedNames.length}`);
    }
    const count = Math.min(walk.entries.length, expectedNames.length);
    for (let i = 0; i < count; i += 1) {
      const actual = walk.entries[i]?.name ?? '';
      const expected = expectedNames[i] ?? '';
      if (actual !== expected) {
        errors.push(`entry order mismatch at ${i}: got '${actual}', expected '${expected}'`);
      }
    }
  }
  for (const entry of walk.entries) {
    try {
      const { data, localNameMatches } = await readEntryBytes(filePath, entry);
      const crcOk = crc32(data) === entry.crc32;
      const sizeOk = data.length === entry.size;
      if (!crcOk) {
        errors.push(`entry ${entry.name}: CRC32 mismatch`);
      }
      if (!sizeOk) {
        errors.push(`entry ${entry.name}: size mismatch (${data.length} vs ${entry.size})`);
      }
      if (!localNameMatches) {
        errors.push(`entry ${entry.name}: local header name mismatch`);
      }
      checks.push({ name: entry.name, method: entry.method, size: data.length, crcOk, sizeOk, localNameMatches });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`entry ${entry.name}: ${message}`);
      checks.push({
        name: entry.name,
        method: entry.method,
        size: entry.size,
        crcOk: false,
        sizeOk: false,
        localNameMatches: false,
      });
    }
  }
  return { ok: errors.length === 0, errors, entries: checks, entryCount: walk.entries.length };
}
