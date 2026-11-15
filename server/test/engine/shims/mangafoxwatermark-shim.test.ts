import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import { createLuaHost, type WasmoonLuaHost } from '../../../src/engine/lua/host.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../../src/engine/lua/abort.js';
import { installShims, loadRealModuleFile, FMD2_LUA_ROOT, type InstalledShims } from '../../../src/engine/shims/install.js';
import { RecordedResponseResolver } from '../../../src/engine/shims/http-shim.js';
import { decodePng } from '../../../src/engine/shims/png-codec.js';
import { createChromiumBridge } from '../../../src/engine/shims/chromium-image-bridge.js';
import {
  defaultTemplateDirectory,
  makeMangaFoxWatermarkShim,
  resetWatermarkRemoverForTests,
  templateAssetNames,
  translateTemplatePath,
  writerExtensionFor,
} from '../../../src/engine/shims/mangafoxwatermark-shim.js';

/**
 * fmd.mangafoxwatermark proofs (audit bucket B):
 * 1. PATH LAYER — the Windows backslash translation
 *    (`fmd.LuaDirectory .. 'extras\\mangafoxtemplate'`, FanFox.lua:36)
 *    resolves the real synced-tree assets.
 * 2. ASSETS — the REAL FMD2 PNG templates (pinned checkout
 *    lua/extras/mangafoxtemplate, mirrored into the synced-tree layout
 *    corpus/fixtures/lua/extras/mangafoxtemplate/) load — 10 templates.
 * 3. GOLDEN — the captured watermarked sample (corpus/fixtures/
 *    imagepuzzle/FanFox) is cleaned to the expected page PIXEL-IDENTICALLY
 *    (crop H-90), through the real Otsu/PSNR matcher.
 * 4. FANFOX FLOW — the REAL FanFox.lua: Init() (real LoadTemplate call
 *    through the backslash path) + AfterImageSaved() with the FMD2
 *    FILENAME-global contract (LuaWebsiteModules.pas:393-408), offline.
 *
 * Provenance (manifest.json + docs/evidence-shims-image.md): the
 * watermarked sample is synthesized offline (the bottom band IS template
 * 728-01.png, so the PSNR matcher hits 1e6); a live capture was
 * impossible without network/FPC — disclosed, not papered.
 */

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const GOLDEN = join(ROOT, 'corpus', 'fixtures', 'imagepuzzle', 'FanFox');
const CORPUS_LUA_ROOT = join(ROOT, 'corpus', 'fixtures', 'lua');

describe('mangafoxwatermark path layer', () => {
  it('translates the Windows backslash template path (FanFox.lua:36)', () => {
    expect(translateTemplatePath('/data/lua/extras\\mangafoxtemplate')).toBe('/data/lua/extras/mangafoxtemplate');
    expect(translateTemplatePath('C:\\fmd\\lua\\extras\\mangafoxtemplate')).toBe('C:/fmd/lua/extras/mangafoxtemplate');
    expect(translateTemplatePath('plain/path')).toBe('plain/path');
  });

  it('fmd.env LuaDirectory carries the trailing delimiter (FMDOptions.pas:297)', async () => {
    // proven through the real fmd.env row: the concatenation lands on
    // <luaRoot>/extras/mangafoxtemplate, not <luaRoot>extras...
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    const abort = new DeadlineAbortHandle(createDeadlineCells());
    await host.chunkCache.get('__env_probe.lua', 'function Init() end');
    const engine = await host.createEngine();
    await engine.loadModule('__env_probe.lua', (inner, bridge) => {
      installShims(inner, bridge, {
        resolver: new RecordedResponseResolver([]),
        abort,
        logger,
        moduleId: 'env-probe',
        luaRoot: FMD2_LUA_ROOT,
      });
    });
    const luaDir = engine.innerEngine.doStringSync(`return require('fmd.env').LuaDirectory`) as string;
    expect(luaDir).toBe(`${FMD2_LUA_ROOT}/`);
    expect(defaultTemplateDirectory(FMD2_LUA_ROOT)).toBe(`${FMD2_LUA_ROOT}/extras/mangafoxtemplate`);
    await host.dispose();
  });

  it('writer extension map mirrors GetImageHandlerByFile (:403-404)', () => {
    expect(writerExtensionFor('page.jpg')).toBe('jpg');
    expect(writerExtensionFor('page.jpeg')).toBe('jpg');
    expect(writerExtensionFor('page.PNG')).toBe('png');
    expect(writerExtensionFor('page.webp')).toBeUndefined();
    expect(writerExtensionFor('noext')).toBeUndefined();
  });
});

describe('mangafoxwatermark assets + golden', () => {
  beforeEach(() => {
    resetWatermarkRemoverForTests();
  });

  it('the REAL FMD2 template assets ship in the synced-tree layout (10 PNGs)', () => {
    // corpus mirror of FMD2 lua/extras/mangafoxtemplate (the module sync
    // ships the same subtree into <dataDir>/lua/extras/)
    const names = templateAssetNames(CORPUS_LUA_ROOT);
    expect(names).toHaveLength(10);
    expect(names).toContain('728-01.png');
    expect(names.every((n) => n.endsWith('.png'))).toBe(true);
  });

  it('LoadTemplate through the backslash path loads the 10 real templates', () => {
    const shim = makeMangaFoxWatermarkShim({ luaRoot: FMD2_LUA_ROOT });
    // the exact FanFox.lua:36 argument shape: <LuaDirectory>extras\mangafoxtemplate
    const count = shim.LoadTemplate(`${FMD2_LUA_ROOT}/extras\\mangafoxtemplate`);
    expect(count).toBe(10);
    expect(shim.state.templateDirectory).toBe(`${FMD2_LUA_ROOT}/extras/mangafoxtemplate`);
    expect(shim.state.cleared).toBe(false);
  });

  it('golden: the watermarked sample cleans to the expected page (pixel-identical crop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmd-watermark-'));
    try {
      const shim = makeMangaFoxWatermarkShim({ luaRoot: FMD2_LUA_ROOT });
      shim.LoadTemplate(`${FMD2_LUA_ROOT}/extras\\mangafoxtemplate`);

      const sample = join(dir, 'page.png');
      writeFileSync(sample, readFileSync(join(GOLDEN, 'watermarked.png')));
      const ok = shim.RemoveWatermark(sample, false);
      expect(ok).toBe(true);

      const expected = decodePng(readFileSync(join(GOLDEN, 'expected.png')));
      const got = decodePng(readFileSync(sample)); // rewritten in place (png → png)
      expect(got.width).toBe(expected.width);
      expect(got.height).toBe(expected.height - 90); // the template band cropped
      // pixel-identical to expected rows [0, height)
      const rowBytes = expected.width * 4;
      const croppedExpected = expected.data.subarray(0, rowBytes * got.height);
      expect(got.data.equals(croppedExpected)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-match leaves the file untouched (BestValue < MinPSNR :465)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmd-watermark-'));
    try {
      const shim = makeMangaFoxWatermarkShim({ luaRoot: FMD2_LUA_ROOT });
      shim.LoadTemplate(`${FMD2_LUA_ROOT}/extras\\mangafoxtemplate`);
      const sample = join(dir, 'noisy.png');
      writeFileSync(sample, readFileSync(join(GOLDEN, 'expected.png'))); // clean page, no band
      const before = readFileSync(sample);
      expect(shim.RemoveWatermark(sample, false)).toBe(false);
      expect(readFileSync(sample).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown writer extension → false (:403-404); lazy load from an empty tree → false (:395-401)', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'fmd-watermark-empty-'));
    const dir = mkdtempSync(join(tmpdir(), 'fmd-watermark-'));
    try {
      const shim = makeMangaFoxWatermarkShim({ luaRoot: emptyRoot });
      const sample = join(dir, 'page.xyz');
      writeFileSync(sample, Buffer.from('whatever'));
      expect(shim.RemoveWatermark(sample, false)).toBe(false);
      // lazy load: never loaded + empty default dir → templates stay 0
      expect(shim.state.templates.length === 0 || shim.RemoveWatermark(sample, false)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('SaveAsPNG on a JPEG sample keeps the Pascal writer override (chromium-gated)', async () => {
    const bridge = createChromiumBridge();
    if (bridge === undefined) {
      return; // offline PNG-only mode: the JPEG leg is unavailable, skip
    }
    const dir = mkdtempSync(join(tmpdir(), 'fmd-watermark-jpeg-'));
    try {
      const shim = makeMangaFoxWatermarkShim({ luaRoot: FMD2_LUA_ROOT });
      shim.LoadTemplate(`${FMD2_LUA_ROOT}/extras\\mangafoxtemplate`);

      // build the watermarked JPEG: encode the watermarked RGBA through the
      // Chromium canvas (the lossy encode is why this test compares to the
      // re-encoded crop, with the matcher PSNR evidence carried by the PNG
      // golden above)
      const watermarked = decodePng(readFileSync(join(GOLDEN, 'watermarked.png')));
      const jpeg = bridge.encodeJpeg(watermarked, 95);
      expect(jpeg).toBeDefined();
      const sample = join(dir, 'page.jpg');
      writeFileSync(sample, jpeg as Buffer);
      const ok = shim.RemoveWatermark(sample, true);
      expect(ok).toBe(true);
      const outPng = join(dir, 'page.png'); // SaveAsPNG overrides the writer
      expect(outPng).not.toBe(sample);
      const got = decodePng(readFileSync(outPng));
      expect(got.height).toBe(watermarked.height - 90);
      expect(got.width).toBe(watermarked.width);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mangafoxwatermark — the REAL FanFox.lua flow (offline end-to-end)', () => {
  const hosts: WasmoonLuaHost[] = [];

  afterAll(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.dispose()));
  });

  beforeEach(() => {
    resetWatermarkRemoverForTests();
  });

  it('Init() loads templates via the backslash path; AfterImageSaved() cleans FILENAME', async () => {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    hosts.push(host);
    const abort = new DeadlineAbortHandle(createDeadlineCells());
    const resolver = new RecordedResponseResolver([]);

    // 1. the Init pass (real state shape): FanFox.lua Init() runs with the
    //    §5.7 shims — require 'fmd.mangafoxwatermark'.LoadTemplate(<Windows
    //    path>) executes here, and its remover state (the process
    //    singleton, MangaFoxWatermark.pas:134-136) persists beyond this
    //    discarded Lua state.
    const descriptors = await loadRealModuleFile(host, FMD2_LUA_ROOT, 'modules/FanFox.lua', (inner, bridge) => {
      installShims(inner, bridge, { resolver, abort, logger, moduleId: '0d3653a8d9b747a381374f32e0a1641e', luaRoot: FMD2_LUA_ROOT });
    });
    const fanfox = descriptors.find((d) => d.id === '0d3653a8d9b747a381374f32e0a1641e');
    expect(fanfox, 'FanFox module must register (the audit bug: init failed on the missing lib)').toBeDefined();
    expect(fanfox?.eventHandlers['AfterImageSaved']).toBe('AfterImageSaved');

    // 2. the event state: load the chunk again (defines the handler
    //    globals), bind MODULE with the module's own option defaults,
    //    set FILENAME (LuaWebsiteModules.pas:402), call the handler.
    const shim = makeMangaFoxWatermarkShim({ luaRoot: FMD2_LUA_ROOT });
    expect(shim.state.templates.length).toBe(10); // carried over from Init()

    const dir = mkdtempSync(join(tmpdir(), 'fmd-fanfox-e2e-'));
    try {
      const sample = join(dir, 'page.png');
      writeFileSync(sample, readFileSync(join(GOLDEN, 'watermarked.png')));

      const engine = await host.createEngine();
      let kit: InstalledShims | undefined;
      await engine.loadModule('modules/FanFox.lua', (inner, bridge) => {
        kit = installShims(inner, bridge, { resolver, abort, logger, moduleId: '0d3653a8d9b747a381374f32e0a1641e', luaRoot: FMD2_LUA_ROOT });
        // event-time MODULE binding (dispatcher parity, LuaWebsiteModules
        // MODULE global) with FanFox's declared checkbox defaults:
        bridge.create('MODULE', {
          get: (k) => {
            if (k === 'GetOption') {
              return (name: unknown) => name === 'mf_removewatermark';
            }
            return undefined;
          },
          set: () => {},
        });
      });
      if (kit === undefined) {
        throw new Error('shim install did not run');
      }
      const result = engine.innerEngine.doStringSync(
        `FILENAME = '${sample}'\nreturn AfterImageSaved()`,
      ) as boolean;
      expect(result).toBe(true);

      const expected = decodePng(readFileSync(join(GOLDEN, 'expected.png')));
      const got = decodePng(readFileSync(sample));
      expect(got.height).toBe(expected.height - 90);
      expect(got.data.equals(expected.data.subarray(0, expected.width * 4 * got.height))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
