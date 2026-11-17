import { gunzipSync } from 'node:zlib';
import type { ZipballEntry } from './zipball.js';
import { ZipballError } from './zipball.js';

/**
 * Minimal TAR reader for the api.github.com tarball fallback (DESIGN.md
 * §8.5 supply chain): GitHub's fallback archive is a gzip'd ustar tar
 * with a single `<owner>-<Repo>-<sha7>` root. The reader handles plain
 * files only — plus the long-path machinery real GitHub tarballs use
 * (ustar prefix field, GNU longname 'L', pax 'x' path overrides) — and
 * refuses loudly on anything structurally surprising, mirroring the
 * zipball reader's posture. Directory/symlink/pax-global records are
 * skipped (the sync only ever extracts the `lua/` file subtree).
 */

const BLOCK_SIZE = 512;
const GNU_LONGNAME = 'L';
const GNU_LONGLINK = 'K';
const PAX_EXTENDED = 'x';
const PAX_GLOBAL = 'g';

export function readTarGz(archive: Uint8Array): ZipballEntry[] {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive);
  } catch (error) {
    throw new ZipballError(`not a gzip archive (tarball fallback): ${errorMessage(error)}`);
  }
  const entries: ZipballEntry[] = [];
  let cursor = 0;
  let pendingLongName: string | undefined;
  let pendingPaxPath: string | undefined;
  while (cursor + BLOCK_SIZE <= tar.byteLength) {
    const block = tar.subarray(cursor, cursor + BLOCK_SIZE);
    if (isZeroBlock(block)) {
      break; // end-of-archive (two zero blocks; the first suffices here)
    }
    const header = parseHeader(block, cursor);
    const dataEnd = cursor + BLOCK_SIZE + header.size;
    if (dataEnd > tar.byteLength) {
      throw new ZipballError(`truncated tar entry data for ${header.name}`);
    }
    const data = tar.subarray(cursor + BLOCK_SIZE, dataEnd);
    const paddedSize = padToBlock(header.size);
    switch (header.typeflag) {
      case GNU_LONGNAME:
      case GNU_LONGLINK:
        pendingLongName = decodeText(data.subarray(0, header.size)).replace(/\0+$/, '');
        break;
      case PAX_EXTENDED:
        pendingPaxPath = paxPathOverride(data, header.size);
        break;
      case PAX_GLOBAL:
        break; // repo-global metadata — nothing the subtree extraction needs
      default:
        if (!header.name.endsWith('/')) {
          // A pending GNU-longname / pax path belongs to THIS entry only.
          entries.push({ name: pendingPaxPath ?? pendingLongName ?? header.name, data: Buffer.from(data) });
        }
        pendingLongName = undefined;
        pendingPaxPath = undefined;
        break;
    }
    cursor = dataEnd + paddedSize;
  }
  if (entries.length === 0) {
    throw new ZipballError('tarball fallback contains no file entries');
  }
  return entries;
}

interface TarHeader {
  readonly name: string;
  readonly size: number;
  readonly typeflag: string;
}

function parseHeader(block: Uint8Array, index: number): TarHeader {
  if (decodeText(block.subarray(257, 262)) !== 'ustar') {
    throw new ZipballError(`bad tar header magic at block ${Math.floor(index / BLOCK_SIZE)}`);
  }
  const checksum = octal(block.subarray(148, 156));
  let actual = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    actual += i >= 148 && i < 156 ? 32 : block[i]!;
  }
  if (actual !== checksum) {
    throw new ZipballError(`tar header checksum mismatch at block ${Math.floor(index / BLOCK_SIZE)}`);
  }
  const name = decodeText(block.subarray(0, 100)).replace(/\0+$/, '');
  const prefix = decodeText(block.subarray(345, 500)).replace(/\0+$/, '');
  const fullName = prefix !== '' ? `${prefix}/${name}` : name;
  return {
    name: fullName,
    size: octal(block.subarray(124, 136)),
    typeflag: String.fromCharCode(block[156]!),
  };
}

/** pax `path=<value>` record (length-prefixed lines: `<len> key=value\n`). */
function paxPathOverride(data: Uint8Array, size: number): string | undefined {
  const text = decodeText(data.subarray(0, size));
  for (const line of text.split('\n')) {
    const match = /^(\d+) ([^=]+)=(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const [, key, value] = match;
    if (key === 'path') {
      return value;
    }
  }
  return undefined;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (block[i] !== 0) {
      return false;
    }
  }
  return true;
}

function padToBlock(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

/** Numeric fields are NUL- or space-terminated octal ASCII. */
function octal(field: Uint8Array): number {
  const text = decodeText(field).replace(/[\0 ]+$/, '');
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function decodeText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
