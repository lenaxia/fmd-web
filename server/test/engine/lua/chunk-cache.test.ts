import { describe, expect, it } from 'vitest';
import { createLuaChunkCache } from '../../../src/engine/lua/chunk-cache.js';

describe('LuaChunkCache (§5.12: chunks compiled once, cached by file SHA)', () => {
  it('compiles once and reuses the cached chunk for the same SHA', async () => {
    const cache = createLuaChunkCache();
    const source = 'local x = 1\nreturn x + 1';

    const first = await cache.get('a.lua', source);
    expect(first.fileName).toBe('a.lua');
    expect(first.bytecode.length).toBeGreaterThan(0);
    // Lua 5.4 bytecode signature: ESC 'L','u','a'
    expect(Array.from(first.bytecode.subarray(0, 4))).toEqual([0x1b, 0x4c, 0x75, 0x61]);
    expect(cache.compileCount).toBe(1);
    expect(cache.size).toBe(1);

    const second = await cache.get('a.lua', source);
    expect(second).toBe(first);
    expect(cache.compileCount).toBe(1);
  });

  it('compiles distinct files independently', async () => {
    const cache = createLuaChunkCache();
    await cache.get('a.lua', 'return 1');
    await cache.get('b.lua', 'return 2');
    expect(cache.compileCount).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('invalidates and recompiles when the file content changes', async () => {
    const cache = createLuaChunkCache();
    const original = await cache.get('a.lua', 'return 1');
    expect(cache.compileCount).toBe(1);

    const changed = await cache.get('a.lua', 'return 41 + 1');
    expect(changed).not.toBe(original);
    expect(changed.sha256).not.toBe(original.sha256);
    expect(cache.compileCount).toBe(2);
    expect(cache.size).toBe(1);

    // explicit invalidate also forces a recompile
    cache.invalidate('a.lua');
    const again = await cache.get('a.lua', 'return 41 + 1');
    expect(again).not.toBe(changed);
    expect(cache.compileCount).toBe(3);
  });

  it('recompiles when the content of a DIFFERENT file matches a cached sha', async () => {
    const cache = createLuaChunkCache();
    const source = 'return 7';
    await cache.get('a.lua', source);
    await cache.get('b.lua', source); // same content, different file: still its own entry
    expect(cache.size).toBe(2);
    expect(cache.compileCount).toBe(2);
  });

  it('caches chunks by SHA across duplicate content for the same file', async () => {
    const cache = createLuaChunkCache();
    const a = await cache.get('a.lua', 'return 1');
    const b = await cache.get('a.lua', 'return 1'); // identical content
    expect(b).toBe(a);
    expect(cache.compileCount).toBe(1);
  });

  it('produces bytecode loadable into a fresh state (round trip)', async () => {
    const { createLuaHost } = await import('../../../src/engine/lua/host.js');
    const { createMemoryLogger } = await import('../../../src/engine/lua/logger.js');
    const host = createLuaHost(createMemoryLogger());
    await host.chunkCache.get('roundtrip.lua', 'FMD_RT_VALUE = 42\nreturn FMD_RT_VALUE');
    const engine = await host.createEngine();
    await engine.loadModule('roundtrip.lua');
    const engine2 = await host.createEngine();
    await engine2.loadModule('roundtrip.lua');
    await engine.dispose();
    await engine2.dispose();
    await host.dispose();
  });
});
