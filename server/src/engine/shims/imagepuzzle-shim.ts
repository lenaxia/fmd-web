import type { LuaEngine as WasmoonEngine } from 'wasmoon';
import type { HostLogger, ModuleId } from '@fmd/contract';
import type { HttpDocument } from './http-pipeline.js';
import { createChromiumBridge } from './chromium-image-bridge.js';
import { DESCRAMBLE_LOG_PREFIX, descrambleBytes, type ImageDecoderBridge } from './imagepuzzle-core.js';

/**
 * fmd.imagepuzzle shim — the Lua binding surface of
 * `baseunits/lua/LuaImagePuzzle.pas` (lib registration :102-109,
 * constructors :73-77, read-only HorBlock/VerBlock props :78-82,
 * read-write Matrix[]/Flips[] array props :83-87, DeScramble :88-91,
 * read-write Multiply integer prop :99), installed as a package preload
 * (the fmd.crypto/fmd.gzip pattern) because the puzzle OBJECT must be a
 * Lua table with LuaClass-style metatables — a JS-returned object would
 * cross wasmoon as a plain copy and lose the property dispatch.
 *
 * State ownership: Matrix/Flips/Multiply/HorBlock/VerBlock live LUA-side
 * (plain tables seeded by Create per ImagePuzzle.pas:32-44); the JS call
 * receives them as scalars + comma CSVs (binary/base64 is not needed —
 * the values are integers, and wasmoon string marshalling is exact for
 * them). DeScramble's streams resolve through the facade `__fmd_id`
 * marker + the HTTP documents map (install.ts's sanctioned resolution
 * path for facade arguments), reproducing LuaImagePuzzle.pas:31-33's
 * `luaToUserData(L, 1/2)` TStream arguments — INCLUDING the
 * same-Document in-place call (MangaGo.lua:264, 18Comic.lua:106,
 * TonarinoYoungJump.lua:96), which is safe because the port snapshots
 * the input bytes before the first output write (ImagePuzzle.pas:180's
 * TMemoryStream.LoadFromStream(input)).
 *
 * LogAndFail parity (:151-156): a failure logs
 * `TImagePuzzle.DeScramble: <reason>` through the module-correlated host
 * logger and EMPTIES the output stream (in-place: the document ends up
 * cleared, exactly as Pascal truncates output.Size to 0).
 */

export interface ImagePuzzleShimOptions {
  /** Facade id → backing stream (install.ts documents map). */
  readonly documents?: Map<number, HttpDocument>;
  readonly logger?: HostLogger | null;
  readonly moduleId?: ModuleId;
}

/** The absent-Chromium bridge: every codec leg is undecodable (undefined). */
const NO_BRIDGE: ImageDecoderBridge = {
  decodeWebp: () => undefined,
  decodeJpeg: () => undefined,
  encodeJpeg: () => undefined,
};

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function parseCsv(csv: unknown): number[] {
  const raw = typeof csv === 'string' ? csv : '';
  if (raw === '') {
    return [];
  }
  return raw.split(',').map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  });
}

/**
 * Facade-table → backing stream resolution (the install.ts `__fmd_id`
 * contract). An unresolvable argument is NOT a stream — Pascal's
 * `Assigned(input)` guard (ImagePuzzle.pas:159-162) exits silently, so
 * this returns undefined and the caller no-ops without logging.
 */
function resolveDocument(arg: unknown, documents: Map<number, HttpDocument> | undefined): HttpDocument | undefined {
  if (arg === null || typeof arg !== 'object') {
    return undefined;
  }
  const marker = (arg as Record<string, unknown>)['__fmd_id'];
  if (typeof marker !== 'number') {
    return undefined;
  }
  return documents?.get(marker);
}

/**
 * Install the `fmd.imagepuzzle` package preload. Mirrors
 * LuaPackage.AddLib('imagepuzzle', …) + luaopen_imagepuzzle (:102-109):
 * the require returns { New = create, Create = create } (:73-77 — both
 * constructors share imagepuzzle_create).
 */
export function installImagePuzzleShim(engine: WasmoonEngine, options: ImagePuzzleShimOptions = {}): void {
  const documents = options.documents;
  const logger = options.logger ?? null;
  const moduleId = options.moduleId ?? '';

  // undefined when offline without Chromium — the PNG path never touches it;
  // the NO_BRIDGE stub keeps descrambleBytes' bridge parameter total.
  const bridge: ImageDecoderBridge = createChromiumBridge() ?? NO_BRIDGE;

  engine.global.set(
    '__fmd_imagepuzzle_descramble',
    (
      w: unknown,
      h: unknown,
      multiply: unknown,
      matrixCsv: unknown,
      flipsCsv: unknown,
      srcArg: unknown,
      dstArg: unknown,
    ): void => {
      // :159-162 — unassigned (non-stream) arguments exit silently
      const src = resolveDocument(srcArg, documents);
      const dst = resolveDocument(dstArg, documents);
      if (src === undefined || dst === undefined) {
        return;
      }
      // :180 — the input snapshot (in-place safety)
      const input = Buffer.from(src.bytes);
      const outcome = descrambleBytes(
        input,
        {
          horBlock: toInt(w),
          verBlock: toInt(h),
          multiply: toInt(multiply),
          matrix: parseCsv(matrixCsv),
          flips: parseCsv(flipsCsv),
        },
        bridge,
      );
      if (outcome.ok) {
        // :294-296 — output.Position := 0; output.Size := 0; save
        dst.setBytes(outcome.output);
      } else {
        // :151-156 — LogAndFail: log + empty the output stream
        logger?.write({ level: 'error', moduleId, message: `${DESCRAMBLE_LOG_PREFIX}${outcome.reason}` });
        dst.clear();
      }
    },
  );

  engine.doStringSync(GLUE_LUA);
}

/**
 * The Lua-side object layer: Create seeds Matrix identity / Flips zeros
 * (ImagePuzzle.pas:32-44); HorBlock/VerBlock are get-only (:78-82),
 * Multiply get/set (:99), Matrix/Flips are the plain child tables their
 * array props expose (:83-87 — `puzzle.Matrix[i] = v` indexes the child),
 * DeScramble marshals the state + the two stream arguments (:28-34).
 * Unknown keys: silent nil get / dropped set (LuaClass.pas:94-169 parity,
 * §5.1 facade semantics).
 */
export const GLUE_LUA = `
package = package or {}
package.preload = package.preload or {}
package.preload['fmd.imagepuzzle'] = function()
  local function toint(v)
    if type(v) == 'number' then return math.tointeger(v) end
    return nil
  end
  local function create(w0, h0)
    local w = toint(w0) or 0
    local h = toint(h0) or 0
    local n = w * h
    local matrix, flips = {}, {}
    for i = 0, n - 1 do matrix[i] = i; flips[i] = 0 end
    local multiply = 1
    local obj = {}
    local mt = {}
    mt.__index = function(_, k)
      if k == 'HorBlock' then return w end
      if k == 'VerBlock' then return h end
      if k == 'Multiply' then return multiply end
      if k == 'Matrix' then return matrix end
      if k == 'Flips' then return flips end
      if k == 'DeScramble' then
        return function(src, dst)
          local m, f = {}, {}
          for i = 0, n - 1 do m[#m + 1] = tostring(matrix[i] or 0) end
          for i = 0, n - 1 do f[#f + 1] = tostring(flips[i] or 0) end
          __fmd_imagepuzzle_descramble(w, h, multiply, table.concat(m, ','), table.concat(f, ','), src, dst)
        end
      end
      return nil
    end
    mt.__newindex = function(_, k, v)
      if k == 'Multiply' then multiply = toint(v) or multiply end
    end
    return setmetatable(obj, mt)
  end
  return { New = create, Create = create }
end
`;
