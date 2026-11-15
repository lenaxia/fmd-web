import { deflateSync, crc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PackPageInput } from '../../../src/jobs/packers/types.js';

/**
 * Synthetic chapter fixtures for the packer tests: deterministic
 * noisy PNGs (level-0 deflate → ~raw-sized "large-ish" images) and a
 * minimal-but-valid grayscale baseline JPEG encoder (flat blocks,
 * custom single-symbol Huffman tables) — both pure-node, offline.
 */

/** Deterministic 32-bit xorshift PRNG (seeded, reproducible runs). */
class Xorshift32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * A valid noisy RGB PNG (8-bit, non-interlaced). deflate level 0 keeps
 * generation fast while the payload stays ~raw-sized (noise barely
 * compresses even at level 9) — the memory test needs large-ish files.
 */
export function makeNoisyPng(width: number, height: number, seed: number): Buffer {
  const prng = new Xorshift32(seed);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (1 + width * 3);
    raw[offset] = 0; // filter: none
    for (let i = 0; i < width * 3; i += 1) {
      raw[offset + 1 + i] = prng.next() & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(raw, { level: 0 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const huffmanTable = (bits: readonly number[], values: readonly number[]): Buffer => {
  const out = Buffer.alloc(1 + 16 + values.length);
  out[0] = 0; // Tc/Th
  for (let i = 0; i < 16; i += 1) {
    out[1 + i] = bits[i] ?? 0;
  }
  for (let i = 0; i < values.length; i += 1) {
    out[17 + i] = values[i] ?? 0;
  }
  return out;
};

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(2 + 2 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out.writeUInt16BE(payload.length + 2, 2);
  payload.copy(out, 4);
  return out;
}

/**
 * A valid grayscale baseline JPEG (flat black blocks): SOF0 with a
 * custom DC table (symbol 0 → code '0') and AC table (EOB symbol 0 →
 * code '0') — spec-valid tables, two bits per 8x8 block, byte-stuffed
 * entropy stream. Small files; the PNG fixtures carry the memory heft.
 */
export function makeSolidJpeg(width: number, height: number): Buffer {
  const quant = Buffer.alloc(65);
  quant[0] = 0; // Pq=0, Tq=0
  quant.fill(16, 1); // flat quant table
  const sof = Buffer.alloc(8);
  sof[0] = 8; // precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1; // components
  sof[6] = 0x11; // sampling 1x1
  sof[7] = 0; // quant table 0
  const dhtDc = huffmanTable([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0]);
  const dhtAc = huffmanTable([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0]);
  dhtDc[0] = 0x00; // Tc=0 (DC)
  dhtAc[0] = 0x10; // Tc=1 (AC)
  const sos = Buffer.from([1, 1, 0x00, 0, 63, 0]);

  const blocksPerRow = Math.ceil(width / 8);
  const blockRows = Math.ceil(height / 8);
  const bitWriter = { byte: 0, count: 0, out: [] as number[] };
  const writeBit = (bit: number): void => {
    bitWriter.byte = (bitWriter.byte << 1) | (bit & 1);
    bitWriter.count += 1;
    if (bitWriter.count === 8) {
      if (bitWriter.byte === 0xff) {
        bitWriter.out.push(0xff, 0x00); // byte stuffing
      }
      bitWriter.out.push(bitWriter.byte);
      bitWriter.byte = 0;
      bitWriter.count = 0;
    }
  };
  for (let i = 0; i < blocksPerRow * blockRows; i += 1) {
    writeBit(0); // DC symbol 0 (diff category 0, no extra bits)
    writeBit(0); // AC EOB symbol 0
  }
  while (bitWriter.count !== 0) {
    writeBit(1); // pad with 1-bits
  }

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    jpegSegment(0xdb, quant), // DQT
    jpegSegment(0xc0, sof), // SOF0 baseline
    jpegSegment(0xc4, dhtDc), // DHT DC
    jpegSegment(0xc4, dhtAc), // DHT AC
    jpegSegment(0xda, sos), // SOS
    Buffer.from(bitWriter.out),
    bitWriter.count > 0 ? Buffer.from([bitWriter.byte]) : Buffer.alloc(0),
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

export interface ChapterFixture {
  readonly dir: string;
  readonly pages: PackPageInput[];
  /** Total bytes of the generated image files. */
  readonly totalImageBytes: number;
}

export interface PageSpec {
  /** 'png' → makeNoisyPng(64, 64); 'jpeg' → makeSolidJpeg(48, 32). */
  readonly kind: 'png' | 'jpeg' | 'gif';
}

/** Write a small synthetic chapter (structural/order tests). */
export async function writeSmallChapter(parentDir: string, specs: readonly PageSpec[]): Promise<ChapterFixture> {
  const dir = join(parentDir, `chapter-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const pages: PackPageInput[] = [];
  let total = 0;
  let seed = 0x1234;
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i] ?? { kind: 'png' };
    const padded = String(i + 1).padStart(4, '0');
    const fileName = `${padded}.${spec.kind === 'jpeg' ? 'jpg' : spec.kind}`;
    const filePath = join(dir, fileName);
    if (spec.kind === 'png') {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const image = makeNoisyPng(64, 64, seed);
      await writeFile(filePath, image);
      total += image.length;
    } else if (spec.kind === 'jpeg') {
      const image = makeSolidJpeg(48, 32);
      await writeFile(filePath, image);
      total += image.length;
    } else {
      const image = Buffer.concat([
        Buffer.from('GIF89a', 'latin1'),
        Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]),
        Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0, 0]),
        Buffer.from([0x02, 0x02, 0x44, 0x01, 0]),
        Buffer.from([0x3b]),
      ]);
      await writeFile(filePath, image);
      total += image.length;
    }
    pages.push({ workId: i, filePath, fileName });
  }
  return { dir, pages, totalImageBytes: total };
}

/**
 * Write the synthetic 1000-page chapter for the memory test: pages are
 * large-ish noisy PNGs (raw-sized payloads). `width × height` decides
 * the per-page size (512×256 RGB ≈ 394 KB pre-deflate-overhead).
 */
export async function writeLargeChapter(
  parentDir: string,
  pageCount: number,
  width: number,
  height: number,
): Promise<ChapterFixture> {
  const dir = join(parentDir, `large-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const pages: PackPageInput[] = [];
  let total = 0;
  let seed = 0x5eed0000;
  for (let i = 0; i < pageCount; i += 1) {
    const padded = String(i + 1).padStart(4, '0');
    const fileName = `${padded}.png`;
    const filePath = join(dir, fileName);
    seed = (seed + 0x9e3779b9) >>> 0;
    const image = makeNoisyPng(width, height, seed);
    await writeFile(filePath, image);
    total += image.length;
    pages.push({ workId: i, filePath, fileName });
  }
  return { dir, pages, totalImageBytes: total };
}
