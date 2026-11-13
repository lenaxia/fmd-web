import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDriftCheck } from '../tools/drift-check.js';
import type { ContractDocument, EventBinding, FacadeTable } from '../types.js';

/**
 * Drift-check acceptance proofs (DESIGN.md §5 CI rule):
 * - exit 0 on the shipped contract.json vs the real FMD2 sources;
 * - exit ≠ 0 when a contract.json row is mutated in a temp copy;
 * - exit 2 when extraction itself fails (unrecognized Pascal pattern).
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
