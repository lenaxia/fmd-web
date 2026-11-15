import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryLogger, type MemoryLogger } from '../../../src/engine/lua/logger.js';
import { createLuaHost, type WasmoonLuaHost } from '../../../src/engine/lua/host.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../../src/engine/lua/abort.js';
import { installShims, FMD2_LUA_ROOT, type InstalledShims } from '../../../src/engine/shims/install.js';
import { RecordedResponseResolver } from '../../../src/engine/shims/http-shim.js';
import type { HttpDocument } from '../../../src/engine/shims/http-pipeline.js';
import { decodePng, encodePng, type RawImage } from '../../../src/engine/shims/png-codec.js';
import {
  descrambleBytes,
  DESCRAMBLE_LOG_PREFIX,
  looksLikeWebp,
  type ImageDecoderBridge,
} from '../../../src/engine/shims/imagepuzzle-core.js';

/**
 * fmd.imagepuzzle proofs (audit bucket B):
 * 1. CORE — the ImagePuzzle.pas:136-305 port semantics (geometry, flips,
 *    Multiply, remainder-band white, validation messages, ext selection,
 *    LogAndFail output-empty behavior) over raw pixels.
 * 2. GOLDENS — ≥3 real-site descramble fixtures (corpus/fixtures/
 *    imagepuzzle/) come out PIXEL-IDENTICAL to the captured clean page,
 *    including a non-square grid (18Comic 1×6) and the Multiply geometry
 *    (TonarinoYoungJump 4×4×8). Fixture provenance (synthesized offline,
 *    disclosed) lives in the per-site manifest.json +
 *    docs/evidence-shims-image.md.
 * 3. LUA — the real wasmoon surface: require 'fmd.imagepuzzle' through
 *    installShims, Matrix[]/Flips[]/Multiply assignment, the IN-PLACE
 *    same-Document DeScramble (MangaGo.lua:264, 18Comic.lua:106), exact
 *    validation log lines, and the silent Assigned-guard no-op.
 */

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const GOLDENS = join(ROOT, 'corpus', 'fixtures', 'imagepuzzle');

/** The offline stub bridge: PNG leg works, JPEG/WebP/encode absent. */
const NO_BRIDGE: ImageDecoderBridge = {
  decodeWebp: () => undefined,
  decodeJpeg: () => undefined,
  encodeJpeg: () => undefined,
};

function solidImage(width: number, height: number, rgba: (x: number, y: number) => readonly [number, number, number, number]): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = rgba(x, y);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  }
  return { width, height, data };
}

function pixel(image: RawImage, x: number, y: number): readonly [number, number, number, number] {
  const p = (y * image.width + x) * 4;
  return [image.data[p] as number, image.data[p + 1] as number, image.data[p + 2] as number, image.data[p + 3] as number];
}

describe('imagepuzzle core — ImagePuzzle.pas port semantics', () => {
  it('identity Matrix leaves the grid content untouched (:32-44 identity, :246-291 copy)', () => {
    const src = solidImage(6, 6, (x, y) => [x * 40, y * 40, 7, 255]);
    const out = descrambleBytes(
      encodePng(src),
      { horBlock: 3, verBlock: 3, multiply: 1, matrix: [0, 1, 2, 3, 4, 5, 6, 7, 8], flips: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
      NO_BRIDGE,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const got = decodePng(out.output);
    // 6 div 3 = 2px tiles → the full 6×6 image is grid-covered
    expect(got.data.equals(src.data)).toBe(true);
  });

  it('the remainder band outside the grid is 0xFF white (:230-234 dstIntf prefill)', () => {
    // 10×10 with a 3×3 grid: blockWidth/Height = 10 div 3 = 3 → tiles cover
    // 9×9; row/column 9 are unreachable and must decode as opaque white.
    const src = solidImage(10, 10, () => [10, 20, 30, 255]);
    const identity = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const out = descrambleBytes(encodePng(src), { horBlock: 3, verBlock: 3, multiply: 1, matrix: identity, flips: identity.map(() => 0) }, NO_BRIDGE);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const got = decodePng(out.output);
    expect(pixel(got, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(pixel(got, 8, 8)).toEqual([10, 20, 30, 255]);
    expect(pixel(got, 9, 9)).toEqual([255, 255, 255, 255]);
    expect(pixel(got, 9, 4)).toEqual([255, 255, 255, 255]);
    expect(pixel(got, 4, 9)).toEqual([255, 255, 255, 255]);
  });

  it('Flips bit 2 (value 2) flips the block vertically; bit 1 (value 1) mirrors horizontally (:269-288)', () => {
    // 1×2 vertical grid over 4×8: two 4×4 blocks, top rows tinted, bottom rows blue.
    const src = solidImage(4, 8, (_x, y) => (y < 4 ? [y * 60, 0, 0, 255] : [0, 0, (y - 4) * 60, 255]));
    const flips = [2, 0]; // vertical-flip the first (top) block only
    const out = descrambleBytes(encodePng(src), { horBlock: 1, verBlock: 2, multiply: 1, matrix: [0, 1], flips }, NO_BRIDGE);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const got = decodePng(out.output);
    // top block content flipped vertically: row y shows source row 3-(y-0)
    expect(pixel(got, 0, 0)).toEqual([3 * 60, 0, 0, 255]);
    expect(pixel(got, 0, 3)).toEqual([0, 0, 0, 255]);
    // second block untouched
    expect(pixel(got, 0, 4)).toEqual([0, 0, 0, 255]);
    expect(pixel(got, 0, 7)).toEqual([0, 0, 3 * 60, 255]);

    // horizontal mirror: 2×1 grid, mirror the first (left) block
    const src2 = solidImage(8, 2, (x) => [x * 30, 5, 5, 255]);
    const out2 = descrambleBytes(encodePng(src2), { horBlock: 2, verBlock: 1, multiply: 1, matrix: [0, 1], flips: [1, 0] }, NO_BRIDGE);
    expect(out2.ok).toBe(true);
    if (!out2.ok) return;
    const got2 = decodePng(out2.output);
    // left block mirrored: dest x shows source x' = 3 - x
    expect(pixel(got2, 0, 0)).toEqual([3 * 30, 5, 5, 255]);
    expect(pixel(got2, 3, 0)).toEqual([0, 5, 5, 255]);
    expect(pixel(got2, 4, 0)).toEqual([4 * 30, 5, 5, 255]);
  });

  it('Multiply > 1 uses Trunc(width div (HorBlock*Multiply))*Multiply geometry (:241-245)', () => {
    // 64×64, 4×4 grid, Multiply=2 → blockWidth = floor(64/8)*2 = 16
    const src = solidImage(64, 64, (x, y) => [x, y, 0, 255]);
    const transpose: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      transpose.push((i % 4) * 4 + Math.floor(i / 4));
    }
    const out = descrambleBytes(encodePng(src), { horBlock: 4, verBlock: 4, multiply: 2, matrix: transpose, flips: transpose.map(() => 0) }, NO_BRIDGE);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const got = decodePng(out.output);
    // block (0,0) of the transpose: source block at i=0 goes to dest 0 — the
    // transpose moves (i,j)→(j,i). Descrambled pixel (16..31, 0..15) holds
    // source block row j=1,col=0 → source (0..15, 16..31).
    // transpose invariant: dest block (col,row) ← src block (row,col).
    // Dest block index 1 = (col 1, row 0) comes from src block (col 0, row 1):
    // pixel (16,0) must equal source pixel (0,16) — and differ from (16,0).
    expect(pixel(got, 16, 0)).toEqual(pixel(src, 0, 16));
    expect(pixel(got, 16, 0)).not.toEqual(pixel(src, 16, 0));
    expect(pixel(got, 0, 0)).toEqual(pixel(src, 0, 0));
  });

  it('validation failures reproduce the exact Pascal messages (:163-172, :248-252)', () => {
    const src = solidImage(4, 4, () => [1, 2, 3, 255]);
    const empty = descrambleBytes(encodePng(src), { horBlock: 0, verBlock: 0, multiply: 1, matrix: [], flips: [] }, NO_BRIDGE);
    expect(empty).toEqual({ ok: false, reason: 'Matrix is not set' });

    const short = descrambleBytes(encodePng(src), { horBlock: 2, verBlock: 2, multiply: 1, matrix: [0, 1], flips: [0, 0] }, NO_BRIDGE);
    expect(short).toEqual({ ok: false, reason: 'Invalid matrix size' });

    const oob = descrambleBytes(encodePng(src), { horBlock: 2, verBlock: 2, multiply: 1, matrix: [0, 1, 99, 3], flips: [0, 0, 0, 0] }, NO_BRIDGE);
    expect(oob).toEqual({ ok: false, reason: 'Matrix[2]=99 out of range' });
  });

  it('undecodable input takes the Pascal could-not-decode path (:209-213); ext selection png→png (:205-208)', () => {
    const bytes = Buffer.from('this is not an image at all', 'utf8');
    expect(descrambleBytes(bytes, { horBlock: 1, verBlock: 1, multiply: 1, matrix: [0], flips: [0] }, NO_BRIDGE)).toEqual({
      ok: false,
      reason: 'could not decode image',
    });
    // JPEG magic without the Chromium bridge → the TPicture leg fails too
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(descrambleBytes(jpegMagic, { horBlock: 1, verBlock: 1, multiply: 1, matrix: [0], flips: [0] }, NO_BRIDGE)).toEqual({
      ok: false,
      reason: 'could not decode image',
    });
    // webp magic probe mirrors WebPToMemBitmap's container check (:183)
    const webpMagic = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
    expect(looksLikeWebp(webpMagic)).toBe(true);
    expect(descrambleBytes(webpMagic, { horBlock: 1, verBlock: 1, multiply: 1, matrix: [0], flips: [0] }, NO_BRIDGE)).toEqual({
      ok: false,
      reason: 'could not decode image',
    });
  });

  it('GetFlip out-of-range reads 0 (:46-56)', () => {
    const src = solidImage(4, 4, (x, y) => [x * 60, y * 60, 0, 255]);
    // flips array shorter than the grid: index 3 reads 0 (identity placement)
    const out = descrambleBytes(encodePng(src), { horBlock: 2, verBlock: 2, multiply: 1, matrix: [0, 1, 2, 3], flips: [0, 0, 0] }, NO_BRIDGE);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(decodePng(out.output).data.equals(src.data)).toBe(true);
  });
});

describe('imagepuzzle goldens — real-site descramble fixtures (pixel-identical)', () => {
  interface GoldenCase {
    readonly site: string;
    readonly nonSquare: boolean;
  }
  const cases: readonly GoldenCase[] = [
    { site: 'MangaGo', nonSquare: false },
    { site: '18Comic', nonSquare: true },
    { site: 'TonarinoYoungJump', nonSquare: false },
  ];

  for (const { site, nonSquare } of cases) {
    it(`${site}: descrambled output is pixel-identical to the captured clean page${nonSquare ? ' (non-square grid)' : ''}`, () => {
      const dir = join(GOLDENS, site);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
        horBlock: number;
        verBlock: number;
        multiply: number;
        matrix: number[];
        flips: number[];
      };
      const scrambledBytes = readFileSync(join(dir, 'scrambled.png'));
      const expected = decodePng(readFileSync(join(dir, 'expected.png')));
      const out = descrambleBytes(
        scrambledBytes,
        {
          horBlock: manifest.horBlock,
          verBlock: manifest.verBlock,
          multiply: manifest.multiply,
          matrix: manifest.matrix,
          flips: manifest.flips,
        },
        NO_BRIDGE,
      );
      expect(out.ok, `descramble failed: ${!out.ok ? out.reason : ''}`).toBe(true);
      if (!out.ok) return;
      expect(out.ext).toBe('png');
      const got = decodePng(out.output);
      expect(got.width).toBe(expected.width);
      expect(got.height).toBe(expected.height);
      // pixel-identical (0-LSB) — the strict criterion
      expect(got.data.equals(expected.data)).toBe(true);
    });
  }
});

describe('imagepuzzle Lua surface — real wasmoon state through installShims', () => {
  const hosts: WasmoonLuaHost[] = [];

  afterAll(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.dispose()));
  });

  async function openLua(): Promise<{
    run: (code: string) => unknown;
    documents: Map<number, HttpDocument>;
    logger: MemoryLogger;
  }> {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    hosts.push(host);
    await host.chunkCache.get('__imagepuzzle_probe.lua', 'function Init() end');
    const abort = new DeadlineAbortHandle(createDeadlineCells());
    const resolver = new RecordedResponseResolver([]);
    const engine = await host.createEngine();
    let kit: InstalledShims | undefined;
    await engine.loadModule('__imagepuzzle_probe.lua', (inner, bridge) => {
      kit = installShims(inner, bridge, { resolver, abort, logger, moduleId: 'imagepuzzle-probe', luaRoot: FMD2_LUA_ROOT });
      bridge.create('HTTP', kit.makeHTTP());
    });
    if (kit === undefined) {
      throw new Error('shim install did not run');
    }
    return {
      run: (code: string) => engine.innerEngine.doStringSync(code),
      documents: kit.documents,
      logger,
    };
  }

  function lastDocument(documents: Map<number, HttpDocument>) {
    const ids = [...documents.keys()];
    expect(ids.length).toBeGreaterThan(0);
    return documents.get(ids[ids.length - 1] as number) as NonNullable<ReturnType<typeof documents.get>>;
  }

  it("require 'fmd.imagepuzzle' resolves with New/Create (registry row)", async () => {
    const { run } = await openLua();
    const lib = run(`return require 'fmd.imagepuzzle'`) as Record<string, unknown>;
    expect(typeof lib['New']).toBe('function');
    expect(typeof lib['Create']).toBe('function');
  });

  it('MangaGo.lua:250-264 pattern IN-PLACE: same-Document DeScramble restores the clean page', async () => {
    const { run, documents } = await openLua();
    const dir = join(GOLDENS, 'MangaGo');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const doc = lastDocument(documents);
    doc.setBytes(readFileSync(join(dir, 'scrambled.png')));

    // the exact module code shape (MangaGo.lua DownloadImage), with the
    // fixture's key standing in for the page desckey
    const keyCsv = (manifest.matrix as number[]).join(',');
    const result = run(`
      local cols = ${manifest.horBlock}
      local key = { ${keyCsv} }
      local puzzle = require 'fmd.imagepuzzle'.Create(cols, cols)
      for i = 1, #key do
        puzzle.Matrix[i - 1] = key[i]
      end
      puzzle.DeScramble(HTTP.Document, HTTP.Document)
      return HTTP.Document.Size
    `) as number;

    const expected = decodePng(readFileSync(join(dir, 'expected.png')));
    expect(result).toBeGreaterThan(0);
    const got = decodePng(Buffer.from(doc.bytes));
    expect(got.width).toBe(expected.width);
    expect(got.height).toBe(expected.height);
    expect(got.data.equals(expected.data)).toBe(true);
  });

  it('18Comic.lua:99-106 pattern IN-PLACE: non-square 1×rows grid, in-place same-Document', async () => {
    const { run, documents } = await openLua();
    const dir = join(GOLDENS, '18Comic');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const doc = lastDocument(documents);
    doc.setBytes(readFileSync(join(dir, 'scrambled.png')));

    const result = run(`
      local rows = ${manifest.verBlock}
      local puzzle = require('fmd.imagepuzzle').Create(1, rows)
      for i = 0, rows - 1 do
        puzzle.Matrix[i] = rows - 1 - i
      end
      puzzle.DeScramble(HTTP.Document, HTTP.Document)
      return HTTP.Document.Size
    `) as number;

    const expected = decodePng(readFileSync(join(dir, 'expected.png')));
    expect(result).toBeGreaterThan(0);
    const got = decodePng(Buffer.from(doc.bytes));
    expect(got.data.equals(expected.data)).toBe(true);
  });

  it('TonarinoYoungJump.lua:93-99 pattern: Multiply = 8 + transpose matrix', async () => {
    const { run, documents } = await openLua();
    const dir = join(GOLDENS, 'TonarinoYoungJump');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const doc = lastDocument(documents);
    doc.setBytes(readFileSync(join(dir, 'scrambled.png')));

    run(`
      local fragmentSize = ${manifest.horBlock}
      local puzzle = require('fmd.imagepuzzle').Create(fragmentSize, fragmentSize)
      puzzle.Multiply = ${manifest.multiply}
      for i = 0, (fragmentSize * fragmentSize) - 1 do
        puzzle.Matrix[i] = (i % fragmentSize) * fragmentSize + (i // fragmentSize)
      end
      puzzle.DeScramble(HTTP.Document, HTTP.Document)
    `);

    const expected = decodePng(readFileSync(join(dir, 'expected.png')));
    const got = decodePng(Buffer.from(doc.bytes));
    expect(got.data.equals(expected.data)).toBe(true);
  });

  it('HorBlock/VerBlock read-only; Multiply writable; Flips readable (:78-99)', async () => {
    const { run } = await openLua();
    const result = run(`
      local puzzle = require 'fmd.imagepuzzle'.New(3, 4)
      puzzle.Multiply = 8
      puzzle.HorBlock = 99      -- read-only: dropped (no setter registered)
      puzzle.VerBlock = 99      -- read-only: dropped
      return { h = puzzle.HorBlock, v = puzzle.VerBlock, m = puzzle.Multiply, f0 = puzzle.Flips[0], m0 = puzzle.Matrix[0] }
    `) as Record<string, number>;
    expect(result['h']).toBe(3);
    expect(result['v']).toBe(4);
    expect(result['m']).toBe(8);
    expect(result['f0']).toBe(0);
    expect(result['m0']).toBe(0);
  });

  it('validation failure logs the exact line and EMPTIES the output (LogAndFail :151-156)', async () => {
    const { run, documents, logger } = await openLua();
    const dir = join(GOLDENS, 'MangaGo');
    const doc = lastDocument(documents);
    doc.setBytes(readFileSync(join(dir, 'scrambled.png')));
    run(`
      local puzzle = require 'fmd.imagepuzzle'.Create(2, 2)
      puzzle.Matrix[0] = 99
      puzzle.DeScramble(HTTP.Document, HTTP.Document)
    `);
    expect(doc.size).toBe(0); // output.Size := 0 (:154-155)
    const messages = logger.records.map((l) => l.message).join('\n');
    expect(messages).toContain(`${DESCRAMBLE_LOG_PREFIX}Matrix[0]=99 out of range`);
  });

  it('non-stream arguments exit silently (Assigned guard :159-162) — the document is untouched', async () => {
    const { run, documents } = await openLua();
    const dir = join(GOLDENS, '18Comic');
    const doc = lastDocument(documents);
    const original = readFileSync(join(dir, 'scrambled.png'));
    doc.setBytes(original);
    run(`
      local puzzle = require 'fmd.imagepuzzle'.Create(1, 2)
      puzzle.DeScramble(HTTP.Document, nil)        -- dst not a stream
      puzzle.DeScramble('not a stream', HTTP.Document) -- src not a stream
    `);
    expect(Buffer.from(doc.bytes).equals(original)).toBe(true);
  });
});
