import { inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reader for codeload zipballs (DESIGN.md §8.5 supply chain):
 * the sync service downloads a pinned-SHA zipball and extracts only the
 * `lua/` subtree, so the reader needs stored + deflate entries, central
 * directory parsing and CRC-32 verification — nothing else. Zip64 and
 * encrypted entries are refused loudly (a real FMD2 zipball never needs
 * them at its size).
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
/** Scan window for the End-Of-Central-Directory record (comment ≤ 64 KiB). */
const EOCD_SCAN_WINDOW = EOCD_MIN_SIZE + 65_536;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipballEntry {
  /** POSIX-style path inside the archive (forward slashes, no leading '/'). */
  readonly name: string;
  readonly data: Buffer;
}

export class ZipballError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipballError';
  }
}

export function crc32(data: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * Parse a zip archive and extract every file entry, verifying each entry's
 * CRC-32. Directory entries are skipped. Throws `ZipballError` on any
 * structural surprise (bad signature, truncation, unknown method, CRC
 * mismatch, zip64, encryption).
 */
export function readZipball(archive: Uint8Array): ZipballEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocd = findEocd(archive, view);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  const entries: ZipballEntry[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > archive.byteLength || view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipballError(`bad central directory entry #${i}`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decodeName(archive, cursor + 46, nameLength);
    if ((flags & 0x1) !== 0) {
      throw new ZipballError(`encrypted entry not supported: ${name}`);
    }
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipballError(`zip64 entry not supported: ${name}`);
    }
    if (name.endsWith('/')) {
      // directory entry — nothing to extract
    } else {
      const data = extractEntry(archive, view, name, localOffset, method, compressedSize, crc);
      entries.push({ name, data });
    }    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEocd(archive: Uint8Array, view: DataView): number {
  const minStart = Math.max(0, archive.byteLength - EOCD_SCAN_WINDOW);
  for (let pos = archive.byteLength - EOCD_MIN_SIZE; pos >= minStart; pos--) {
    if (view.getUint32(pos, true) === EOCD_SIGNATURE) {
      return pos;
    }
  }
  throw new ZipballError('not a zip archive (no End-Of-Central-Directory record)');
}

function extractEntry(
  archive: Uint8Array,
  view: DataView,
  name: string,
  localOffset: number,
  method: number,
  compressedSize: number,
  expectedCrc: number,
): Buffer {
  if (localOffset + 30 > archive.byteLength || view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipballError(`bad local header for ${name}`);
  }
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > archive.byteLength) {
    throw new ZipballError(`truncated entry data for ${name}`);
  }
  const stored = archive.subarray(dataStart, dataEnd);
  let data: Buffer;
  switch (method) {
    case METHOD_STORED:
      data = Buffer.from(stored);
      break;
    case METHOD_DEFLATE:
      data = inflateRawSync(stored);
      break;
    default:
      throw new ZipballError(`unsupported compression method ${method} for ${name}`);
  }
  const actualCrc = crc32(data);
  if (actualCrc !== expectedCrc) {
    throw new ZipballError(`crc32 mismatch for ${name}: expected ${expectedCrc}, got ${actualCrc}`);
  }
  return data;
}

function decodeName(archive: Uint8Array, start: number, length: number): string {
  // Names are decoded as UTF-8 (FMD2 repo paths are ASCII; bit-11-flagged
  // names are already UTF-8 — one decoder covers both).
  return Buffer.from(archive.subarray(start, start + length)).toString('utf8');
}
