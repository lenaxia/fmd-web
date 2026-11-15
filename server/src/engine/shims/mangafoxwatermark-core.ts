import { decodePng, encodePng, type RawImage } from './png-codec.js';
import type { ImageDecoderBridge } from './imagepuzzle-core.js';

/**
 * fmd.mangafoxwatermark core — a line-by-line port of FMD2's
 * `baseunits/modules/MangaFoxWatermark.pas` (LoadTemplate :297-330,
 * RemoveWatermark :391-487 and their helpers), replacing the Lua binding
 * `baseunits/lua/LuaMangaFox.pas` (LoadTemplate/RemoveWatermark :16-31,
 * lib registration :41-52: require 'fmd.mangafoxwatermark').
 *
 * Algorithm ↔ Pascal line map:
 * | Operation                                            | MangaFoxWatermark.pas |
 * |------------------------------------------------------|-----------------------|
 * | OtsuThresholding (Single-precision histogram/bins)   | 139-181               |
 * | BuildImageToOneBit crop → gray → Otsu                | 185-252               |
 * |   CalculateGray() shr 8 (FCL fpimage.pp formula)     | 214                   |
 * | LoadTemplate: dir remember / exists / FindAllFiles   | 297-330               |
 * | ClearTemplate / FCleared flag                        | 271-283               |
 * | defaults MinPSNR=9.0 MinWhiteBorder=4                | Create :285-291       |
 * | CalculatePSNR (Single; differing bytes only)         | 384-402               |
 * | RemoveWatermark template/PSNR scan                   | 391-462               |
 * |   crop origin L=(W-Tw) div 2 / 0                     | 426-430               |
 * |   white-border validity (first 4*w bytes)            | 437-452               |
 * |   crop to H-Th and rewrite (DeleteFile order)        | 465-495               |
 *
 * Single-precision fidelity: the Pascal accumulators are `Single`
 * (32-bit) — every accumulator step here rounds through Math.fround so
 * Otsu thresholds and PSNR comparisons match FPC bit-for-bit on the
 * shipped templates.
 */

export interface OneBitImage {
  readonly width: number;
  /** Pascal spells it Heigth (MangaFoxWatermark.pas:59) — kept. */
  readonly heigth: number;
  /** 0/255 bytes, row-major (post-Otsu). */
  readonly bits: Buffer;
}

export interface WatermarkTemplate {
  readonly index: number;
  readonly source: string;
  readonly image: OneBitImage;
}

/** CalculateGray(AColor) shr 8 — FCL fpimage.pp: (r*77 + g*151 + b*28) shr 8
 * on 16-bit channels, then the call site shrinks again (:214). 8-bit
 * samples expand ×257 exactly as FPReadPNG does ((b shl 8) or b). */
export function grayByte(r: number, g: number, b: number): number {
  const r16 = r * 257;
  const g16 = g * 257;
  const b16 = b * 257;
  return ((r16 * 77 + g16 * 151 + b16 * 28) >>> 8) >>> 8;
}

/** MangaFoxWatermark.pas:139-181 — Otsu with Single accumulators. */
export function otsuThreshold(bits: Buffer): { threshold: number } {
  const histogram = new Array<number>(256).fill(0);
  for (let i = 0; i < bits.length; i += 1) {
    const sample = bits[i] as number;
    histogram[sample] = (histogram[sample] ?? 0) + 1;
  }
  const n = bits.length;
  const fr = Math.fround;
  let threshold = 0;
  let meanTotal = 0;
  let maxVariance = 0;
  let firstCumuMoment = 0;
  let zerothCumuMoment = 0;
  for (let i = 0; i <= 255; i += 1) {
    meanTotal = fr(meanTotal + fr((i * (histogram[i] as number)) / n));
  }
  for (let i = 0; i <= 255; i += 1) {
    zerothCumuMoment = fr(zerothCumuMoment + fr((histogram[i] as number) / n));
    firstCumuMoment = fr(firstCumuMoment + fr((i * (histogram[i] as number)) / n));
    let variance = fr(meanTotal * zerothCumuMoment - firstCumuMoment);
    variance = fr(variance * variance);
    if (zerothCumuMoment !== 0 && zerothCumuMoment !== 1) {
      variance = fr(variance / fr(zerothCumuMoment * fr(1 - zerothCumuMoment)));
      if (maxVariance < variance) {
        maxVariance = variance;
        threshold = i;
      }
    }
  }
  return { threshold };
}

/** MangaFoxWatermark.pas:177-181 — binarize > threshold ? 255 : 0. */
function binarize(bits: Buffer, threshold: number): void {
  for (let i = 0; i < bits.length; i += 1) {
    bits[i] = (bits[i] as number) > threshold ? 255 : 0;
  }
}

/**
 * MangaFoxWatermark.pas:185-252 — crop (Left/Top/Right/Bottom, negative =
 * image bound), gray bytes, Otsu. The out-of-bounds margin path
 * (:219-243) is unreachable for RemoveWatermark's crops (all edges
 * inside the image) and therefore not ported — asserted below.
 */
export function buildImageToOneBit(
  image: RawImage,
  left = -1,
  top = -1,
  right = -1,
  bottom = -1,
): OneBitImage {
  let l = left;
  let t = top;
  let r = right;
  let b = bottom;
  // :190-193
  if (l < 0 || l > image.width) l = 0;
  if (t < 0 || t > image.height) t = 0;
  // :194-195
  if (r < 0 || r <= l) r = image.width;
  if (b < 0 || b <= t) b = image.height;
  const width = r - l;
  const heigth = b - t;
  if (r > image.width || b > image.height) {
    throw new Error('BuildImageToOneBit: crop exceeds image (margin path not ported)');
  }
  const bits = Buffer.alloc(width * heigth);
  let pos = 0;
  // :214 — Bit^ := CalculateGray(Image.Colors[X, Y]) shr 8, row-major
  for (let y = t; y < b; y += 1) {
    for (let x = l; x < r; x += 1) {
      const p = (y * image.width + x) * 4;
      bits[pos] = grayByte(image.data[p] as number, image.data[p + 1] as number, image.data[p + 2] as number);
      pos += 1;
    }
  }
  const { threshold } = otsuThreshold(bits);
  binarize(bits, threshold);
  return { width, heigth, bits };
}

/** Decode any supported image file content (templates: the shipped PNGs). */
export function decodeImageBytes(bytes: Buffer, bridge: ImageDecoderBridge | undefined): RawImage | undefined {
  try {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return decodePng(bytes);
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      return bridge?.decodeJpeg(bytes);
    }
    return bridge?.decodeWebp(bytes);
  } catch {
    return undefined;
  }
}

/**
 * CalculatePSNR — MangaFoxWatermark.pas:384-402. MSE accumulates only
 * differing bytes (equal bytes contribute 0), Single precision; RMS
 * < 0.0001 → 1e6.
 */
export function calculatePSNR(a: OneBitImage, b: OneBitImage): number {
  const fr = Math.fround;
  if (a.bits.length !== b.bits.length) {
    return 0;
  }
  let mse = 0;
  for (let i = 0; i < a.bits.length; i += 1) {
    if ((a.bits[i] as number) !== (b.bits[i] as number)) {
      mse = fr(mse + fr(Math.abs((b.bits[i] as number) - (a.bits[i] as number)) ** 2));
    }
  }
  mse = fr(mse / a.bits.length);
  if (Math.sqrt(mse) < 0.0001) {
    return 1_000_000;
  }
  return fr(10 * Math.log10(fr(255 * 255) / mse));
}

/** The remover state (TWatermarkRemover field parity, :66-71/:285-291). */
export interface WatermarkRemoverState {
  templates: WatermarkTemplate[];
  templateDirectory: string;
  /** :314-315 FCleared starts True (Create :285-291). */
  cleared: boolean;
  minPSNR: number;
  minWhiteBorder: number;
}

export function createRemoverState(): WatermarkRemoverState {
  return { templates: [], templateDirectory: '', cleared: true, minPSNR: 9.0, minWhiteBorder: 4 };
}

/** :271-283 — ClearTemplate. */
export function clearTemplates(state: WatermarkRemoverState): void {
  state.templates = [];
  state.cleared = true;
}

/**
 * :297-330 — LoadTemplate(ADirectory): remember the dir (:300-302),
 * CleanAndExpandDirectory + DirectoryExists (:303-305), FindAllFiles
 * '*.*' non-recursive (:309), reload each file (:310-314). FMD2's file
 * order is the filesystem's FindFirst order; this port sorts names so
 * template order (first-max-PSNR wins, :454) is deterministic offline.
 */
export function loadTemplates(
  state: WatermarkRemoverState,
  directory: string,
  bridge: ImageDecoderBridge | undefined,
  listFiles: (dir: string) => readonly string[],
  readFile: (path: string) => Buffer,
  existsDir: (dir: string) => boolean,
): number {
  // :299 FCleared := False (before the dir checks)
  state.cleared = false;
  // :300-302
  if (directory !== '' && directory !== state.templateDirectory) {
    state.templateDirectory = directory;
  }
  // :303-304 (+ CleanAndExpandDirectory's trailing delimiter)
  if (state.templateDirectory === '') {
    return 0;
  }
  const dir = cleanAndExpandDirectory(state.templateDirectory);
  if (!existsDir(dir)) {
    return 0;
  }
  // :308-309 — ClearTemplate inside the load (re-sets FCleared, :311
  // re-clears it to False again)
  clearTemplates(state);
  state.cleared = false;
  const files = listFiles(dir);
  if (files.length === 0) {
    return 0;
  }
  let count = 0;
  for (const file of files) {
    try {
      const decoded = decodeImageBytes(readFile(file), bridge);
      if (decoded === undefined) {
        continue; // AddFileToTemplates False (:316)
      }
      const oneBit = buildImageToOneBit(decoded); // :318
      state.templates.push({ index: state.templates.length, source: file, image: oneBit });
      count += 1; // :319
    } catch {
      continue; // decode failure → template skipped
    }
  }
  return count;
}

/** LazFileUtils.CleanAndExpandDirectory — append the trailing delimiter. */
export function cleanAndExpandDirectory(dir: string): string {
  const normalized = dir.replaceAll('\\', '/');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export interface RemoveWatermarkOutcome {
  readonly ok: boolean;
  /** The rewritten file path (Pascal NewFileName) when ok. */
  readonly newFileName?: string;
  /** Diagnostic: which template matched (index + PSNR). */
  readonly matchedTemplate?: number;
  readonly matchedPSNR?: number;
}

export interface RemoveWatermarkFs {
  readFile(path: string): Buffer;
  deleteFile(path: string): void;
  fileExists(path: string): boolean;
  writeOrReplace(path: string, bytes: Buffer): void;
  stripExtension(path: string): string;
  /** GetImageHandlerByFile().Ext — '' when the extension is unknown. */
  writerExtension(path: string): string | undefined;
}

/**
 * :391-487 — RemoveWatermark(AFileName, SaveAsPNG). Returns the outcome;
 * the caller maps ok → the Lua boolean (LuaMangaFox.pas:24-31).
 */
export function removeWatermark(
  state: WatermarkRemoverState,
  fileName: string,
  saveAsPNG: boolean,
  bridge: ImageDecoderBridge | undefined,
  fs: RemoveWatermarkFs,
): RemoveWatermarkOutcome {
  // :395-401 — precondition: templates loaded. The lazy-load branch
  // (:400 LoadTemplate → recheck) is the SHIM's responsibility (it owns
  // the fs callbacks); an empty set here means the load already ran and
  // found nothing.
  if (state.templates.length === 0) {
    return { ok: false }; // :401
  }
  // :403-404 — GetImageHandlerByFile: unknown extension → false
  const writerExt = fs.writerExtension(fileName);
  if (writerExt === undefined) {
    return { ok: false };
  }
  let image: RawImage;
  try {
    const decoded = decodeImageBytes(fs.readFile(fileName), bridge);
    if (decoded === undefined) {
      return { ok: false };
    }
    image = decoded;
  } catch {
    return { ok: false };
  }
  let bestIndex = -1;
  let bestValue = 0;
  // :424-461 — the template scan
  for (const template of state.templates) {
    if (image.height < template.image.heigth) {
      continue; // :424
    }
    // :426-430 — centered horizontal crop origin
    const l = image.width > template.image.width ? Math.floor((image.width - template.image.width) / 2) : 0;
    const r = l + template.image.width; // :431
    const t = image.height - template.image.heigth; // :432
    const b = image.height; // :433
    const cropped = buildImageToOneBit(image, l, t, r, b); // :434
    // :437-452 — the first MinWhiteBorder * Width bytes must be white
    let invalidBorder = false;
    if (state.minWhiteBorder > 0) {
      const checkBytes = state.minWhiteBorder * cropped.width;
      for (let i = 0; i < checkBytes; i += 1) {
        if ((cropped.bits[i] as number) === 0) {
          invalidBorder = true;
          break;
        }
      }
    }
    if (invalidBorder) {
      continue;
    }
    const psnr = calculatePSNR(cropped, template.image); // :453
    if (psnr > bestValue) {
      bestValue = psnr;
      bestIndex = template.index;
    }
  }
  // :465 — BestValue >= MinPSNR
  if (bestValue < state.minPSNR || bestIndex === -1) {
    return { ok: false };
  }
  const template = state.templates[bestIndex];
  if (template === undefined) {
    return { ok: false };
  }
  // :467-471 — the image minus the template band
  const croppedImage: RawImage = {
    width: image.width,
    height: image.height - template.image.heigth,
    data: Buffer.from(
      image.data.subarray(0, croppedImageLength(image.width, image.height - template.image.heigth)),
    ),
  };
  // :472-474 — SaveAsPNG overrides the writer
  const outExt = saveAsPNG ? 'png' : writerExt;
  // :476 — ExtractFileNameWithoutExt(AFileName) + '.' + WExt
  const newFileName = `${fs.stripExtension(fileName)}.${outExt}`;
  // :477-478 — delete original, then existing target
  fs.deleteFile(fileName);
  if (fs.fileExists(newFileName)) {
    fs.deleteFile(newFileName);
  }
  // :480-492 — write
  const bytes =
    outExt === 'png'
      ? encodePng(croppedImage)
      : bridge?.encodeJpeg(croppedImage, 75);
  if (bytes === undefined || fs.fileExists(newFileName)) {
    return { ok: false };
  }
  fs.writeOrReplace(newFileName, bytes);
  const ok = fs.fileExists(newFileName); // :493 Result := FileExists(...)
  return ok
    ? { ok: true, newFileName, matchedTemplate: bestIndex, matchedPSNR: bestValue }
    : { ok: false };
}

function croppedImageLength(width: number, height: number): number {
  return width * height * 4;
}
