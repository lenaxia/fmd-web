/**
 * PWA icon generator (R5 arrival).
 *
 * Renders the app's brand mark — the SAME lucide `book-open-text`
 * glyph the shell header uses, stroke `--primary`, on the
 * `--background` dark token — into the manifest's PNG set:
 *
 *   web/public/icon-192.png            purpose "any"
 *   web/public/icon-512.png            purpose "any"
 *   web/public/icon-192-maskable.png   purpose "maskable" (safe zone)
 *   web/public/icon-512-maskable.png   purpose "maskable" (safe zone)
 *   web/public/apple-touch-icon.png    180x180 iOS home screen
 *
 * Deterministic: fixed colors from src/styles/tokens.css (oklch -> hex,
 * precomputed), fixed glyph scales (70% canvas for "any", 52% for
 * maskable so the mark survives Android's circular crop), no font
 * rendering (pure SVG paths).
 *
 * Usage: node scripts/gen-pwa-icons.mjs   (repo root; needs the
 * Playwright chromium install).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';

const BACKGROUND = '#09090b'; // tokens.css --background (dark), oklch(0.141 0.005 285.823)
const PRIMARY = '#8e51ff'; // tokens.css --primary (dark), oklch(0.606 0.25 292.717)

// lucide book-open-text node paths (v1.73.0, ISC) - 24x24 grid.
const GLYPH_PATHS = [
  'M12 5v16',
  'M16 13h2',
  'M16 9h2',
  'M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z',
  'M6 13h2',
  'M6 9h2',
];

const TARGETS = [
  { file: 'icon-192.png', size: 192, glyph: 0.7 },
  { file: 'icon-512.png', size: 512, glyph: 0.7 },
  { file: 'icon-192-maskable.png', size: 192, glyph: 0.52 },
  { file: 'icon-512-maskable.png', size: 512, glyph: 0.52 },
  { file: 'apple-touch-icon.png', size: 180, glyph: 0.7 },
];

function pageSvg(size, glyphFraction) {
  const box = Math.round(size * glyphFraction);
  const offset = (size - box) / 2;
  const paths = GLYPH_PATHS.map(
    (d) =>
      `<path d="${d}" fill="none" stroke="${PRIMARY}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  ).join('');
  return (
    `<!doctype html><html><head><style>` +
    `html,body{margin:0;padding:0;background:${BACKGROUND};width:${size}px;height:${size}px;overflow:hidden}` +
    `</style></head><body>` +
    `<svg width="${box}" height="${box}" viewBox="0 0 24 24" ` +
    `style="position:absolute;left:${offset}px;top:${offset}px" ` +
    `aria-hidden="true">${paths}</svg>` +
    `</body></html>`
  );
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'web', 'public');
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const target of TARGETS) {
    await page.setViewportSize({ width: target.size, height: target.size });
    await page.setContent(pageSvg(target.size, target.glyph));
    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: target.size, height: target.size },
    });
    await writeFile(path.join(outDir, target.file), png);
    console.log(`wrote web/public/${target.file} (${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
