import { decodePng, encodePng, type RawImage } from './png-codec.js';

/**
 * fmd.imagepuzzle core — a line-by-line port of FMD2's
 * `baseunits/ImagePuzzle.pas` DeScramble (lines 136-305) over raw RGBA
 * buffers. The Lua binding it replaces is `baseunits/lua/LuaImagePuzzle.pas`
 * (New/Create :73-77, HorBlock/VerBlock read-only :78-82,
 * Matrix[]/Flips[] read-write :83-87, DeScramble :88-91, Multiply :99).
 *
 * Why a port and not a re-approximation: the Pascal algorithm has NO
 * GDI+-dependent semantics — TLazIntfImage[riqfRGB, riqfAlpha] is a flat
 * 32-bit pixel buffer (ImagePuzzle.pas:195, 220, 230), the prefill is a
 * literal FillChar 255 (:231-234), and every geometry decision is integer
 * arithmetic (`div`/`Trunc`, :236-262) that JS expresses exactly. The only
 * replaceable layer is codec I/O (WebPToMemBitmap :183, TPicture
 * :204-221, SaveToStreamWithFileExt :296) — injected here as
 * {@link ImageDecoderBridge} (offline: PNG via png-codec.ts; JPEG/WebP via
 * the optional headless-Chromium bridge; sharp itself is NOT installable
 * in this offline workspace — deviation documented in
 * docs/evidence-shims-image.md).
 *
 * Operation ↔ Pascal line map (every branch of DeScramble):
 * | Operation          | ImagePuzzle.pas |
 * |--------------------|-----------------|
 * | Create(w,h): Matrix[i]:=i identity, Flips[i]:=0          | 32-44  |
 * | GetFlip bounds → 0                                       | 46-56  |
 * | null stream guard                                        | 159-162|
 * | `Matrix is not set` / `Invalid matrix size` fail         | 163-172|
 * | memStream snapshot of input (in-place safety)            | 180    |
 * | WebP probe → ext='png'                                   | 183-199|
 * | `invalid webp size` fail                                 | 190-194|
 * | TPicture decode; png graphic → ext='png' else 'jpg'      | 203-208|
 * | `could not decode image` fail                            | 209-213|
 * | 32-bit requirement (`could not obtain 32bit pixel data`) | 224-228|
 * | dstIntf every line FillChar 255 (white/opaque)           | 230-234|
 * | Multiply<=1: blockWidth := width div HorBlock            | 236-239|
 * | Multiply>1 : Trunc(width div (HorBlock*Multiply))*Mult   | 241-245|
 * | Matrix[i] range fail `Matrix[%d]=%d out of range`        | 248-252|
 * | dest row/col := Matrix[i] div/mod HorBlock               | 253-254|
 * | dx1/dy1/dx2/dy2 := Trunc(col*blockWidth)…                | 255-258|
 * | src row/col := i div/mod HorBlock (sx1/sy1)              | 259-262|
 * | tileWidth/tileHeight; skip <=0 tiles                     | 263-268|
 * | flags := GetFlip(i); &2 → vertical source flip           | 269-276|
 * | &1 → per-pixel horizontal mirror copy                    | 279-284|
 * | else row Move of tileWidth*4 bytes                       | 287-288|
 * | output.Position/Size := 0 then encode with ext           | 294-296|
 * | LogAndFail: log + EMPTY THE OUTPUT STREAM                | 151-156|
 */

/**
 * Codec seam (sharp-shaped raw interface). decode* return undefined on
 * format/decoder failure — the caller maps that onto the Pascal
 * `could not decode image` path.
 */
export interface ImageDecoderBridge {
  decodeWebp(bytes: Buffer): RawImage | undefined;
  decodeJpeg(bytes: Buffer): RawImage | undefined;
  /** FPWriteJPEG default quality is 75; the encoder itself differs from
   * FCL's (documented — the lossless paths carry the pixel-exact claims). */
  encodeJpeg(image: RawImage, quality: number): Buffer | undefined;
}

export interface ImagePuzzleParams {
  readonly horBlock: number;
  readonly verBlock: number;
  /** Pascal FMultiply (Create leaves 1; LuaImagePuzzle.pas:99 writable). */
  readonly multiply: number;
  /** Materialized Matrix[0..horBlock*verBlock-1] (Create seeds identity). */
  readonly matrix: readonly number[];
  /** Materialized Flips[0..horBlock*verBlock-1] (Create seeds 0). */
  readonly flips: readonly number[];
}

export type DescrambleOutcome =
  | { readonly ok: true; readonly output: Buffer; readonly ext: 'png' | 'jpg' }
  | { readonly ok: false; readonly reason: string };

/** Pascal LogAndFail message prefix — `Self.ClassName + '.DeScramble: '`. */
export const DESCRAMBLE_LOG_PREFIX = 'TImagePuzzle.DeScramble: ';

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `WebPToMemBitmap` probe — RIFF….WEBP container magic (ImagePuzzle.pas:183). */
export function looksLikeWebp(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  );
}

/** JPEG SOI/EOI markers (TPicture's TFPReaderJPEG path, ImagePuzzle.pas:204). */
export function looksLikeJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * The DeScramble port. `input` is the caller's stream snapshot (Pascal
 * copies the stream into a TMemoryStream at :180 FIRST, which is exactly
 * what makes same-stream in-place calls safe — the copy happens before
 * any output write, so MangaGo.lua:264's DeScramble(doc, doc) reads a
 * stable snapshot). On failure the caller replicates LogAndFail's
 * observable behavior: log `TImagePuzzle.DeScramble: <reason>` and empty
 * the output stream (:151-156).
 */
export function descrambleBytes(
  input: Buffer,
  params: ImagePuzzleParams,
  bridge: ImageDecoderBridge,
): DescrambleOutcome {
  const { horBlock, verBlock, multiply, matrix, flips } = params;
  const fail = (reason: string): DescrambleOutcome => ({ ok: false, reason });

  // :163-167 / :168-172 — matrix guards (Length(FMatrix) is fixed at
  // Create; the materialized array mirrors that exactly).
  if (matrix.length === 0) {
    return fail('Matrix is not set');
  }
  if (matrix.length < horBlock * verBlock) {
    return fail('Invalid matrix size');
  }

  // Decode to a 32-bit RGBA working buffer (:180-228).
  let src: RawImage;
  let ext: 'png' | 'jpg';
  if (looksLikeWebp(input)) {
    // :183-199 — WebPToMemBitmap success ⇒ ext='png'
    const decoded = bridge.decodeWebp(input);
    if (decoded !== undefined) {
      if (decoded.width <= 0 || decoded.height <= 0) {
        // :190-194
        return fail('invalid webp size');
      }
      src = decoded;
      ext = 'png';
    } else {
      // decode failure ⇒ TPicture would fail too (:209-213)
      return fail('could not decode image');
    }
  } else if (input.subarray(0, 8).equals(PNG_MAGIC)) {
    // :204-208 — TPortableNetworkGraphic ⇒ ext='png'
    try {
      src = decodePng(input);
    } catch {
      return fail('could not decode image');
    }
    ext = 'png';
  } else if (looksLikeJpeg(input)) {
    // :204-208 — any other TPicture-decodable graphic, default ext='jpg'
    const decoded = bridge.decodeJpeg(input);
    if (decoded === undefined) {
      return fail('could not decode image');
    }
    src = decoded;
    ext = 'jpg';
  } else {
    // :209-213 — no registered handler could decode the stream
    return fail('could not decode image');
  }

  const width = src.width;
  const height = src.height;
  // :224-228 — the working buffers are always 32-bit RGBA by construction.
  const rgba = src.data;

  // :230-234 — dstIntf prefill: every byte 255 (opaque white).
  const dst = Buffer.alloc(width * height * 4, 0xff);

  // :236-245 — block geometry. Pascal stores these in Double variables but
  // every expression is integer arithmetic (`div`, then Trunc of an exact
  // integer), so JS integer math reproduces them bit-for-bit.
  let blockWidth: number;
  let blockHeight: number;
  if (multiply <= 1) {
    blockWidth = Math.floor(width / horBlock); // width div HorBlock (:238)
    blockHeight = Math.floor(height / verBlock); // height div VerBlock (:239)
  } else {
    blockWidth = Math.floor(width / (horBlock * multiply)) * multiply; // (:243)
    blockHeight = Math.floor(height / (verBlock * multiply)) * multiply; // (:244)
  }

  // :246-291 — the tile loop (source block i → destination Matrix[i]).
  for (let i = 0; i < horBlock * verBlock; i += 1) {
    const destIndex = matrix[i] as number;
    if (destIndex < 0 || destIndex >= horBlock * verBlock) {
      // :248-252 — Format('Matrix[%d]=%d out of range', [i, Matrix[i]])
      return fail(`Matrix[${i}]=${destIndex} out of range`);
    }
    let row = Math.floor(destIndex / horBlock); // :253 Matrix[i] div HorBlock
    let col = destIndex % horBlock; // :254 Matrix[i] mod HorBlock
    const dx1 = Math.trunc(col * blockWidth); // :255
    const dy1 = Math.trunc(row * blockHeight); // :256
    const dx2 = Math.trunc((col + 1) * blockWidth); // :257
    const dy2 = Math.trunc((row + 1) * blockHeight); // :258
    row = Math.floor(i / horBlock); // :259 i div HorBlock
    col = i % horBlock; // :260 i mod HorBlock
    const sx1 = Math.trunc(col * blockWidth); // :261
    const sy1 = Math.trunc(row * blockHeight); // :262
    const tileWidth = dx2 - dx1; // :263
    const tileHeight = dy2 - dy1; // :264
    if (tileWidth <= 0 || tileHeight <= 0) {
      continue; // :265-268
    }
    // :269 + :46-56 — GetFlip: out-of-range index → 0
    const flags = i >= 0 && i < flips.length ? flips[i] as number : 0;
    for (let k = 0; k < tileHeight; k += 1) {
      // :270-276 — flags bit 1 (value 2) flips the source rows vertically
      const srcRow = (flags & 2) !== 0 ? sy1 + (tileHeight - 1 - k) : sy1 + k;
      const srcOff = (srcRow * width + sx1) * 4; // :277 srcLine
      const dstOff = ((dy1 + k) * width + dx1) * 4; // :278 dstLine
      if ((flags & 1) !== 0) {
        // :279-284 — horizontal mirror: dst[x] = src[tileWidth-1-x]
        for (let x = 0; x < tileWidth; x += 1) {
          const s = srcOff + (tileWidth - 1 - x) * 4;
          rgba.copy(dst, dstOff + x * 4, s, s + 4);
        }
      } else {
        // :287-288 — Move(srcLine^, dstLine^, tileWidth * 4)
        rgba.copy(dst, dstOff, srcOff, srcOff + tileWidth * 4);
      }
    }
  }

  // :293-296 — encode with the selected extension.
  const encoded =
    ext === 'png'
      ? encodePng({ width, height, data: dst })
      : bridge.encodeJpeg({ width, height, data: dst }, 75);
  if (encoded === undefined) {
    return fail('could not encode image');
  }
  return { ok: true, output: encoded, ext };
}
