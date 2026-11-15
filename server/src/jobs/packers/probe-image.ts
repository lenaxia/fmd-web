import type { Readable } from 'node:stream';
import { PackError } from './errors.js';
import { writeChunk } from './stream-utils.js';

/**
 * Streaming image probing for the PDF pack path (§7.3, D16): the packer
 * embeds JPEG (DCTDecode) and PNG (FlateDecode + PNG predictor 15)
 * bytes WITHOUT decoding them — the bytes pass from the page file
 * straight through to the disk-backed PDF. Bounded-memory state
 * machines parse only the headers (and PNG chunk framing); GIF/WebP/
 * BMP fail as `pack-unsupported-image` (retryable, re-encode hint) —
 * the per-image re-encode recovery converts them to JPEG.
 *
 * pdf-lib is deliberately NOT used here (documented D16 divergence):
 * it materializes the whole document in memory, which the 512 MB
 * per-job budget forbids for large chapters.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JPEG info needed for the XObject dict. */
export interface JpegProbeInfo {
  /** SOF components: 1 = DeviceGray, 3 = DeviceRGB, 4 = DeviceCMYK. */
  readonly components: number;
  /** True for progressive SOF2 — not embeddable (DCTDecode is baseline). */
  readonly progressive: boolean;
}

/** PNG info needed for the XObject dict + predictor DecodeParms. */
export interface PngProbeInfo {
  /** PDF DecodeParms /Colors: 1 gray, 3 RGB, 1 for palette indices. */
  readonly colors: number;
  readonly bitDepth: number;
  readonly interlaced: boolean;
  /** Total IDAT payload bytes across chunks — the PDF stream /Length. */
  readonly idatBytes: number;
  /** PLTE payload (undefined unless colorType 3). */
  readonly paletteBytes?: Buffer;
}

export interface ImageProbe {
  readonly kind: 'jpeg' | 'png';
  readonly width: number;
  readonly height: number;
  readonly jpeg?: JpegProbeInfo;
  readonly png?: PngProbeInfo;
}

/** Maximum bytes skipped while marker-walking a JPEG head (malformed guard). */
const JPEG_MAX_HEAD_SKIP = 32 * 1024 * 1024;
/** Max slice per through-write (bounded-memory copy granularity). */
const COPY_SLICE = 64 * 1024;

/**
 * A bounded-memory exact-read facade over a byte stream: parsers pull
 * fixed-size windows; skips and through-copies move at most one 64 KiB
 * slice at a time. Never holds more than the buffered remainder.
 */
export class ChunkSource {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly source: Readable;
  private readonly iterator: AsyncIterator<Uint8Array>;
  private exhausted = false;

  constructor(source: Readable) {
    this.source = source;
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async pullNext(): Promise<boolean> {
    if (this.buffered.length > 0) {
      return true;
    }
    if (this.exhausted) {
      return false;
    }
    const next = await this.iterator.next();
    if (next.done === true) {
      this.exhausted = true;
      return false;
    }
    const chunk = Buffer.from(next.value);
    this.buffered = chunk;
    return true;
  }

  /** Push bytes back to the head (dispatch sniffs then hands off). */
  unread(data: Buffer): void {
    this.buffered = Buffer.concat([data, this.buffered]);
  }

  /** Exact read; undefined on clean EOF (callers decide if that is an error). */
  async tryReadExact(n: number): Promise<Buffer | undefined> {
    const parts: Buffer[] = [];
    let needed = n;
    while (needed > 0) {
      if (!(await this.pullNext())) {
        return undefined;
      }
      const take = Math.min(this.buffered.length, needed);
      parts.push(this.buffered.subarray(0, take));
      this.buffered = this.buffered.subarray(take);
      needed -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }

  async readExact(n: number, context: string): Promise<Buffer> {
    const data = await this.tryReadExact(n);
    if (data === undefined) {
      throw new PackError('pack-io', `${context}: unexpected end of image data`);
    }
    return data;
  }

  /** Discard exactly n bytes in bounded slices. */
  async skipExact(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const take = Math.min(remaining, COPY_SLICE);
      const data = await this.readExact(take, 'skip');
      void data;
      remaining -= take;
    }
  }

  /** Through-copy exactly n bytes to `out` in bounded slices. Returns n. */
  async copyExactTo(n: number, out: NodeJS.WritableStream): Promise<number> {
    let remaining = n;
    while (remaining > 0) {
      const take = Math.min(remaining, COPY_SLICE);
      const data = await this.readExact(take, 'copy');
      await writeChunk(out, data);
      remaining -= take;
    }
    return n;
  }

  /** Release the underlying stream (parsers must always call this). */
  dispose(): void {
    this.iterator.return?.().catch(() => undefined);
    this.source.destroy();
  }
}

function unsupported(label: string, reason: string): PackError {
  return new PackError('pack-unsupported-image', `${label}: ${reason}`, {
    recoveryHint: 're-encode-pages',
  });
}

function byteAt(buffer: Buffer, index: number, context: string): number {
  const value = buffer[index];
  if (value === undefined) {
    throw new PackError('pack-io', `${context}: truncated buffer`);
  }
  return value;
}

function u16be(buffer: Buffer, offset: number): number {
  return (byteAt(buffer, offset, 'u16') << 8) | byteAt(buffer, offset + 1, 'u16');
}

function u32be(buffer: Buffer, offset: number): number {
  return (
    ((byteAt(buffer, offset, 'u32') << 24) |
      (byteAt(buffer, offset + 1, 'u32') << 16) |
      (byteAt(buffer, offset + 2, 'u32') << 8) |
      byteAt(buffer, offset + 3, 'u32')) >>>
    0
  );
}

async function probeJpeg(source: ChunkSource, label: string): Promise<ImageProbe> {
  const soi = await source.readExact(2, 'jpeg signature');
  if (byteAt(soi, 0, 'jpeg signature') !== 0xff || byteAt(soi, 1, 'jpeg signature') !== 0xd8) {
    throw unsupported(label, 'not a baseline JPEG stream');
  }
  let skipped = 0;
  let progressive = false;
  let components = 0;
  let width = 0;
  let height = 0;
  for (;;) {
    // Marker sync: fill bytes (0xFF) between markers are allowed.
    let byte = byteAt(await source.readExact(1, 'jpeg marker'), 0, 'jpeg marker');
    while (byte !== 0xff) {
      byte = byteAt(await source.readExact(1, 'jpeg marker sync'), 0, 'jpeg marker sync');
    }
    let marker = byteAt(await source.readExact(1, 'jpeg marker code'), 0, 'jpeg marker code');
    while (marker === 0xff) {
      marker = byteAt(await source.readExact(1, 'jpeg marker code'), 0, 'jpeg marker code');
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue; // standalone markers carry no length field
    }
    const length = u16be(await source.readExact(2, 'jpeg segment length'), 0);
    if (length < 2) {
      throw unsupported(label, 'malformed JPEG segment length');
    }
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && // DHT
      marker !== 0xc8 && // JPG
      marker !== 0xcc; // DAC
    if (isSof) {
      // precision(1) + height(2) + width(2) + components(1)
      const sof = await source.readExact(6, 'jpeg SOF');
      height = u16be(sof, 1);
      width = u16be(sof, 3);
      components = byteAt(sof, 5, 'jpeg SOF components');
      progressive = marker === 0xc2;
      await source.skipExact(length - 2 - 6);
    } else if (marker === 0xda) {
      await source.skipExact(length - 2);
      break; // entropy-coded scan follows — parsing done
    } else {
      skipped += length - 2;
      if (skipped > JPEG_MAX_HEAD_SKIP) {
        throw unsupported(label, 'JPEG head exceeds the probe bound (malformed)');
      }
      await source.skipExact(length - 2);
    }
  }
  if (width <= 0 || height <= 0) {
    throw unsupported(label, 'JPEG carries no usable SOF dimensions');
  }
  if (components !== 1 && components !== 3 && components !== 4) {
    throw unsupported(label, `unsupported JPEG component count ${components}`);
  }
  if (progressive) {
    throw unsupported(label, 'progressive JPEG is not embeddable (DCTDecode is baseline-only)');
  }
  return { kind: 'jpeg', width, height, jpeg: { components, progressive: false } };
}

async function probePng(source: ChunkSource, label: string): Promise<ImageProbe> {
  const signature = await source.readExact(8, 'png signature');
  if (!signature.equals(PNG_SIGNATURE)) {
    throw unsupported(label, 'not a PNG stream');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlaced = false;
  let idatBytes = 0;
  let palette: Buffer | undefined;
  for (;;) {
    const header = await source.readExact(8, 'png chunk header');
    const length = u32be(header, 0);
    const type = header.subarray(4, 8).toString('latin1');
    if (length > 0x7fff_ffff) {
      throw unsupported(label, 'malformed PNG chunk length');
    }
    if (type === 'IHDR') {
      const data = await source.readExact(13, 'png IHDR');
      width = u32be(data, 0);
      height = u32be(data, 4);
      bitDepth = byteAt(data, 8, 'png IHDR bit depth');
      colorType = byteAt(data, 9, 'png IHDR color type');
      interlaced = byteAt(data, 12, 'png IHDR interlace') === 1;
      await source.skipExact(4); // CRC
    } else if (type === 'PLTE') {
      if (length > 768) {
        throw unsupported(label, 'PNG palette exceeds 256 entries');
      }
      palette = Buffer.from(await source.readExact(length, 'png PLTE'));
      await source.skipExact(4);
    } else if (type === 'IDAT') {
      idatBytes += length;
      await source.skipExact(length + 4);
    } else if (type === 'IEND') {
      break;
    } else {
      await source.skipExact(length + 4);
    }
  }
  if (width <= 0 || height <= 0) {
    throw unsupported(label, 'PNG carries no usable IHDR dimensions');
  }
  if (bitDepth !== 8) {
    throw unsupported(label, `unsupported PNG bit depth ${bitDepth}`);
  }
  if (interlaced) {
    throw unsupported(label, 'interlaced PNG is not embeddable without decode');
  }
  if (colorType === 4 || colorType === 6) {
    throw unsupported(label, 'PNG alpha channels require the re-encode recovery');
  }
  if (colorType !== 0 && colorType !== 2 && colorType !== 3) {
    throw unsupported(label, `unsupported PNG color type ${colorType}`);
  }
  if (colorType === 3 && (palette === undefined || palette.length === 0)) {
    throw unsupported(label, 'palette PNG without a PLTE chunk');
  }
  if (idatBytes === 0) {
    throw unsupported(label, 'PNG without IDAT data');
  }
  const colors = colorType === 2 ? 3 : 1; // palette indices decode as 1 component
  return {
    kind: 'png',
    width,
    height,
    png: {
      colors,
      bitDepth,
      interlaced: false,
      idatBytes,
      ...(palette !== undefined ? { paletteBytes: palette } : {}),
    },
  };
}

/**
 * Probe one page image from its stream (bounded memory) and dispose the
 * stream. Throws PackError('pack-unsupported-image') for formats the
 * PDF path cannot embed byte-for-byte.
 */
export async function probeEmbeddableImage(
  source: Readable,
  label: string,
): Promise<ImageProbe> {
  const chunked = new ChunkSource(source);
  try {
    const magic = await chunked.tryReadExact(12);
    if (magic === undefined || magic.length < 4) {
      throw unsupported(label, 'empty or truncated image');
    }
    if (byteAt(magic, 0, 'magic') === 0xff && byteAt(magic, 1, 'magic') === 0xd8) {
      chunked.unread(magic);
      return await probeJpeg(chunked, label);
    }
    if (magic.subarray(0, 8).equals(PNG_SIGNATURE)) {
      chunked.unread(magic);
      return await probePng(chunked, label);
    }
    const ascii = magic.subarray(0, 6).toString('latin1');
    if (ascii.startsWith('GIF8')) {
      throw unsupported(label, 'GIF is not embeddable in PDF without decode');
    }
    if (magic.subarray(0, 4).toString('latin1') === 'RIFF' && magic.subarray(8, 12).toString('latin1') === 'WEBP') {
      throw unsupported(label, 'WebP is not embeddable in PDF without decode');
    }
    if (magic.subarray(0, 2).toString('latin1') === 'BM') {
      throw unsupported(label, 'BMP is not embeddable in PDF without decode');
    }
    if (magic.subarray(4, 8).toString('latin1') === 'ftyp') {
      throw unsupported(label, 'ISOBMFF (AVIF/HEIC) is not embeddable in PDF without decode');
    }
    throw unsupported(label, 'unrecognized image format');
  } finally {
    chunked.dispose();
  }
}

/**
 * PDF pass 2 for PNG pages: re-walk the chunk framing and through-copy
 * ONLY the IDAT payloads (bounded slices) — the concatenated payloads
 * form the single zlib stream the /FlateDecode + predictor-15 object
 * expects. Returns the copied byte count (must equal probe.idatBytes).
 */
export async function streamPngIdatTo(source: Readable, out: NodeJS.WritableStream): Promise<number> {
  const chunked = new ChunkSource(source);
  let copied = 0;
  try {
    const signature = await chunked.readExact(8, 'png signature');
    if (!signature.equals(PNG_SIGNATURE)) {
      throw new PackError('pack-io', 'png pass-2: signature vanished between passes');
    }
    for (;;) {
      const header = await chunked.readExact(8, 'png chunk header');
      const length = u32be(header, 0);
      const type = header.subarray(4, 8).toString('latin1');
      if (type === 'IEND') {
        break;
      }
      if (type === 'IDAT') {
        copied += await chunked.copyExactTo(length, out);
        await chunked.skipExact(4);
      } else {
        await chunked.skipExact(length + 4);
      }
    }
    return copied;
  } finally {
    chunked.dispose();
  }
}
