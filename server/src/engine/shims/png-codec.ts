import { inflateSync, deflateSync, crc32 } from 'node:zlib';

/**
 * Minimal offline PNG codec (DESIGN.md §13 offline rule): decode to raw
 * 8-bit RGBA + encode back, over node:zlib — no image dependency ships in
 * this workspace and the npm registry is unreachable (offline), so the
 * contract's "sharp port" rows are implemented over the same raw-pixel
 * interface sharp exposes ({ data, info: width/height/channels }) with a
 * self-contained codec instead (deviation documented in
 * docs/evidence-shims-image.md).
 *
 * Scope (documented):
 * - bit depth 1/2/4/8/16 for color types 0 (gray) and 3 (palette); depth
 *   8/16 for 2 (truecolor), 4 (gray+alpha), 6 (truecolor+alpha).
 * - 16-bit samples decode to their HIGH byte (Pascal's TFPCustomImage
 *   keeps the full word; the shipped assets and every fixture are 8-bit,
 *   so the pixel-exactness claims are scoped to 8-bit sources).
 * - tRNS: palette alpha honored; the single-color gray/truecolor form is
 *   ignored (FPReadPNG honors it — documented divergence, no fixture
 *   carries it).
 * - Adam7 interlaced PNGs are rejected (fail loud, see decodePng).
 * - Encode is always RGBA8, filter 0, color type 6, deflate — byte
 *   layout is deterministic for a given zlib build (the goldens compare
 *   DECODED pixels, never encoder bytes).
 */

export interface RawImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes/pixel, row-major, top-left origin. */
  readonly data: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngCodecError';
  }
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

const CHANNELS_BY_COLOR_TYPE: Readonly<Record<number, number>> = {
  0: 1, // grayscale
  2: 3, // truecolor
  3: 1, // palette index
  4: 2, // grayscale + alpha
  6: 4, // truecolor + alpha
};

function parseHeader(buffer: Buffer): PngHeader {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngCodecError('not a PNG stream');
  }
  const ihdrLength = buffer.readUInt32BE(8);
  const ihdrType = buffer.subarray(12, 16);
  if (ihdrLength !== 13 || ihdrType.toString('latin1') !== 'IHDR') {
    throw new PngCodecError('IHDR must be the first chunk');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24] as number;
  const colorType = buffer[25] as number;
  const interlace = buffer[28] as number;
  if (width <= 0 || height <= 0) {
    throw new PngCodecError('empty PNG dimensions');
  }
  if (CHANNELS_BY_COLOR_TYPE[colorType] === undefined) {
    throw new PngCodecError(`unsupported PNG color type ${colorType}`);
  }
  if (interlace !== 0) {
    throw new PngCodecError('interlaced (Adam7) PNG is not supported');
  }
  return { width, height, bitDepth, colorType, interlace };
}

function sampleBitDepthOk(header: PngHeader): boolean {
  switch (header.colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(header.bitDepth);
    case 3:
      return [1, 2, 4, 8].includes(header.bitDepth);
    default:
      return [8, 16].includes(header.bitDepth);
  }
}

interface PngChunks {
  palette: Buffer | undefined;
  trns: Buffer | undefined;
  idat: Buffer;
}

function collectChunks(buffer: Buffer): PngChunks {
  const chunks: PngChunks = { palette: undefined, trns: undefined, idat: Buffer.alloc(0) };
  let pos = 8;
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (dataStart + length + 4 > buffer.length) {
      throw new PngCodecError('malformed PNG chunk length');
    }
    const data = buffer.subarray(dataStart, dataStart + length);
    if (type === 'PLTE') {
      if (data.length % 3 !== 0 || data.length > 256 * 3) {
        throw new PngCodecError('PNG palette exceeds 256 entries or is malformed');
      }
      chunks.palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      chunks.trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      chunks.idat = Buffer.concat([chunks.idat, data]);
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + length + 4; // skip CRC
  }
  return chunks;
}

/** Paeth predictor (PNG spec §6.3) — the a/b/c form, signed 8-bit. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

function unfilter(raw: Buffer, header: PngHeader, bpp: number): Buffer {
  const { width, height } = header;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    if (pos + 1 + stride > raw.length) {
      throw new PngCodecError('PNG pixel data truncated');
    }
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const outLine = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? (out[outLine + x - bpp] as number) : 0;
      const up = y > 0 ? (out[outLine - stride + x] as number) : 0;
      const upLeft = y > 0 && x >= bpp ? (out[outLine - stride + x - bpp] as number) : 0;
      let value = line[x] as number;
      switch (filter) {
        case 0:
          break;
        case 1:
          value = (value + left) & 0xff;
          break;
        case 2:
          value = (value + up) & 0xff;
          break;
        case 3:
          value = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          value = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new PngCodecError(`unsupported PNG filter type ${filter}`);
      }
      out[outLine + x] = value;
    }
  }
  return out;
}

/** Decode one PNG stream to 8-bit RGBA (see the module scope notes). */
export function decodePng(buffer: Buffer): RawImage {
  const header = parseHeader(buffer);
  if (!sampleBitDepthOk(header)) {
    throw new PngCodecError(`unsupported bit depth ${header.bitDepth} for color type ${header.colorType}`);
  }
  const { width, height, bitDepth, colorType } = header;
  const { palette, trns, idat } = collectChunks(buffer);
  if (idat.length === 0) {
    throw new PngCodecError('PNG carries no IDAT data');
  }
  const raw = inflateSync(idat);
  const bpp = (CHANNELS_BY_COLOR_TYPE[colorType] as number) * (bitDepth > 8 ? 2 : 1);
  const filtered = unfilter(raw, header, bpp);

  const out = Buffer.alloc(width * height * 4, 0xff);
  for (let y = 0; y < height; y += 1) {
    const lineStart = y * width * bpp;
    for (let x = 0; x < width; x += 1) {
      const src = lineStart + x * bpp;
      const dst = (y * width + x) * 4;
      if (colorType === 0) {
        // grayscale: sample → gray (16-bit sample takes the high byte)
        const s = bitDepth === 8 ? (filtered[src] as number) : bitDepth === 16 ? (filtered[src * 2] as number) : unpackAt(filtered, lineStart, x, bitDepth);
        out[dst] = s;
        out[dst + 1] = s;
        out[dst + 2] = s;
        out[dst + 3] = 0xff;
      } else if (colorType === 4) {
        const s = bitDepth === 8 ? (filtered[src] as number) : (filtered[src * 2] as number);
        const a = bitDepth === 8 ? (filtered[src + 1] as number) : (filtered[src * 2 + 2] as number);
        out[dst] = s;
        out[dst + 1] = s;
        out[dst + 2] = s;
        out[dst + 3] = a;
      } else if (colorType === 2) {
        for (let c = 0; c < 3; c += 1) {
          out[dst + c] = bitDepth === 8 ? (filtered[src + c] as number) : (filtered[(src + c) * 2] as number);
        }
        out[dst + 3] = 0xff;
      } else if (colorType === 6) {
        for (let c = 0; c < 3; c += 1) {
          out[dst + c] = bitDepth === 8 ? (filtered[src + c] as number) : (filtered[(src + c) * 2] as number);
        }
        out[dst + 3] = bitDepth === 8 ? (filtered[src + 3] as number) : (filtered[(src + 3) * 2] as number);
      } else {
        // palette index (depth 1/2/4/8)
        const index = bitDepth === 8 ? (filtered[src] as number) : unpackAt(filtered, lineStart, x, bitDepth);
        if (palette === undefined) {
          throw new PngCodecError('palette PNG carries no PLTE chunk');
        }
        const entry = index * 3;
        if (entry + 2 >= palette.length) {
          throw new PngCodecError(`palette index ${index} out of range`);
        }
        out[dst] = palette[entry] as number;
        out[dst + 1] = palette[entry + 1] as number;
        out[dst + 2] = palette[entry + 2] as number;
        out[dst + 3] = trns !== undefined && index < trns.length ? (trns[index] as number) : 0xff;
      }
    }
  }
  return { width, height, data: out };
}

/** Extract sample `x` from a low-bit-depth packed scanline. */
function unpackAt(filtered: Buffer, lineStart: number, x: number, bitDepth: number): number {
  const perByte = 8 / bitDepth;
  const byte = filtered[lineStart + (x / perByte | 0)] as number;
  const shift = 8 - bitDepth * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/** Chunk writer: length + type + data + CRC (node:zlib crc32). */
function writeChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode RGBA8 → PNG (color type 6, filter 0). */
export function encodePng(image: RawImage): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new PngCodecError('encodePng: raw buffer size mismatch');
  }
  // filter 0 per scanline: 1 filter byte + w*4 pixel bytes per row
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', deflateSync(raw, { level: 9 })),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}
