import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaFactory, type LuaEngine } from 'wasmoon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runDriftCheck } from '@fmd/contract/tools/drift-check';
import { installRequireShim } from '../../../src/engine/shims/lua-require.js';
import { REQUIRE_SHIM_REGISTRY } from '../../../src/engine/shims/require-registry.js';
import type { RequireShimRegistryEntry } from '@fmd/contract';

/**
 * Require-shim registry proofs (§5.7, audit bucket C — statuses are
 * DERIVED, not hand-edited):
 *
 * 1. GATE PARITY — the shipped contract.json passes the real drift
 *    check when the real loader registry (REQUIRE_SHIM_REGISTRY, the
 *    single source of truth consumed by installRequireShim itself) is
 *    attached; this is exactly what the sanctioned CLI
 *    (scripts/contract-drift-check.ts) gates on.
 * 2. MUTATION — a lying status (any divergence between contract.json
 *    and the registry) fails the gate with a pinpoint message.
 * 3. RUNTIME — the registry agrees with what a real wasmoon engine
 *    actually serves: every non-planned row `require`s successfully,
 *    every planned row fails (loader cannot drift from the registry).
 */

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const realLuaDir = resolve(ROOT, '..', 'FMD2', 'baseunits', 'lua');
const realContractPath = join(ROOT, 'contract', 'contract.json');

describe('REQUIRE_SHIM_REGISTRY — gate parity with the shipped contract.json', (): void => {
  it('covers every contract.json requireShims row (13 entries)', (): void => {
    const doc = JSON.parse(readFileSync(realContractPath, 'utf8')) as {
      readonly requireShims: readonly { readonly require: string }[];
    };
    const contractRows = doc.requireShims.map((r): string => r.require).sort();
    const registryRows = REQUIRE_SHIM_REGISTRY.map((e): string => e.require).sort();
    expect(registryRows).toEqual(contractRows);
    expect(REQUIRE_SHIM_REGISTRY).toHaveLength(13);
  });

  it('the real drift check passes with the real registry attached (gate parity)', (): void => {
    const result = runDriftCheck({
      contractPath: realContractPath,
      luaDir: realLuaDir,
      requireRegistry: REQUIRE_SHIM_REGISTRY,
    });
    expect(result.messages).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('MUTATION: a lying status fails the gate (implemented → planned)', (): void => {
    const tempDir = mkdtempSync(join(tmpdir(), 'fmd-require-registry-'));
    try {
      const doc = JSON.parse(readFileSync(realContractPath, 'utf8')) as {
        readonly requireShims: readonly {
          readonly require: string;
          readonly fmd2Unit: string;
          readonly implementation: string;
          readonly status: string;
        }[];
      };
      const lying = {
        ...doc,
        requireShims: doc.requireShims.map((r) =>
          r.require === 'fmd.duktape' ? { ...r, status: 'planned' } : r,
        ),
      };
      const mutatedPath = join(tempDir, 'contract.json');
      writeFileSync(mutatedPath, JSON.stringify(lying, null, 2));
      const result = runDriftCheck({
        contractPath: mutatedPath,
        luaDir: realLuaDir,
        requireRegistry: REQUIRE_SHIM_REGISTRY,
      });
      expect(result.exitCode).toBe(1);
      expect(result.messages.join('\n')).toContain(
        'requireShims["fmd.duktape"].status: contract=planned registry=implemented',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('MUTATION: an upgraded stub fails the gate (stub → implemented)', (): void => {
    const tempDir = mkdtempSync(join(tmpdir(), 'fmd-require-registry-'));
    try {
      const doc = JSON.parse(readFileSync(realContractPath, 'utf8')) as {
        readonly requireShims: readonly {
          readonly require: string;
          readonly fmd2Unit: string;
          readonly implementation: string;
          readonly status: string;
        }[];
      };
      const lying = {
        ...doc,
        requireShims: doc.requireShims.map((r) =>
          r.require === 'subprocess' ? { ...r, status: 'implemented' } : r,
        ),
      };
      const mutatedPath = join(tempDir, 'contract.json');
      writeFileSync(mutatedPath, JSON.stringify(lying, null, 2));
      const result = runDriftCheck({
        contractPath: mutatedPath,
        luaDir: realLuaDir,
        requireRegistry: REQUIRE_SHIM_REGISTRY,
      });
      expect(result.exitCode).toBe(1);
      expect(result.messages.join('\n')).toContain(
        'requireShims["subprocess"].status: contract=implemented registry=stub',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * The concrete probe a registry row is exercised with at runtime:
 * loaderKey for host libs / preloads, a representative file chunk for
 * the file searcher rows, and the bare require name for planned rows
 * (which must FAIL to resolve).
 */
function runtimeProbe(entry: RequireShimRegistryEntry): string {
  if (entry.servedBy === 'file-chunk') {
    return 'utils.json';
  }
  if (entry.loaderKey !== null) {
    return entry.loaderKey;
  }
  return entry.require;
}

describe('REQUIRE_SHIM_REGISTRY — runtime agreement with a real wasmoon loader', (): void => {
  const luaRoot = mkdtempSync(join(tmpdir(), 'fmd-require-runtime-'));
  const factory = new LuaFactory();
  let engine: LuaEngine;

  beforeAll(async (): Promise<void> => {
    mkdirSync(join(luaRoot, 'utils'), { recursive: true });
    mkdirSync(join(luaRoot, 'templates'), { recursive: true });
    writeFileSync(join(luaRoot, 'utils', 'json.lua'), 'return { _chunk = "utils.json" }');
    writeFileSync(join(luaRoot, 'templates', 'sample.lua'), 'return { _chunk = "templates.sample" }');
    engine = await factory.createEngine();
    installRequireShim(engine, { luaRoot });
  });

  afterAll((): void => {
    engine.global.close();
    rmSync(luaRoot, { recursive: true, force: true });
  });

  it('every non-planned row resolves through require; every planned row fails', (): void => {
    const summary: string[] = [];
    for (const entry of REQUIRE_SHIM_REGISTRY) {
      const probe = runtimeProbe(entry);
      if (entry.status === 'planned') {
        expect(() => engine.doStringSync(`return require '${probe}'`), `${entry.require} must NOT resolve`)
          .toThrow();
        summary.push(`${entry.require}: unresolved (planned)`);
      } else {
        const lib = engine.doStringSync(`return require '${probe}'`) as unknown;
        expect(lib, `${entry.require} must resolve via ${probe}`).toBeTruthy();
        summary.push(`${entry.require}: resolved via ${probe} (${entry.status})`);
      }
    }
    // Fail-loud record of what the loader serves — the drift gate holds
    // contract.json to exactly this reality.
    expect(summary.length).toBe(REQUIRE_SHIM_REGISTRY.length);
  });

  it('both file-chunk trees resolve (utils.* AND templates.*)', (): void => {
    const utils = engine.doStringSync(`return require 'utils.json'`) as Record<string, string>;
    const templates = engine.doStringSync(`return require 'templates.sample'`) as Record<string, string>;
    expect(utils['_chunk']).toBe('utils.json');
    expect(templates['_chunk']).toBe('templates.sample');
  });

  it('the subprocess row serves the §5.7 loader key (fmd.subprocess), not the bare name', (): void => {
    const stub = engine.doStringSync(`return require 'fmd.subprocess'`) as Record<string, unknown>;
    expect(stub['RunCommand']).toBeTruthy();
    expect(stub['RunCommandHide']).toBeTruthy();
    // Denied stub semantics are unchanged: RunCommand* return nil.
    const result = engine.doStringSync(
      `return require 'fmd.subprocess'.RunCommand('x', '')`,
    ) as unknown;
    expect(result).toBeUndefined();
  });
});
