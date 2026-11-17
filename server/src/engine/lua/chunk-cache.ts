import { createHash } from 'node:crypto';
import { LuaFactory } from 'wasmoon';
import type { LuaChunk, LuaChunkCache } from '../contract.js';

/**
 * Chunk cache (DESIGN.md §5.12): chunks compiled once, cached by file SHA
 * (FMD2: `LuaWebsiteModules.pas:713-733` — bytecode dumped once per module
 * file, then loaded by `LuaWebsiteModuleHandler.pas:33-54` into whatever
 * fresh Lua state runs it).
 *
 * wasmoon exposes `luaL_loadbufferx`/`lua_dump` on its Lua 5.4 wasm build,
 * so the cache stores real Lua bytecode exactly like FMD2's
 * `LuaDumpFileToStream`; a fresh state loads it with mode `'b'`.
 */


function sha256Hex(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export class WasmoonChunkCache implements LuaChunkCache {
  private readonly entries = new Map<string, LuaChunk>();
  private readonly factory: LuaFactory;
  private compiles = 0;

  constructor(factory: LuaFactory = new LuaFactory()) {
    this.factory = factory;
  }

  get size(): number {
    return this.entries.size;
  }

  get compileCount(): number {
    return this.compiles;
  }

  async get(fileName: string, source: string): Promise<LuaChunk> {
    const sha256 = sha256Hex(source);
    const cached = this.entries.get(fileName);
    if (cached !== undefined && cached.sha256 === sha256) {
      return cached;
    }
    const chunk = await this.compile(fileName, source, sha256);
    this.entries.set(fileName, chunk);
    return chunk;
  }

  peek(fileName: string): LuaChunk | undefined {
    return this.entries.get(fileName);
  }

  invalidate(fileName: string): void {
    this.entries.delete(fileName);
  }

  private async compile(fileName: string, source: string, sha256: string): Promise<LuaChunk> {
    const wasm = await this.factory.getLuaModule();
    const module = wasm.module;
    const state = wasm.luaL_newstate();
    try {
      const sourceBytes = Buffer.from(source, 'utf8');
      const sourcePointer = module._malloc(sourceBytes.length);
      try {
        new Uint8Array(module.HEAPU8.buffer, sourcePointer, sourceBytes.length).set(sourceBytes);
        const namePointer = module.stringToNewUTF8(`@${fileName}`);
        try {
          const loadResult = wasm.luaL_loadbufferx(
            state,
            sourcePointer,
            sourceBytes.length,
            namePointer,
            null,
          );
          if (loadResult !== 0) {
            throw new Error(`luaL_loadbufferx(${fileName}) failed: ${loadResult}`);
          }
          const bytecode = dumpBytecode(wasm, state);
          this.compiles += 1;
          return { fileName, sha256, source, bytecode };
        } finally {
          module._free(namePointer);
        }
      } finally {
        module._free(sourcePointer);
      }
    } finally {
      wasm.lua_close(state);
    }
  }
}

/** Undump the function on top of `state` via `lua_dump` (chunk compiled once). */
function dumpBytecode(wasm: Awaited<ReturnType<LuaFactory['getLuaModule']>>, state: number): Uint8Array {
  const module = wasm.module;
  const pieces: Uint8Array[] = [];
  const writer = module.addFunction(
    (_state: number, dataPointer: number, size: number, _userData: number): number => {
      pieces.push(new Uint8Array(module.HEAPU8.buffer, dataPointer, size).slice());
      return 0;
    },
    'iiiii',
  );
  try {
    const dumpResult = wasm.lua_dump(state, writer, 0, 0);
    if (dumpResult !== 0) {
      throw new Error(`lua_dump failed: ${dumpResult}`);
    }
  } finally {
    module.removeFunction(writer);
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const bytecode = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    bytecode.set(piece, offset);
    offset += piece.length;
  }
  return bytecode;
}

export function createLuaChunkCache(factory?: LuaFactory): LuaChunkCache {
  return new WasmoonChunkCache(factory);
}
