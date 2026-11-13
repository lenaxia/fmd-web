import { LuaReturn, type LuaEngine as WasmoonEngine, type LuaWasm } from 'wasmoon';
import type { LuaChunk } from '@fmd/contract';

/**
 * Chunk loading (§5.12): load cached bytecode into a Lua state and run its
 * top level — `TLuaWebsiteModule.LuaDoMe` / `LuaExecute`
 * (`LuaWebsiteModuleHandler.pas:33-54`). Bytecode loads with mode `'b'`
 * exactly like FMD2's undumped `Container.ByteCode` stream.
 */

export class ChunkLoadError extends Error {
  constructor(
    message: string,
    readonly fileName: string,
  ) {
    super(message);
  }
}

export function loadChunkInto(engine: WasmoonEngine, chunk: LuaChunk): void {
  const wasm = engine.global.lua;
  const result = loadChunkBuffer(wasm, engine.global.address, chunk);
  if (!result.ok) {
    throw new ChunkLoadError(result.error, chunk.fileName);
  }
}

export function loadChunkBuffer(
  wasm: LuaWasm,
  state: number,
  chunk: LuaChunk,
): { ok: true } | { ok: false; error: string } {
  const module = wasm.module;
  const size = chunk.bytecode.length;
  const bufferPointer = module._malloc(size);
  try {
    new Uint8Array(module.HEAPU8.buffer, bufferPointer, size).set(chunk.bytecode);
    const namePointer = module.stringToNewUTF8(chunk.fileName);
    try {
      const loadResult = wasm.luaL_loadbufferx(state, bufferPointer, size, namePointer, 'b');
      if (loadResult !== LuaReturn.Ok) {
        return { ok: false, error: `luaL_loadbufferx(${chunk.fileName}) failed: ${loadResult}` };
      }
    } finally {
      module._free(namePointer);
    }
    const pcallResult = wasm.lua_pcallk(state, 0, 0, 0, 0, null);
    if (pcallResult !== LuaReturn.Ok) {
      const message = wasm.lua_tolstring(state, -1, null);
      wasm.lua_settop(state, 0);
      return { ok: false, error: message ?? `lua_pcall failed: ${pcallResult}` };
    }
    return { ok: true };
  } finally {
    module._free(bufferPointer);
  }
}

/** Call a global function with no arguments and read the top of the stack. */
export function callGlobalFunction(
  wasm: LuaWasm,
  state: number,
  name: string,
): { ok: true; hasResult: boolean } | { ok: false; error: string } {
  wasm.lua_getglobal(state, name);
  if (wasm.lua_type(state, -1) !== 6 /* LUA_TFUNCTION */) {
    wasm.lua_pop(state, 1);
    return { ok: false, error: `global "${name}" is not a function` };
  }
  const pcallResult = wasm.lua_pcallk(state, 0, 1, 0, 0, null);
  if (pcallResult !== LuaReturn.Ok) {
    const message = wasm.lua_tolstring(state, -1, null);
    wasm.lua_settop(state, 0);
    return { ok: false, error: message ?? `lua_pcall(${name}) failed: ${pcallResult}` };
  }
  const hasResult = wasm.lua_type(state, -1) !== 0 /* LUA_TNIL */;
  return { ok: true, hasResult };
}
