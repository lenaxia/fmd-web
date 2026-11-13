import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import type { WasmoonLuaEngine } from '../../../src/engine/lua/engine.js';
import type { WasmoonLuaHost } from '../../../src/engine/lua/host.js';
import {
  makeStorageSpec,
  TStringsStorageStrings,
  STORAGE_STATUS_DEFAULT,
  storageStringsFromMap,
  type StorageLock,
} from '../../../src/engine/lua/storage.js';

/**
 * MODULE.Storage facade contract tests (§5.5, LuaStringsStorage.pas:143-159
 * + §5.3 shared state service): KV default-array access, Text get/set,
 * Remove/Tag/Enable/Status, TStringsStorage ctor defaults, thread-safe
 * routing through the shared state service (per-module StorageStrings +
 * critical-section lock).
 */

const MODULE_ID = '0123456789abcdef0123456789abcdef';

/** Records enter/exit pairs — proves facade ops route through the lock. */
function trackingLock(): StorageLock & { enters: number; exits: number } {
  const lock = { enters: 0, exits: 0 };
  return {
    get enters() {
      return lock.enters;
    },
    get exits() {
      return lock.exits;
    },
    enter() {
      lock.enters += 1;
    },
    exit() {
      lock.exits += 1;
    },
  } as never;
}

describe('Storage facade (LuaStringsStorage.pas:143-159 + §5.3)', () => {
  let host: WasmoonLuaHost;
  let engine: WasmoonLuaEngine;

  beforeEach(async () => {
    host = createLuaHost(createMemoryLogger());
    engine = await host.createEngine();
    await host.chunkCache.get('st.lua', 'ST_PLACEHOLDER = true');
    await engine.loadModule('st.lua');
  });

  afterEach(async () => {
    await engine.dispose();
    await host.dispose();
  });

  function bind(storage: TStringsStorageStrings): void {
    const bridge = engine.debugBridge;
    bridge.create('STORAGE', makeStorageSpec(bridge, storage));
  }

  it('TStringsStorage ctor defaults: Tag=0, Enable=true, Status="my status of TStringsStorage"', () => {
    const storage = new TStringsStorageStrings();
    bind(storage);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    expect(run(`return STORAGE.Tag`)).toBe(0);
    expect(run(`return STORAGE.Enable`)).toBe(true);
    expect(run(`return STORAGE.Status`)).toBe(STORAGE_STATUS_DEFAULT);
    expect(STORAGE_STATUS_DEFAULT).toBe('my status of TStringsStorage');
  });

  it('KV default-array access: set/get/remove, Text view', () => {
    const storage = new TStringsStorageStrings();
    bind(storage);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    run(`STORAGE['session'] = 'abc' STORAGE['count'] = '3'`);
    expect(run(`return STORAGE['session']`)).toBe('abc');
    expect(run(`return STORAGE['count']`)).toBe('3');
    expect(run(`return STORAGE['missing']`)).toBe('');
    // Text is the KV file (FPC GetText: trailing line break)
    expect(run(`return STORAGE.Text`)).toBe('session=abc\ncount=3\n');
    run(`STORAGE.Text = 'k1=v1\\nk2=v2'`);
    expect(run(`return STORAGE['k1']`)).toBe('v1');
    expect(run(`return STORAGE['k2']`)).toBe('v2');
    // Remove deletes the name's line; missing key is a silent no-op
    run(`STORAGE.Remove('k1') STORAGE.Remove('nope')`);
    expect(run(`return STORAGE['k1']`)).toBe('');
    expect(run(`return STORAGE['k2']`)).toBe('v2');
    expect(storage.keys()).toEqual(['k2']);
  });

  it('KV names are case-insensitive (TStringList Values via FPC IndexOfName)', () => {
    const storage = new TStringsStorageStrings();
    bind(storage);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    run(`STORAGE['Token'] = 'secret'`);
    expect(run(`return STORAGE['token']`)).toBe('secret');
    expect(storage.getValue('TOKEN')).toBe('secret');
    // case-insensitive overwrite happens in place (FPC SetValue)
    run(`STORAGE['tokEn'] = 'rotated'`);
    expect(storage.getText()).toBe('tokEn=rotated\n');
  });

  it('Tag/Enable/Status typed writes; Free/Destroy are host-owned no-ops', () => {
    const storage = new TStringsStorageStrings();
    bind(storage);
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    run(`STORAGE.Tag = 42 STORAGE.Enable = false STORAGE.Status = 'bypassed'`);
    expect(storage.tag).toBe(42);
    expect(storage.enable).toBe(false);
    expect(storage.status).toBe('bypassed');
    run(`STORAGE.Free() STORAGE.Destroy()`);
    // the shared state survives (host-owned lifecycle)
    expect(run(`return STORAGE.Status`)).toBe('bypassed');
  });

  it('thread-safe via the shared state service: two facades over ONE module storage', () => {
    const bridge = engine.debugBridge;
    const shared = new TStringsStorageStrings();
    bridge.create('STORAGE_A', makeStorageSpec(bridge, shared));
    bridge.create('STORAGE_B', makeStorageSpec(bridge, shared));
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    run(`STORAGE_A['w'] = 'from-a'`);
    expect(run(`return STORAGE_B['w']`)).toBe('from-a');
    run(`STORAGE_B['w'] = 'from-b'`);
    expect(run(`return STORAGE_A['w']`)).toBe('from-b');
    // both facades share the same backing instance (§5.3 per-module object)
    expect(shared.getValue('w')).toBe('from-b');
  });

  it('every facade operation routes through the injected critical-section lock', () => {
    const lock = trackingLock();
    const storage = new TStringsStorageStrings(lock);
    const bridge = engine.debugBridge;
    bridge.create('STORAGE', makeStorageSpec(bridge, storage));
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    const before = lock.enters;
    run(`STORAGE['k'] = 'v' local _ = STORAGE['k'] local _2 = STORAGE.Text STORAGE.Remove('k')`);
    expect(lock.enters).toBeGreaterThan(before);
    expect(lock.exits).toBe(lock.enters); // balanced sections
    expect(lock.enters - before).toBe(4); // set, get, text, remove probe
  });

  it('storageStringsFromMap: TStrings semantics layered on a plain shared map', () => {
    const map = new Map<string, string>();
    const storage = storageStringsFromMap(map);
    storage.setValue('Token', 'abc');
    expect(storage.getValue('token')).toBe('abc');
    expect(map.get('Token')).toBe('abc'); // original casing preserved
    storage.setValue('TOKEN', 'x'); // in-place overwrite keeps the case
    expect([...map.keys()]).toEqual(['Token']);
    storage.setText('a=1\nb= 2  '); // values UNTRIMMED after the separator
    expect(storage.getValue('b')).toBe(' 2  ');
    expect(storage.getText()).toBe('a=1\nb= 2  \n');
    expect(map.get('b')).toBe(' 2  ');
    storage.remove('A');
    expect(storage.keys()).toEqual(['b']);
    // defaults ride the impl delegate
    expect(storage.tag).toBe(0);
    expect(storage.enable).toBe(true);
    expect(storage.status).toBe(STORAGE_STATUS_DEFAULT);
    storage.status = 'set';
    expect(storage.status).toBe('set');
  });

  it('service seam: per-module StorageStrings instances are distinct but shared per id', () => {
    // the §5.3 host service pattern: one StorageStrings per module id,
    // reused by every facade created for that module (dispatcher pattern)
    const backings = new Map<string, TStringsStorageStrings>();
    const forModule = (id: string): TStringsStorageStrings => {
      let s = backings.get(id);
      if (s === undefined) {
        s = new TStringsStorageStrings();
        backings.set(id, s);
      }
      return s;
    };
    const a = forModule(MODULE_ID);
    const b = forModule(MODULE_ID);
    const other = forModule('fedcba9876543210fedcba9876543210');
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    a.setValue('k', 'v');
    expect(b.getValue('k')).toBe('v');
    expect(other.getValue('k')).toBe('');
  });
});
