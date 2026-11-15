import { deflateRawSync, deflateSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaFactory, type LuaEngine } from 'wasmoon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import { gzipInflate } from '../../../src/engine/shims/gzip-shim.js';
import { installRequireShim } from '../../../src/engine/shims/lua-require.js';

/**
 * fmd.gzip proofs (DESIGN.md §5.7, LuaGZip.pas:47-50 + GZIPUtils.pas
 * unzipStream): the golden fixture is a real gzip-encoded body of a real
 * captured seed document (corpus/fixtures/seed/Madara/source.html,
 * `gzip -n -9` — no timestamp/filename fields), plus the Happymh.lua
 * wire shape (`SC01` magic + raw deflate, Happymh.lua:63
 * `require 'fmd.gzip'.Inflate(plain:sub(5))`). Failure paths mirror the
 * Pascal: unzipStream false → logged `GZip.Inflate() unzipStream failed`
 * (module-correlated) → nil, never a Lua error.
 */

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const FIXTURES = join(ROOT, 'server/test/engine/shims/fixtures/gzip');
const CAPTURED_BODY = join(ROOT, 'corpus/fixtures/seed/Madara/source.html');

describe('gzipInflate (JS core, GZIPUtils.unzipStream parity)', (): void => {
  it('decodes the captured golden body byte-identically', (): void => {
    const gz = readFileSync(join(FIXTURES, 'madara-body.html.gz'));
    const out = gzipInflate(gz);
    expect(out).toBeDefined();
    expect(out!.equals(readFileSync(CAPTURED_BODY))).toBe(true);
  });

  it('decodes the Happymh SC01 raw-deflate payload byte-identically', (): void => {
    const payload = readFileSync(join(FIXTURES, 'sc01-payload.bin'));
    expect(payload.subarray(0, 4).toString('latin1')).toBe('SC01');
    const out = gzipInflate(payload.subarray(4));
    expect(out).toBeDefined();
    expect(out!.equals(readFileSync(CAPTURED_BODY))).toBe(true);
  });

  it('auto-detects a zlib-wrapped stream (CMF/FLG + adler32)', (): void => {
    const body = Buffer.from('hello zlib wrapped world', 'utf8');
    const out = gzipInflate(deflateSync(body));
    expect(out!.equals(body)).toBe(true);
  });

  it('rejects a corrupted gzip trailer (CRC32/ISIZE verified, Pascal parity)', (): void => {
    const gz = readFileSync(join(FIXTURES, 'madara-body.html.gz'));
    const corrupted = Buffer.from(gz);
    corrupted[corrupted.length - 5] = (corrupted[corrupted.length - 5] as number) ^ 0xff;
    expect(gzipInflate(corrupted)).toBeUndefined();
  });

  it('rejects raw garbage (raw-deflate path fails)', (): void => {
    expect(gzipInflate(Buffer.from('this is not deflate data at all', 'utf8'))).toBeUndefined();
  });
});

describe("require 'fmd.gzip' (wasmoon end-to-end over the base64 bridge)", (): void => {
  const luaRoot = mkdtempSync(join(tmpdir(), 'fmd-gzip-shim-'));
  const logger = createMemoryLogger();
  let engine: LuaEngine | undefined;

  const b64 = (buf: Buffer): string => buf.toString('base64');

  beforeAll(async (): Promise<void> => {
    mkdirSync(luaRoot, { recursive: true });
    writeFileSync(join(luaRoot, 'placeholder.lua'), 'return true');
    engine = await new LuaFactory().createEngine();
    installRequireShim(engine, {
      luaRoot,
      moduleId: 'Happymh',
      logger,
    });
    // fixtures cross as base64 text (binary through the bridge is lossy)
    engine.global.set('__test_gz_b64', b64(readFileSync(join(FIXTURES, 'madara-body.html.gz'))));
    engine.global.set('__test_sc01_b64', b64(readFileSync(join(FIXTURES, 'sc01-payload.bin'))));
    engine.global.set('__test_plain_b64', b64(readFileSync(CAPTURED_BODY)));
    // test-side producer: raw deflate via node (the engine-side data
    // stays a Lua byte string; base64 keeps the JS↔Lua hops lossless)
    engine.global.set('__test_raw_deflate_b64', (b64Text: string): string =>
      deflateRawSync(Buffer.from(b64Text, 'base64')).toString('base64'),
    );
  });

  afterAll((): void => {
    engine?.global.close();
    rmSync(luaRoot, { recursive: true, force: true });
  });

  it('Inflate decodes the captured gzip fixture byte-identically (golden)', (): void => {
    const r = engine!.doStringSync(`
      local gz = __fmd_b64dec(__test_gz_b64)
      local out = require 'fmd.gzip'.Inflate(gz)
      if out == nil then return 'nil' end
      return __fmd_b64enc(out) == __test_plain_b64
    `) as unknown;
    expect(r).toBe(true);
  });

  it('Inflate decodes the SC01 payload with the exact Happymh.lua flow', (): void => {
    const r = engine!.doStringSync(`
      local payload = __fmd_b64dec(__test_sc01_b64)
      -- Happymh.lua:63 — require 'fmd.gzip'.Inflate(plain:sub(5))
      local out = require 'fmd.gzip'.Inflate(payload:sub(5))
      if out == nil then return 'nil' end
      return __fmd_b64enc(out) == __test_plain_b64
    `) as unknown;
    expect(r).toBe(true);
  });

  it('binary roundtrip is byte-exact for NUL and high bytes', (): void => {
    const r = engine!.doStringSync(`
      local bytes = {}
      for i = 0, 255 do bytes[#bytes + 1] = string.char(i) end
      local data = table.concat(bytes)
      -- producer crosses JS as base64; decode back to raw deflate bytes
      local deflated = __fmd_b64dec(__test_raw_deflate_b64(__fmd_b64enc(data)))
      local out = require 'fmd.gzip'.Inflate(deflated)
      return __fmd_b64enc(out) == __fmd_b64enc(data)
    `) as unknown;
    expect(r).toBe(true);
  });

  it('failure yields nil and logs the Pascal failure line, module-correlated', (): void => {
    logger.clear();
    const r = engine!.doStringSync(`
      local out = require 'fmd.gzip'.Inflate('definitely not a compressed stream')
      return table.pack(out).n
    `) as unknown;
    expect(r).toBe(1); // one value: nil (the Pascal lua_pushlstring never runs)
    const records = logger.forModule('Happymh');
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('error');
    expect(records[0]?.message).toBe('GZip.Inflate() unzipStream failed');
  });

  it('empty input fails like the Pascal (unzipStream on an empty stream)', (): void => {
    const r = engine!.doStringSync(
      `return require 'fmd.gzip'.Inflate('') == nil`,
    ) as unknown;
    expect(r).toBe(true);
  });
});
