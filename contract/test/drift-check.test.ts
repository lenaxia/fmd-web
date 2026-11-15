import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { diffRequireShims, runDriftCheck } from '../tools/drift-check.js';
import type { ContractDocument, EventBinding, FacadeTable, RequireShimRegistryEntry } from '../types.js';

/**
 * Drift-check acceptance proofs (DESIGN.md §5 CI rule):
 * - exit 0 on the shipped contract.json vs the real FMD2 sources;
 * - exit ≠ 0 when a contract.json row is mutated in a temp copy;
 * - exit 2 when extraction itself fails (unrecognized Pascal pattern);
 * - `requireShims[].status` is DERIVED: any status diverging from the
 *   shim loader registry (server/src/engine/shims/require-registry.ts,
 *   the single source of truth) fails the gate — proven by mutation.
 */

const realLuaDir = resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
  '..',
  'FMD2',
  'baseunits',
  'lua',
);
const realContractPath = new URL('../contract.json', import.meta.url);

let tempDir: string;

beforeEach((): void => {
  tempDir = mkdtempSync(join(tmpdir(), 'fmd-contract-drift-'));
});

afterEach((): void => {
  rmSync(tempDir, { recursive: true, force: true });
});

type ContractMutator = (doc: ContractDocument) => ContractDocument;

function writeTempContract(mutate: ContractMutator): string {
  const doc = JSON.parse(readFileSync(realContractPath, 'utf8')) as ContractDocument;
  writeFileSync(join(tempDir, 'contract.json'), JSON.stringify(mutate(doc), null, 2));
  return join(tempDir, 'contract.json');
}

describe('runDriftCheck — shipped state', (): void => {
  it('exits 0 on the shipped contract.json against the real FMD2 sources', (): void => {
    const result = runDriftCheck({
      contractPath: fileURLToPath(realContractPath),
      luaDir: realLuaDir,
    });
    expect(result.messages).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('exits 2 when the contract document is missing', (): void => {
    const result = runDriftCheck({
      contractPath: join(tempDir, 'does-not-exist.json'),
      luaDir: realLuaDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.messages[0]).toContain('contract document not found');
  });

  it('exits 2 when the FMD2 lua dir is missing', (): void => {
    const result = runDriftCheck({
      contractPath: fileURLToPath(realContractPath),
      luaDir: join(tempDir, 'no-such-lua-dir'),
    });
    expect(result.exitCode).toBe(2);
    expect(result.messages[0]).toContain('FMD2 lua dir not found');
  });

  it('exits 2 when extraction hits an unrecognized Pascal pattern', (): void => {
    const badLuaDir = join(tempDir, 'lua');
    mkdirSync(badLuaDir);
    // All 7 units must exist; only the dispatcher body is corrupted.
    for (const unit of [
      'LuaWebsiteModuleHandler.pas', 'LuaXQuery.pas', 'LuaImagePuzzle.pas',
      'LuaDuktape.pas', 'LuaStringsStorage.pas', 'LuaCrypto.pas',
    ]) {
      writeFileSync(join(badLuaDir, unit), readFileSync(join(realLuaDir, unit)));
    }
    writeFileSync(
      join(badLuaDir, 'LuaWebsiteModules.pas'),
      [
        'unit LuaWebsiteModules;',
        'implementation',
        '',
        'function DoGetInfo(const AMangaInfo: TMangaInformation; const AURL: String;',
        '  const AModule: TModuleContainer): Byte;',
        'var',
        '  L: TLuaWebsiteModuleHandler;',
        'begin',
        '  Result := INFORMATION_NOT_FOUND;',
        '  with TLuaWebsiteModule(AModule.LuaModule) do',
        '    try',
        '      L := GetLuaWebsiteModuleHandler(AModule);',
        '      BrandNewUnrecognizedBinding(L.Handle);',
        '      L.CallFunction(OnGetInfo);',
        '      Result := lua_tointeger(L.Handle, -1);',
        '    except',
        '      on E: Exception do',
        "        SendLogException('LUA>DoGetInfo', E);",
        '    end;',
        'end;',
        '',
        'end.',
      ].join('\n'),
    );
    const result = runDriftCheck({
      contractPath: fileURLToPath(realContractPath),
      luaDir: badLuaDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.messages[0]).toContain('extraction failed');
    expect(result.messages[0]).toContain('BrandNewUnrecognizedBinding');
    expect(result.messages[0]).toMatch(/LuaWebsiteModules\.pas:\d+/);
  });
});

describe('runDriftCheck — mutation detection on a temp contract copy', (): void => {
  it('detects a mutated global list', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: doc.events.map((e): EventBinding =>
        e.event === 'GetInfo' ? { ...e, globals: ['MODULE', 'MANGAINFO', 'URL'] } : e,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.messages.join('\n')).toContain('events[GetInfo].globals');
    expect(result.messages.join('\n')).toContain('HTTP');
  });

  it('detects a mutated return kind', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: doc.events.map((e): EventBinding =>
        e.event === 'SaveImage' ? { ...e, returns: 'boolean' as const } : e,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('events[SaveImage].returns');
  });

  it('detects a mutated constants binding', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: doc.events.map((e): EventBinding =>
        e.event === 'Login' ? { ...e, constants: 'none' as const } : e,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('events[Login].constants');
  });

  it('detects a mutated read-back list', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: doc.events.map((e): EventBinding =>
        e.event === 'GetDirectoryPageNumber' ? { ...e, readBack: [] } : e,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('events[GetDirectoryPageNumber].readBack');
  });

  it('detects a dropped contract row', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: doc.events.filter((e): boolean => e.event !== 'AfterImageSaved'),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain(
      'events: extractor found 15 dispatchers but contract.json has 14 rows',
    );
  });

  it('detects a fabricated contract row with no Pascal counterpart', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: [
        ...doc.events,
        {
          event: 'LoginExtra', returns: 'boolean', globals: ['MODULE'],
          readBack: [], constants: 'none',
        },
      ],
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain(
      'events: contract.json row "LoginExtra" has no counterpart in the Pascal dispatchers',
    );
  });

  it('detects a mutated facade method table', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      facades: doc.facades.map((f): FacadeTable =>
        f.name === 'Crypto'
          ? { ...f, methods: f.methods.filter((m): boolean => m.name !== 'RC4') }
          : f,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('facades[Crypto].methods');
  });

  it('detects a mutated facade property table', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      facades: doc.facades.map((f): FacadeTable =>
        f.name === 'Storage'
          ? { ...f, properties: f.properties.filter((p): boolean => p.name !== 'Tag') }
          : f,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('facades[Storage].properties');
  });

  it('rejects a contract row that lacks MODULE as first global', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: doc.events.map((e): EventBinding =>
        e.event === 'TaskStart' ? { ...e, globals: e.globals.filter((g): boolean => g !== 'MODULE') } : e,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('MODULE must be the first bound global');
  });

  it('rejects a fabricated ACCOUNT global (the classic §5.2 error)', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: doc.events.map((e): EventBinding =>
        e.event === 'Login' ? { ...e, globals: ['MODULE', 'HTTP', 'ACCOUNT'] } : e,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('ACCOUNT global must never appear');
  });

  it('rejects a read-back global that is not bound', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      events: doc.events.map((e): EventBinding =>
        e.event === 'AfterImageSaved' ? { ...e, readBack: ['URL'] } : e,
      ),
    }));
    const result = runDriftCheck({ contractPath: mutated, luaDir: realLuaDir });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('read-back global URL is not a bound global');
  });
});

/**
 * Loader-registry fixture mirroring
 * server/src/engine/shims/require-registry.ts (the single source of
 * truth the contract tests cannot import — the reference direction is
 * contract ← server). If contract.json's requireShims statuses change,
 * the real registry changes first and this fixture follows; the gate
 * (scripts/contract-drift-check.ts) always cross-checks against the
 * REAL registry.
 */
const registryFixture: readonly RequireShimRegistryEntry[] = [
  { require: 'fmd.env', loaderKey: 'fmd.env', servedBy: 'host-lib', status: 'implemented' },
  { require: 'fmd.crypto', loaderKey: 'fmd.crypto', servedBy: 'package-preload', status: 'implemented' },
  { require: 'fmd.duktape', loaderKey: 'fmd.duktape', servedBy: 'host-lib', status: 'implemented' },
  { require: 'fmd.gzip', loaderKey: 'fmd.gzip', servedBy: 'package-preload', status: 'implemented' },
  { require: 'fmd.fileutil', loaderKey: 'fmd.fileutil', servedBy: 'host-lib', status: 'partial', gap: 'SerializeAndMaintainNames' },
  { require: 'fmd.imagepuzzle', loaderKey: 'fmd.imagepuzzle', servedBy: 'package-preload', status: 'implemented' },
  { require: 'fmd.logger', loaderKey: 'fmd.logger', servedBy: 'host-lib', status: 'implemented' },
  { require: 'fmd.mangafoxwatermark', loaderKey: 'fmd.mangafoxwatermark', servedBy: 'host-lib', status: 'implemented' },
  { require: 'fmd.pcre2', loaderKey: 'fmd.pcre2', servedBy: 'host-lib', status: 'implemented' },
  { require: 'fmd.strings', loaderKey: null, servedBy: 'none', status: 'planned' },
  { require: 'pb', loaderKey: 'pb', servedBy: 'package-preload', status: 'implemented' },
  { require: 'subprocess', loaderKey: 'fmd.subprocess', servedBy: 'host-lib', status: 'stub' },
  { require: 'utils.* / templates.*', loaderKey: null, servedBy: 'file-chunk', status: 'implemented' },
];

function mutateRequireShimStatus(
  doc: ContractDocument,
  requireName: string,
  status: ContractDocument['requireShims'][number]['status'],
): ContractDocument {
  return {
    ...doc,
    requireShims: doc.requireShims.map((r) =>
      r.require === requireName ? { ...r, status } : r,
    ),
  };
}

describe('runDriftCheck — requireShims[].status vs the shim loader registry', (): void => {
  it('exits 0 on the shipped contract.json when statuses match the registry', (): void => {
    const result = runDriftCheck({
      contractPath: fileURLToPath(realContractPath),
      luaDir: realLuaDir,
      requireRegistry: registryFixture,
    });
    expect(result.messages).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('fails when a status claims LESS than the loader implements (implemented → planned lie)', (): void => {
    const mutated = writeTempContract((doc): ContractDocument =>
      mutateRequireShimStatus(doc, 'fmd.env', 'planned'),
    );
    const result = runDriftCheck({
      contractPath: mutated,
      luaDir: realLuaDir,
      requireRegistry: registryFixture,
    });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain(
      'requireShims["fmd.env"].status: contract=planned registry=implemented',
    );
  });

  it('fails when a status claims MORE than the loader registers (planned → implemented lie)', (): void => {
    // fmd.strings is the shipped planned row (imagepuzzle/mangafoxwatermark
    // are genuinely implemented now, so they no longer work as the lie victim).
    const mutated = writeTempContract((doc): ContractDocument =>
      mutateRequireShimStatus(doc, 'fmd.strings', 'implemented'),
    );
    const result = runDriftCheck({
      contractPath: mutated,
      luaDir: realLuaDir,
      requireRegistry: registryFixture,
    });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain(
      'requireShims["fmd.strings"].status: contract=implemented registry=planned',
    );
  });

  it('fails when a stub status is upgraded behind the registry\'s back', (): void => {
    const mutated = writeTempContract((doc): ContractDocument =>
      mutateRequireShimStatus(doc, 'subprocess', 'implemented'),
    );
    const result = runDriftCheck({
      contractPath: mutated,
      luaDir: realLuaDir,
      requireRegistry: registryFixture,
    });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain(
      'requireShims["subprocess"].status: contract=implemented registry=stub',
    );
  });

  it('fails when a contract row has no loader registry row', (): void => {
    const mutated = writeTempContract((doc): ContractDocument => ({
      ...doc,
      requireShims: [
        ...doc.requireShims,
        { require: 'fmd.brandnew', fmd2Unit: 'LuaBrandNew', implementation: 'x', status: 'implemented' },
      ],
    }));
    const result = runDriftCheck({
      contractPath: mutated,
      luaDir: realLuaDir,
      requireRegistry: registryFixture,
    });
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain(
      'requireShims: contract.json row "fmd.brandnew" has no loader registry row',
    );
  });
});

describe('diffRequireShims — registry structural invariants', (): void => {
  const contractRows = (statuses: readonly (readonly [string, string])[]): readonly { require: string; status: string }[] =>
    statuses.map(([require, status]): { require: string; status: string } => ({ require, status }));

  it('accepts the shipped registry shape', (): void => {
    expect(diffRequireShims(
      registryFixture.map((e) => ({ require: e.require, status: e.status })),
      registryFixture,
    )).toEqual([]);
  });

  it('rejects a partial row without a gap note', (): void => {
    const registry: readonly RequireShimRegistryEntry[] = [
      { require: 'fmd.fileutil', loaderKey: 'fmd.fileutil', servedBy: 'host-lib', status: 'partial' },
    ];
    expect(
      diffRequireShims([{ require: 'fmd.fileutil', status: 'partial' }], registry).join('\n'),
    ).toContain('fmd.fileutil"]: partial status requires a gap note');
  });

  it('rejects a gap note on a non-partial row', (): void => {
    const registry: readonly RequireShimRegistryEntry[] = [
      { require: 'fmd.env', loaderKey: 'fmd.env', servedBy: 'host-lib', status: 'implemented', gap: 'none really' },
    ];
    expect(
      diffRequireShims([{ require: 'fmd.env', status: 'implemented' }], registry).join('\n'),
    ).toContain('fmd.env"]: gap note is only allowed on partial status');
  });

  it('rejects a planned row claiming loader registration', (): void => {
    const registry: readonly RequireShimRegistryEntry[] = [
      { require: 'fmd.gzip', loaderKey: 'fmd.gzip', servedBy: 'host-lib', status: 'planned' },
    ];
    expect(
      diffRequireShims([{ require: 'fmd.gzip', status: 'planned' }], registry).join('\n'),
    ).toContain('fmd.gzip"]: planned status must not claim loader registration');
  });

  it('rejects a non-planned row that is not actually served', (): void => {
    const registry: readonly RequireShimRegistryEntry[] = [
      { require: 'fmd.strings', loaderKey: null, servedBy: 'none', status: 'implemented' },
    ];
    expect(
      diffRequireShims([{ require: 'fmd.strings', status: 'implemented' }], registry).join('\n'),
    ).toContain('fmd.strings"]: implemented status requires loader registration but servedBy=none');
  });

  it('rejects duplicate registry rows in both directions of drift', (): void => {
    const registry: readonly RequireShimRegistryEntry[] = [
      { require: 'pb', loaderKey: 'pb', servedBy: 'package-preload', status: 'implemented' },
      { require: 'pb', loaderKey: 'pb', servedBy: 'package-preload', status: 'implemented' },
    ];
    const messages = diffRequireShims(contractRows([['pb', 'implemented']]), registry);
    expect(messages.join('\n')).toContain('duplicate rows for "pb"');
  });

  it('rejects a registry row missing from contract.json', (): void => {
    const registry: readonly RequireShimRegistryEntry[] = [
      { require: 'fmd.env', loaderKey: 'fmd.env', servedBy: 'host-lib', status: 'implemented' },
      { require: 'pb', loaderKey: 'pb', servedBy: 'package-preload', status: 'implemented' },
    ];
    expect(
      diffRequireShims(contractRows([['fmd.env', 'implemented']]), registry).join('\n'),
    ).toContain('loader registry row "pb" has no contract.json row');
  });
});
