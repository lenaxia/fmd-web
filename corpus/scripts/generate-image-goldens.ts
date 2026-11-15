import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, type RawImage } from '../../server/src/engine/shims/png-codec.js';

/**
 * Deterministic imagepuzzle golden generator (offline, no network): builds
 * the corpus/fixtures/imagepuzzle/<Site>/{scrambled.png,expected.png,manifest.json}
 * triples. Rerun with `npx tsx corpus/scripts/generate-image-goldens.ts`;
 * the output is byte-deterministic for a given zlib (the goldens compare
 * DECODED pixels, so encoder drift cannot flip a golden).
 *
 * PROVENANCE (docs/evidence-shims-image.md): these goldens are SYNTHESIZED
 * from the site scramble semantics FMD2's modules implement — not captured
 * from the live sites (this workspace is offline by DESIGN.md §13 and no
 * FPC toolchain exists here to run FMD2 as an oracle). Per site, the
 * scrambled fixture applies EXACTLY the permutation the site's scramble
 * puts into the page (the inverse of what the module's Matrix describes),
 * and `expected.png` is the KNOWN clean page — a strictly stronger oracle
 * than a captured FMD2-descrambled JPEG (which would carry codec drift),
 * since the descramble must reproduce it pixel-for-pixel.
 *
 * Permutation direction (ImagePuzzle.pas:253-262): DeScramble moves the
 * SOURCE block at grid position i to the DESTINATION block Matrix[i].
 * The site scramble therefore satisfies: scrambled_block[i] ==
 * clean_block[Matrix[i]] — the generator copies accordingly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'corpus', 'fixtures', 'imagepuzzle');

/** Deterministic, content-rich clean page (gradients + shapes + bars). */
function cleanPage(width: number, height: number): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const band = y % 60 < 8 ? 40 : 0; // horizontal rule bands
      const column = x % 90 < 6 ? 60 : 0;
      data[p] = Math.trunc(255 - ((y * 200) / height) + band) & 0xff;
      data[p + 1] = Math.trunc(120 + ((x * 120) / width) + column) & 0xff;
      data[p + 2] = Math.trunc(80 + (((x + y) * 100) / (width + height))) & 0xff;
      data[p + 3] = 255;
    }
  }
  // a few solid rectangles so block boundaries are unambiguous
  const rect = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void => {
    for (let y = y0; y < Math.min(y0 + h, height); y += 1) {
      for (let x = x0; x < Math.min(x0 + w, width); x += 1) {
        const p = (y * width + x) * 4;
        data[p] = rgb[0];
        data[p + 1] = rgb[1];
        data[p + 2] = rgb[2];
        data[p + 3] = 255;
      }
    }
  };
  rect(10, 10, width - 20, 14, [250, 240, 20]);
  rect(24, 40, 90, 220, [20, 250, 40]);
  rect(width - 120, height - 90, 100, 70, [200, 30, 220]);
  return { width, height, data };
}

function gridOrder(site: string): { horBlock: number; verBlock: number; multiply: number; matrix: number[] } {
  switch (site) {
    // MangaGo.lua:254-262 — Create(cols, cols); Matrix[i-1] = key[i] from the
    // page desckey ('([^a]+)' split). This fixture's key is a SYNTHESIZED
    // permutation in the real format (16 entries of 0..15).
    case 'MangaGo': {
      const cols = 4;
      const key = [12, 7, 3, 14, 0, 9, 5, 10, 15, 2, 8, 1, 13, 6, 11, 4];
      return { horBlock: cols, verBlock: cols, multiply: 1, matrix: key };
    }
    // 18Comic.lua:99-105 — Create(1, rows); Matrix[i] = rows-1-i (row
    // reversal, self-inverse). NON-SQUARE grid.
    case '18Comic': {
      const rows = 6;
      const matrix: number[] = [];
      for (let i = 0; i < rows; i += 1) {
        matrix.push(rows - 1 - i);
      }
      return { horBlock: 1, verBlock: rows, multiply: 1, matrix };
    }
    // TonarinoYoungJump.lua:93-99 — Create(4, 4) with Multiply = 8 and the
    // transpose matrix (i%4)*4 + i//4.
    case 'TonarinoYoungJump': {
      const size = 4;
      const matrix: number[] = [];
      for (let i = 0; i < size * size; i += 1) {
        matrix.push((i % size) * size + Math.floor(i / size));
      }
      return { horBlock: size, verBlock: size, multiply: 8, matrix };
    }
    default:
      throw new Error(`unknown site ${site}`);
  }
}

/** scrambled_block[i] = clean_block[Matrix[i]] (the site scramble). */
function scramble(clean: RawImage, params: ReturnType<typeof gridOrder>): RawImage {
  const { horBlock, verBlock, multiply, matrix } = params;
  const { width, height } = clean;
  // ImagePuzzle.pas:236-245 — the exact block geometry the descaler computes
  const blockWidth =
    multiply <= 1 ? Math.floor(width / horBlock) : Math.floor(width / (horBlock * multiply)) * multiply;
  const blockHeight =
    multiply <= 1 ? Math.floor(height / verBlock) : Math.floor(height / (verBlock * multiply)) * multiply;
  const out = Buffer.from(clean.data); // untouched remainder keeps clean bytes
  const n = horBlock * verBlock;
  for (let i = 0; i < n; i += 1) {
    const dest = matrix[i] as number;
    const dRow = Math.floor(dest / horBlock);
    const dCol = dest % horBlock;
    const sRow = Math.floor(i / horBlock);
    const sCol = i % horBlock;
    // NOTE: here i plays the DESCRAMBLED position and dest the SCRAMBLED
    // position (inverse application) — copy clean block (dRow,dCol) into
    // scrambled block (sRow,sCol) with the same Trunc geometry.
    const dx1 = Math.trunc(dCol * blockWidth);
    const dy1 = Math.trunc(dRow * blockHeight);
    const sx1 = Math.trunc(sCol * blockWidth);
    const sy1 = Math.trunc(sRow * blockHeight);
    const dx2 = Math.trunc((dCol + 1) * blockWidth);
    const dy2 = Math.trunc((dRow + 1) * blockHeight);
    const tw = dx2 - dx1;
    const th = dy2 - dy1;
    if (tw <= 0 || th <= 0) {
      continue;
    }
    for (let k = 0; k < th; k += 1) {
      const from = ((dy1 + k) * width + dx1) * 4;
      const to = ((sy1 + k) * width + sx1) * 4;
      clean.data.copy(out, to, from, from + tw * 4);
    }
  }
  return { width, height, data: out };
}

const SITES: Readonly<Record<string, readonly [number, number]>> = {
  // width×height chosen so the Pascal block math divides exactly
  // (MangaGo: 4×4 of 200×300; 18Comic: 1×6 of 600×150; Tonarino:
  // trunc(w/32)*8 = 384 / trunc(h/32)*8 = 768 tiles)
  MangaGo: [800, 1200],
  '18Comic': [600, 900],
  TonarinoYoungJump: [1536, 3072],
};

const MODULE_IDS: Readonly<Record<string, string>> = {
  MangaGo: '77c3c3cd38444bd7bb4e5f63f2c5c93c',
  '18Comic': 'b8a5b7a71025420fa3718fd498977e3e',
  TonarinoYoungJump: '88fb782a9c234fde82b0de32f710ce3f',
};

const PROVENANCE: Readonly<Record<string, string>> = {
  MangaGo:
    'SYNTHESIZED (offline workspace; see docs/evidence-shims-image.md). The scrambled page applies the MangaGo scramble convention (scrambled block i = clean block key[i], MangaGo.lua:254-262 Matrix contract) with a fixed 16-entry key in the real desckey format. expected.png = the clean source — the descramble oracle. A live-site capture (FMD2-descrambled JPEG pair) was IMPOSSIBLE here: no network (DESIGN §13) and no FPC toolchain to run the Pascal oracle.',
  '18Comic':
    'SYNTHESIZED (offline workspace). The 18Comic scramble is a vertical row-block reversal (18Comic.lua:99-105: Create(1,rows), Matrix[i]=rows-1-i — self-inverse, so the scramble direction is convention-independent). expected.png = the clean source (pixel-exact oracle).',
  TonarinoYoungJump:
    'SYNTHESIZED (offline workspace). The Tonarino scramble is the fixed 4×4×8 transpose (TonarinoYoungJump.lua:93-99 — self-inverse, direction-independent). expected.png = the clean source (pixel-exact oracle). Exercises the ImagePuzzle.pas:241-245 Multiply block geometry.',
};

function main(): void {
  for (const site of Object.keys(SITES)) {
    const [width, height] = SITES[site] as readonly [number, number];
    const params = gridOrder(site);
    const clean = cleanPage(width, height);
    const scrambled = scramble(clean, params);
    const dir = join(OUT, site);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scrambled.png'), encodePng(scrambled));
    writeFileSync(join(dir, 'expected.png'), encodePng(clean));
    const manifest = {
      site,
      moduleId: MODULE_IDS[site],
      horBlock: params.horBlock,
      verBlock: params.verBlock,
      multiply: params.multiply,
      matrix: params.matrix,
      flips: params.matrix.map(() => 0),
      image: { width, height },
      expectedSha_note: 'expected.png = the clean page; the shim descramble must equal it pixel-for-pixel',
      provenance: PROVENANCE[site],
    };
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeFanFoxFixture();
  console.log(`goldens written to ${OUT}`);
}

/**
 * The mangafoxwatermark fixture (FanFox): the watermarked sample embeds a
 * REAL FMD2 template asset (728-01.png, pinned checkout
 * lua/extras/mangafoxtemplate — the same assets the sync ships into
 * <dataDir>/lua/extras/) as the page's bottom band; `expected.png` is the
 * clean page the removal must recover (crop H-90). The FMD2-descrambled
 * equivalent (a real watermarked FanFox page + its cleaned file) was
 * IMPOSSIBLE to capture offline — the synthesized sample is pixel-exact
 * in the pipeline sense: the matcher PSNR is 1e6 against the embedded
 * template because the band IS the template.
 */
function writeFanFoxFixture(): void {
  const dir = join(OUT, 'FanFox');
  mkdirSync(dir, { recursive: true });
  const width = 728;
  const height = 1200;
  const templatePath = join(
    dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'FMD2', 'lua', 'extras', 'mangafoxtemplate', '728-01.png',
  );
  const template = decodePng(readFileSync(templatePath));
  const clean = cleanPage(width, height);
  const watermarked = Buffer.from(clean.data);
  // bottom template.heigth rows ← the REAL asset's pixels
  template.data.copy(
    watermarked,
    (height - template.height) * width * 4,
    0,
    template.height * template.width * 4,
  );
  writeFileSync(join(dir, 'watermarked.png'), encodePng({ width, height, data: watermarked }));
  writeFileSync(join(dir, 'expected.png'), encodePng(clean));
  const manifest = {
    site: 'FanFox',
    moduleId: '0d3653a8d9b747a381374f32e0a1641e',
    templateAsset: '728-01.png',
    templateAssetSource:
      'FMD2 lua/extras/mangafoxtemplate/728-01.png at the pinned sync SHA 97c903b340d2b0fd82871dba1b0aa5f04a1790e8 (copied into the synced-tree layout: corpus/fixtures/lua/extras/mangafoxtemplate/)',
    watermarkHeight: template.height,
    image: { width, height },
    expected_note:
      'expected.png = the clean page; RemoveWatermark must crop the bottom 90 rows and the result must equal expected rows [0, 1110) pixel-for-pixel',
    provenance:
      'SYNTHESIZED watermarked sample (offline workspace): the bottom band IS the real FMD2 template asset, so the PSNR matcher hits 1e6 exactly; live capture (real watermarked FanFox page + FMD2-cleaned output) was impossible without network/FPC.',
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

main();
