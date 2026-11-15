import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import type { HostLogger, ModuleId } from '@fmd/contract';
import type { LuaEngine as WasmoonEngine } from 'wasmoon';

/**
 * fmd.gzip shim (DESIGN.md §5.7, `LuaGZip.pas:47-50` + `GZIPUtils.pas`
 * `unzipStream`): one method, `Inflate(data)`, with FMD2's three-way
 * format auto-detect — gzip (magic `1f 8b 08`, CRC32 + ISIZE verified),
 * zlib (CMF/FLG checksum, Adler-32 verified) and raw deflate (no
 * wrapper, no checksum). Failure parity: `unzipStream` returning false
 * makes the Pascal log `GZip.Inflate() unzipStream failed` and return
 * no values (nil in Lua) — the shim logs the same line through the
 * module-correlated host logger and returns nil; it never raises.
 *
 * Binary fidelity: Happymh.lua feeds raw compressed bytes
 * (`plain:sub(5)` after the `SC01` magic), so arguments cross the
 * wasmoon boundary over the same pure-Lua base64 bridge as fmd.crypto
 * (`bridge-b64.ts`) — byte-exact for NULs and 0x80-0xFF. The JS core
 * returns base64 and the Lua glue decodes back into exact bytes.
 */

const UNZIP_FAILED = 'GZip.Inflate() unzipStream failed';

/**
 * GZIPUtils.unzipStream format detect + inflate over node:zlib. The
 * Pascal gzip path validates CRC32 + ISIZE (GZIPUtils.pas:244-246) and
 * the zlib path validates Adler-32 (:247-252) — node's gunzipSync /
 * inflateSync perform the identical checks; a failure maps to `false`
 * (→ nil, logged) in both engines, so this returns undefined instead of
 * throwing. Raw deflate has no trailer to verify on either side.
 */
export function gzipInflate(data: Buffer): Buffer | undefined {
  try {
    if (data.length >= 3 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 0x08) {
      return gunzipSync(data);
    }
    if (data.length >= 2) {
      const cmf = data[0] as number;
      const flg = data[1] as number;
      if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0) {
        // zlib wrapper (FDICT streams: the Pascal only skips the header —
        // node's inflateSync also fails without the preset dictionary)
        return inflateSync(data);
      }
    }
    return inflateRawSync(data);
  } catch {
    return undefined; // unzipStream false — the caller logs + yields nil
  }
}

export interface GzipShimOptions {
  readonly logger?: HostLogger | null;
  readonly moduleId?: ModuleId;
}

/**
 * JS-side inflate over the base64 bridge: returns base64 (never raw
 * bytes — wasmoon push UTF-8-encodes and would corrupt binary) or
 * undefined on failure (nil in Lua) after logging the Pascal failure
 * line with module-id correlation.
 */
function inflateB64(b64: string, logger: HostLogger | null, moduleId: ModuleId): string | undefined {
  const out = gzipInflate(Buffer.from(b64, 'base64'));
  if (out === undefined) {
    logger?.write({ level: 'error', moduleId, message: UNZIP_FAILED });
    return undefined;
  }
  return out.toString('base64');
}

/**
 * Install the `fmd.gzip` package preload (registry row: servedBy
 * package-preload, like fmd.crypto/pb — the Lua-visible table must be
 * built Lua-side so Inflate's argument/return cross the bridge as
 * base64 text). `__fmd_gzip_inflate` is the JS global the glue calls.
 */
export function installGzipShim(
  engine: WasmoonEngine,
  options: GzipShimOptions,
): void {
  const logger = options.logger ?? null;
  const moduleId = options.moduleId ?? '';
  engine.global.set('__fmd_gzip_inflate', (b64: unknown): string | undefined =>
    inflateB64(typeof b64 === 'string' ? b64 : '', logger, moduleId),
  );
  engine.doStringSync(`${BRIDGE_B64_LUA_GLUE}

package = package or {}
package.preload = package.preload or {}
-- preload entries must be LOADER FUNCTIONS (require calls them); a raw
-- table would make require report the module as not found — same shape
-- as the fmd.crypto / pb bridge preloads.
package.preload['fmd.gzip'] = function()
  return {
    -- LuaGZip.pas lua_inflate: single value (string | nothing) — a Lua
    -- error is never raised, unzipStream failure logs + yields nil.
    Inflate = function(data)
      local r = __fmd_gzip_inflate(__fmd_b64enc(tostring(data)))
      if r == nil then return nil end
      return __fmd_b64dec(r)
    end,
  }
end`);
}

/**
 * The pure-Lua base64 codec shared by every byte-exact require bridge
 * (fmd.gzip today; fmd.crypto ships its own copy in its glue — left
 * byte-stable). Idempotent: the definitions are guarded, so a bridge
 * installed after fmd.crypto's reuses the same globals.
 */
export const BRIDGE_B64_LUA_GLUE = `
if __fmd_b64enc == nil then
  local __b64_alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  local __b64_lookup = {}
  for i = 1, #__b64_alpha do __b64_lookup[__b64_alpha:sub(i, i)] = i - 1 end

  function __fmd_b64enc(data)
    local t = {}
    local n = #data
    local i = 1
    while i + 2 <= n do
      local a, b, c = data:byte(i, i + 2)
      local n24 = a * 65536 + b * 256 + c
      local s1 = ((n24 >> 18) & 63) + 1
      local s2 = ((n24 >> 12) & 63) + 1
      local s3 = ((n24 >> 6) & 63) + 1
      local s4 = (n24 & 63) + 1
      t[#t + 1] = __b64_alpha:sub(s1, s1) .. __b64_alpha:sub(s2, s2) .. __b64_alpha:sub(s3, s3) .. __b64_alpha:sub(s4, s4)
      i = i + 3
    end
    local rem = n - i + 1
    if rem == 1 then
      local n24 = data:byte(i) * 65536
      local s1 = ((n24 >> 18) & 63) + 1
      local s2 = ((n24 >> 12) & 63) + 1
      t[#t + 1] = __b64_alpha:sub(s1, s1) .. __b64_alpha:sub(s2, s2) .. '=='
    elseif rem == 2 then
      local a, b = data:byte(i, i + 1)
      local n24 = a * 65536 + b * 256
      local s1 = ((n24 >> 18) & 63) + 1
      local s2 = ((n24 >> 12) & 63) + 1
      local s3 = ((n24 >> 6) & 63) + 1
      t[#t + 1] = __b64_alpha:sub(s1, s1) .. __b64_alpha:sub(s2, s2) .. __b64_alpha:sub(s3, s3) .. '='
    end
    return table.concat(t)
  end

  function __fmd_b64dec(text)
    text = text:gsub('[^' .. __b64_alpha .. '=]', '')
    local pad = #text % 4
    if pad == 1 then return '' end
    if pad > 0 then text = text .. string.rep('=', 4 - pad) end
    text = text:gsub('=', 'A')
    local bytes = {}
    for i = 1, #text, 4 do
      local s1, s2, s3, s4 = text:sub(i, i), text:sub(i + 1, i + 1), text:sub(i + 2, i + 2), text:sub(i + 3, i + 3)
      local n24 = (__b64_lookup[s1] or 0) * 262144 + (__b64_lookup[s2] or 0) * 4096 + (__b64_lookup[s3] or 0) * 64 + (__b64_lookup[s4] or 0)
      bytes[#bytes + 1] = string.char((n24 >> 16) & 255, (n24 >> 8) & 255, n24 & 255)
    end
    local out = table.concat(bytes)
    if pad == 0 then return out end
    if pad == 2 then return out:sub(1, -2) end
    return out:sub(1, -3)
  end
end`;
