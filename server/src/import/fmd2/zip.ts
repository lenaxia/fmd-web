/**
 * Minimal ZIP reader for the FMD2 data-dir upload (DESIGN: "a zip of
 * the FMD2 data dir"). Read-only, in-memory, Node-zlib backed:
 *
 * - entries resolved through the central directory (the authoritative
 *   index — a truncated/edited archive fails loudly instead of
 *   silently dropping entries),
 * - methods STORE (0) and DEFLATE (8) — the two every zip tool (Windows
 *   Explorer, Info-ZIP, archiver, 7-Zip default-flate) produces for
 *   regular files,
 * - no encryption / zip64 / data-descriptor support: those shapes never
 *   occur for a user zipping their FMD2 folder with stock tools, and a
 *   clear 400 beats a half-parsed import.
 *
 * Everything throws `ZipError` with a stable message — the import
 * boundary maps that to a typed 400, never a 500.
 */
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** Path as stored in the archive (forward slashes, no leading ./). */
  readonly name: string;
  /** uncompressed bytes */
  readonly data: Buffer;
  /** True when the entry was a directory record. */
  readonly isDirectory: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CEN_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;

function readU16(b: Buffer, o: number): number {
  return b.readUInt16LE(o);
}

function readU32(b: Buffer, o: number): number {
  return b.readUInt32LE(o);
}

/**
 * Parse one archive. Throws ZipError on anything not a plain
 * store/deflate zip (encrypted, zip64, bad CRC-32 mismatch…).
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  // ── end-of-central-directory record (scan back — comment is capped
  // at 0xffff so at most the last 65_557 bytes) ─────────────────────
  let eocd = -1;
  const scanFloor = Math.max(0, buffer.length - 0xffff - 22);
  for (let p = buffer.length - 22; p >= scanFloor; p -= 1) {
    if (readU32(buffer, p) === EOCD_SIGNATURE) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) {
    throw new ZipError('not a zip archive (no end-of-central-directory record)');
  }
  const entryCount = readU16(buffer, eocd + 10);
  const cdOffset = readU32(buffer, eocd + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (p + 46 > buffer.length || readU32(buffer, p) !== CEN_SIGNATURE) {
      throw new ZipError(`corrupt zip: central directory entry ${index} unreadable`);
    }
    const flags = readU16(buffer, p + 8);
    const method = readU16(buffer, p + 10);
    const crc32 = readU32(buffer, p + 16);
    const compressedSize = readU32(buffer, p + 20);
    const uncompressedSize = readU32(buffer, p + 24);
    const nameLength = readU16(buffer, p + 28);
    const extraLength = readU16(buffer, p + 30);
    const commentLength = readU16(buffer, p + 32);
    const localOffset = readU32(buffer, p + 42);
    const rawName = buffer.subarray(p + 46, p + 46 + nameLength);
    // ZIP_NAME_ENCODING: FMD2 data files are ASCII-named; UTF-8 flag
    // honored, cp437 fallback is byte-preserving for ASCII either way.
    const name = (flags & 0x800) !== 0 ? rawName.toString('utf8') : rawName.toString('latin1');
    p += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) {
      entries.push({ name: name.replace(/\/+$/, ''), data: Buffer.alloc(0), isDirectory: true });
      continue;
    }
    if ((flags & 0x1) !== 0) {
      throw new ZipError(`encrypted zip entries are not supported (${name})`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError(`unsupported zip compression method ${String(method)} (${name})`);
    }

    // ── local file header (name may differ from central — trust the
    // central name, read sizes/offsets from the local record) ───────
    if (localOffset + 30 > buffer.length || readU32(buffer, localOffset) !== LFH_SIGNATURE) {
      throw new ZipError(`corrupt zip: local header for ${name} unreadable`);
    }
    const lfhNameLength = readU16(buffer, localOffset + 26);
    const lfhExtraLength = readU16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + lfhNameLength + lfhExtraLength;
    // Bit 3 (data descriptor): sizes live AFTER the data — the central
    // directory still carries the authoritative sizes, so slice by those.
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) {
      throw new ZipError(`corrupt zip: truncated data for ${name}`);
    }
    let data: Buffer;
    if (method === 8) {
      try {
        data = inflateRawSync(compressed);
      } catch (err: unknown) {
        throw new ZipError(`corrupt zip: deflate failed for ${name} (${err instanceof Error ? err.message : String(err)})`);
      }
    } else {
      data = Buffer.from(compressed);
    }
    if (data.length !== uncompressedSize) {
      throw new ZipError(`corrupt zip: size mismatch for ${name}`);
    }
    if ((crc32 !== 0 || data.length > 0) && crc32Of(data) !== crc32) {
      throw new ZipError(`corrupt zip: CRC mismatch for ${name}`);
    }
    entries.push({ name, data, isDirectory: false });
  }
  return entries;
}

// CRC-32 (IEEE 802.3) — the zip polynomial, table-driven.
const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Of(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] ?? 0;
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
