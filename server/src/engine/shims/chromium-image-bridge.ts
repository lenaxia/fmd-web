import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageDecoderBridge } from './imagepuzzle-core.js';
import type { RawImage } from './png-codec.js';

/**
 * Optional headless-Chromium codec bridge (offline-safe, SYNCHRONOUS):
 * JPEG/WebP decode + JPEG encode through a one-shot `node -e` helper
 * process driving a Playwright page canvas. Synchronous by contract —
 * the Pascal DeScramble is synchronous and wasmoon host functions called
 * from `doStringSync` cannot await promises — so each bridge call pays
 * one Chromium launch (~0.5s). The PNG path (the golden path) never
 * touches this bridge: pure-JS decode/encode lives in png-codec.ts.
 *
 * Availability: `playwright` ships in this workspace's ROOT node_modules
 * (not a server dependency). It is loaded via createRequire relative to
 * this module; when absent — or no bundled browser — `createChromiumBridge`
 * returns undefined and callers degrade to the Pascal undecodable-stream
 * failure (`could not decode image`, ImagePuzzle.pas:209-213).
 *
 * Fidelity notes (docs/evidence-shims-image.md):
 * - Chromium decodes JPEG (libjpeg-turbo) / WebP (libwebp) — pixels can
 *   differ from FMD2's FCL decoders by ±1 on IDCT rounding; the
 *   pixel-identical golden claims are scoped to the LOSSLESS paths
 *   (PNG/WebP input → PNG output) where decode is deterministic.
 * - JPEG encode uses canvas.toDataURL('image/jpeg', q) at FCL's default
 *   quality 75 (FPWriteJPEG); the encoders differ, so JPEG output bytes
 *   (lossy by construction) are never golden-compared.
 */

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The helper source: argv[2] = workspace root, argv[3] = mode
 * ('decode' | 'encode-jpeg'); stdin carries base64 payload
 * (decode: image bytes; encode-jpeg: JSON {w,h,rgbaB64,q}); stdout
 * carries the base64 result (decode: {w,h,rgbaB64} JSON; encode: jpeg).
 */
const HELPER_SCRIPT = `
const { createRequire } = require('node:module');
const root = process.env.FMD_IMAGE_BRIDGE_ROOT;
const mode = process.env.FMD_IMAGE_BRIDGE_MODE;
const input = require('node:fs').readFileSync(0, 'utf8');
const pw = createRequire(root + '/package.json')('playwright');
const inPage = async ([kind, b64]) => {
  if (kind === 'decode') {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej('decode failed'); img.src = 'data:application/octet-stream;base64,' + b64; });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let bin = '';
    const bytes = px.data;
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    return { w: canvas.width, h: canvas.height, rgbaB64: btoa(bin) };
  }
  const payload = JSON.parse(atob(b64));
  const canvas = document.createElement('canvas');
  canvas.width = payload.w;
  canvas.height = payload.h;
  const ctx = canvas.getContext('2d');
  const bin = atob(payload.rgbaB64);
  const bytes = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  ctx.putImageData(new ImageData(bytes, payload.w, payload.h), 0, 0);
  const url = canvas.toDataURL('image/jpeg', payload.q);
  return url.slice(url.indexOf(',') + 1);
};
(async () => {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(inPage, [mode, input]);
    process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(String(e)); process.exit(3); });
`;

interface HelperDecodeResult {
  readonly w: number;
  readonly h: number;
  readonly rgbaB64: string;
}

function runHelper(mode: 'decode' | 'encode-jpeg', stdin: string): string | undefined {
  const result = spawnSync(process.execPath, ['-e', HELPER_SCRIPT], {
    input: stdin,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      FMD_IMAGE_BRIDGE_ROOT: WORKSPACE_ROOT,
      FMD_IMAGE_BRIDGE_MODE: mode,
    },
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout;
}

let availability: boolean | undefined;

/**
 * True when playwright + a bundled Chromium are loadable (probe: launch +
 * close once). Undefined→false transitions are cached per process.
 */
export function chromiumBridgeAvailable(): boolean {
  if (availability !== undefined) {
    return availability;
  }
  try {
    const require = createRequire(join(WORKSPACE_ROOT, 'package.json'));
    const playwright = require('playwright') as { chromium?: unknown };
    availability = playwright?.chromium !== undefined;
  } catch {
    availability = false;
  }
  return availability;
}

/**
 * The bridge (all methods synchronous). Returns undefined when the
 * workspace carries no usable playwright/Chromium — callers treat that
 * as "format not decodable offline" (the Pascal undecodable-stream path).
 */
export function createChromiumBridge(): ImageDecoderBridge | undefined {
  if (!chromiumBridgeAvailable()) {
    return undefined;
  }
  const decode = (bytes: Buffer): RawImage | undefined => {
    const out = runHelper('decode', bytes.toString('base64'));
    if (out === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(out) as HelperDecodeResult;
      return { width: parsed.w, height: parsed.h, data: Buffer.from(parsed.rgbaB64, 'base64') };
    } catch {
      return undefined;
    }
  };
  return {
    decodeWebp: decode,
    decodeJpeg: decode,
    encodeJpeg(image: RawImage, quality: number): Buffer | undefined {
      const payload = JSON.stringify({
        w: image.width,
        h: image.height,
        rgbaB64: image.data.toString('base64'),
        q: quality / 100,
      });
      const out = runHelper('encode-jpeg', Buffer.from(payload).toString('base64'));
      return out !== undefined ? Buffer.from(out, 'base64') : undefined;
    },
  };
}
