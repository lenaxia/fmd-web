import { readFileSync, readdirSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { HostLogger, ModuleId } from '@fmd/contract';
import { createChromiumBridge } from './chromium-image-bridge.js';
import type { ImageDecoderBridge } from './imagepuzzle-core.js';
import {
  clearTemplates,
  createRemoverState,
  loadTemplates,
  removeWatermark,
  type RemoveWatermarkFs,
  type WatermarkRemoverState,
} from './mangafoxwatermark-core.js';

/**
 * fmd.mangafoxwatermark host-lib shim — the Lua surface of
 * `baseunits/lua/LuaMangaFox.pas:16-52`:
 * - `LoadTemplate(ADirectory)` → Integer (LuaMangaFox.pas:16-21 ⇒
 *   MangaFoxWatermark.pas LoadTemplate :297-330)
 * - `RemoveWatermark(AFileName, ASaveAsPNG=false)` → Boolean
 *   (LuaMangaFox.pas:23-31 ⇒ RemoveWatermark :391-487; the 2nd argument
 *   exists only when the caller passes it — lua_gettop(L)=2, :25-28)
 *
 * SINGLETON parity: MangaFoxWatermark.pas:134-136 holds the remover in a
 * UNIT-LEVEL var — FanFox.lua:36 loads templates during Init() (in the
 * discarded Init-pass Lua state) and :145-150 removes watermarks during
 * OnAfterImageSaved (in event Lua states) THROUGH THE SAME remover. The
 * JS shim therefore keeps its state in a module-level singleton shared by
 * every wasmoon engine in the process.
 *
 * Path layer: FanFox.lua:36 passes
 * `fmd.LuaDirectory .. 'extras\\mangafoxtemplate'` — a WINDOWS backslash
 * path (LuaFMD.pas:24 + FMDOptions.pas:297 give LuaDirectory a trailing
 * PathDelim; fmd.env mirrors it). {@link translateTemplatePath}
 * normalizes the backslashes at the path layer so the real synced-tree
 * assets (FMD2 `lua/extras/mangafoxtemplate/*.png`, shipped into
 * `<dataDir>/lua/extras/` by the module sync and mirrored under
 * corpus/fixtures/lua/extras/ for offline trees) resolve.
 *
 * The real FanFox.lua OnAfterImageSaved flow (FMD2 LuaWebsiteModules.pas
 * :393-408 FILENAME-global contract) is exercised end-to-end offline by
 * server/test/engine/shims/mangafoxwatermark-shim.test.ts.
 */

/**
 * Windows→host path translation for Lua-side paths
 * (`extras\\mangafoxtemplate` → `extras/mangafoxtemplate`).
 */
export function translateTemplatePath(raw: string): string {
  return raw.replaceAll('\\', '/');
}

/** GetImageHandlerByFile().WExt parity: jpg/jpeg → jpg, png → png. */
export function writerExtensionFor(fileName: string): string | undefined {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    return 'jpg';
  }
  if (ext === '.png') {
    return 'png';
  }
  return undefined; // no registered writer (false, :403-404)
}

/** The unit-level remover (MangaFoxWatermark.pas:134-136 parity). */
const REMOVER: WatermarkRemoverState = createRemoverState();

/** Test seam: restore the pristine singleton state. */
export function resetWatermarkRemoverForTests(): void {
  clearTemplates(REMOVER);
  REMOVER.templateDirectory = '';
  REMOVER.cleared = true;
  REMOVER.minPSNR = 9.0;
  REMOVER.minWhiteBorder = 4;
}

let singletonBridge: ImageDecoderBridge | undefined;
let singletonBridgeTried = false;

function ensureBridge(): ImageDecoderBridge | undefined {
  if (!singletonBridgeTried) {
    singletonBridgeTried = true;
    try {
      singletonBridge = createChromiumBridge();
    } catch {
      singletonBridge = undefined;
    }
  }
  return singletonBridge;
}

const listFiles = (dir: string): readonly string[] => {
  try {
    // FULL paths (FindAllFiles parity, MangaFoxWatermark.pas:309), sorted
    // for deterministic first-max-PSNR order (core doc note)
    return readdirSync(dir)
      .filter((f) => {
        try {
          return statSync(join(dir, f)).isFile();
        } catch {
          return false;
        }
      })
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
};

const fs: RemoveWatermarkFs = {
  readFile: (path) => readFileSync(path),
  deleteFile: (path) => rmSync(path, { force: true }),
  fileExists: (path) => existsSync(path),
  writeOrReplace: (path, bytes) => {
    writeFileSync(path, bytes);
  },
  stripExtension: (path) => {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return path.slice(0, path.length - name.length) + stem;
  },
  writerExtension: (path) => writerExtensionFor(path),
};

/** The real synced-tree default: `<luaRoot>/extras/mangafoxtemplate`. */
export function defaultTemplateDirectory(luaRoot: string): string {
  return translateTemplatePath(`${luaRoot}\\extras\\mangafoxtemplate`);
}

export interface MangaFoxWatermarkShimOptions {
  readonly luaRoot: string;
  readonly logger?: HostLogger | null;
  readonly moduleId?: ModuleId;
}

export interface MangaFoxWatermarkShim {
  LoadTemplate(directory?: unknown): number;
  RemoveWatermark(fileName: unknown, saveAsPNG?: unknown): boolean;
  /** Diagnostics: the shared remover state (template dir + count). */
  readonly state: WatermarkRemoverState;
}

export function makeMangaFoxWatermarkShim(options: MangaFoxWatermarkShimOptions): MangaFoxWatermarkShim {
  const log = (message: string): void => {
    options.logger?.write({ level: 'error', moduleId: options.moduleId ?? '', message });
  };

  const loadInto = (rawDir: string): number => {
    try {
      return loadTemplates(REMOVER, rawDir, ensureBridge(), listFiles, readFileSync, existsSync);
    } catch {
      log('MangaFoxWatermark.LoadTemplate: failed');
      return 0;
    }
  };

  return {
    state: REMOVER,
    LoadTemplate(directory?: unknown): number {
      // LuaMangaFox.pas:16-21 — luaToString(L,1); FanFox.lua:36 passes the
      // Windows-flavored concatenation (backslash path layer).
      const raw = typeof directory === 'string' && directory.length > 0 ? directory : REMOVER.templateDirectory;
      return loadInto(translateTemplatePath(raw));
    },
    RemoveWatermark(fileName: unknown, saveAsPNG?: unknown): boolean {
      // LuaMangaFox.pas:23-31 — RemoveWatermark(FILENAME, ASaveAsPNG)
      // (2nd argument optional: lua_gettop(L)=2). :395-401 lazy load runs
      // only when an explicit LoadTemplate never happened.
      if (REMOVER.templates.length === 0) {
        if (!REMOVER.cleared) {
          return false; // a prior load found nothing (FCleared=False)
        }
        const dir =
          REMOVER.templateDirectory !== ''
            ? REMOVER.templateDirectory
            : defaultTemplateDirectory(options.luaRoot);
        if (loadInto(dir) === 0) {
          return false;
        }
      }
      const outcome = removeWatermark(
        REMOVER,
        typeof fileName === 'string' ? translateTemplatePath(fileName) : '',
        saveAsPNG === true,
        ensureBridge(),
        fs,
      );
      return outcome.ok;
    },
  };
}

/** Template asset inventory of a synced tree (evidence/tests). */
export function templateAssetNames(luaRoot: string): readonly string[] {
  try {
    return readdirSync(join(luaRoot, 'extras', 'mangafoxtemplate')).sort();
  } catch {
    return [];
  }
}
