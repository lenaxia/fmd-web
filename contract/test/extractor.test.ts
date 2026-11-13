import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ContractExtractionError,
  extractContractFacts,
  extractCryptoMethodNames,
  extractDuktapeMethods,
  extractEvents,
  extractImagePuzzleSurface,
  extractLuaRegNames,
  extractModuleBinding,
  extractStorageSurface,
  extractTXQueryMethods,
} from '../tools/extract.js';
import type { ContractDocument, FacadeTable } from '../types.js';

/**
 * Unit tests for the conservative §5 extractor (DESIGN.md §5.2):
 * every vocabulary call gets a fixture; every deviation fails loudly
 * with file:line. The integration half runs the extractor on the real
 * FMD2 sources and asserts equality with contract.json and the §5.2
 * tables in DESIGN.md.
 */

const contract = JSON.parse(
  readFileSync(new URL('../contract.json', import.meta.url), 'utf8'),
) as ContractDocument;

const realLuaDir = resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
  '..',
  'FMD2',
  'baseunits',
  'lua',
);

/** Wrap a dispatcher body into a minimal parseable Pascal unit. */
function dispatcherUnit(event: string, bodyLines: readonly string[]): string {
  return [
    'unit Fixture;',
    'interface',
    'implementation',
    '',
    `function Do${event}(const AModule: TModuleContainer): Boolean;`,
    'var',
    '  L: TLuaWebsiteModuleHandler;',
    'begin',
    ...bodyLines,
    'end;',
    '',
    'end.',
    '',
  ].join('\n');
}

/** The canonical boolean-event plumbing around the vocabulary lines. */
function boolDispatcher(...vocabulary: readonly string[]): (event: string) => string {
  return (event: string): string =>
    dispatcherUnit(event, [
      '  Result := False;',
      '  with TLuaWebsiteModule(AModule.LuaModule) do',
      '    try',
      '      L := GetLuaWebsiteModuleHandler(AModule);',
      ...vocabulary,
      `      L.CallFunction(On${event});`,
      '      Result := lua_toboolean(L.Handle, -1);',
      '    except',
      '      on E: Exception do',
      `        SendLogException('LUA>Do${event}', E);`,
      '    end;',
    ]);
}

describe('extractEvents — vocabulary coverage', (): void => {
  it('binds an object global via L.LoadObject', (): void => {
    const { events } = extractEvents(
      boolDispatcher("L.LoadObject('TASK', ATask, @luaDownloadTaskMetaTable);")('TaskStart'),
      'fixture.pas',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.globals).toEqual(['MODULE', 'TASK']);
    expect(events[0]?.returns).toBe('boolean');
    expect(events[0]?.readBack).toEqual([]);
    expect(events[0]?.constants).toBe('none');
  });

  it('binds integer globals via luaPushIntegerGlobal', (): void => {
    const { events } = extractEvents(
      boolDispatcher(
        "luaPushIntegerGlobal(L.Handle, 'WORKID', ADownloadThread.WorkId);",
      )('GetImageURL'),
      'fixture.pas',
    );
    expect(events[0]?.globals).toEqual(['MODULE', 'WORKID']);
  });

  it('binds string globals via luaPushStringGlobal', (): void => {
    const { events } = extractEvents(
      boolDispatcher("luaPushStringGlobal(L.Handle, 'URL', AURL);")('GetPageNumber'),
      'fixture.pas',
    );
    expect(events[0]?.globals).toEqual(['MODULE', 'URL']);
  });

  it('records LuaPushNetStatus as net-status constants', (): void => {
    const { events } = extractEvents(
      boolDispatcher('LuaPushNetStatus(L.Handle);')('GetInfo'),
      'fixture.pas',
    );
    expect(events[0]?.constants).toBe('net-status');
  });

  it('records LuaPushAccountStatus as account-status constants', (): void => {
    const { events } = extractEvents(
      boolDispatcher('LuaPushAccountStatus(L.Handle);')('AccountState'),
      'fixture.pas',
    );
    expect(events[0]?.constants).toBe('account-status');
  });

  it('derives return kind code from lua_tointeger', (): void => {
    const unit = dispatcherUnit('GetNameAndLink', [
      '  Result := INFORMATION_NOT_FOUND;',
      '  with TLuaWebsiteModule(AModule.LuaModule) do',
      '    try',
      '      L := GetLuaWebsiteModuleHandler(AModule);',
      '      LuaPushNetStatus(L.Handle);',
      "      L.LoadObject('HTTP', AHTTP, @luaHTTPSendThreadAddMetaTable);",
      '      L.CallFunction(OnGetNameAndLink);',
      '      Result := lua_tointeger(L.Handle, -1);',
      '    except',
      '      on E: Exception do',
      "        SendLogException('LUA>DoGetNameAndLink', E);",
      '    end;',
    ]);
    const { events } = extractEvents(unit, 'fixture.pas');
    expect(events[0]?.returns).toBe('code');
  });

  it('derives return kind string from luaToString', (): void => {
    const unit = dispatcherUnit('SaveImage', [
      "  Result := '';",
      '  with TLuaWebsiteModule(AModule.LuaModule) do',
      '    try',
      '      L := GetLuaWebsiteModuleHandler(AModule);',
      "      L.LoadObject('HTTP', ADownloadThread.HTTP, @luaHTTPSendThreadAddMetaTable);",
      "      luaPushStringGlobal(L.Handle, 'PATH', APath);",
      "      luaPushStringGlobal(L.Handle, 'FILENAME', AName);",
      '      L.CallFunction(OnSaveImage);',
      '      Result := luaToString(L.Handle, -1);',
      '    except',
      '      on E: Exception do',
      "        SendLogException('LUA>DoSaveImage', E);",
      '    end;',
    ]);
    const { events } = extractEvents(unit, 'fixture.pas');
    expect(events[0]?.returns).toBe('string');
    expect(events[0]?.globals).toEqual(['MODULE', 'HTTP', 'PATH', 'FILENAME']);
  });

  it('records the lua_getglobal read-back idiom (guard + integer assignment)', (): void => {
    const unit = dispatcherUnit('GetDirectoryPageNumber', [
      '  Result := INFORMATION_NOT_FOUND;',
      '  with TLuaWebsiteModule(AModule.LuaModule) do',
      '    try',
      '      L := GetLuaWebsiteModuleHandler(AModule);',
      '      LuaPushNetStatus(L.Handle);',
      "      L.LoadObject('HTTP', AHTTP, @luaHTTPSendThreadAddMetaTable);",
      "      L.LoadObject('UPDATELIST', AUpdateListManager, @luaUpdateListManagerAddMetaTable);",
      "      luaPushIntegerGlobal(L.Handle, 'PAGENUMBER', APage);",
      "      luaPushIntegerGlobal(L.Handle, 'WORKPTR', AWorkPtr);",
      '      L.CallFunction(OnGetDirectoryPageNumber);',
      '      Result := lua_tointeger(L.Handle, -1);',
      "      lua_getglobal(L.Handle, 'PAGENUMBER');",
      '      if not lua_isnoneornil(L.Handle, -1) then',
      '        APage := lua_tointeger(L.Handle, -1);',
      '    except',
      '      on E: Exception do',
      "        SendLogException('LUA>DoGetDirectoryPageNumber', E);",
      '    end;',
    ]);
    const { events } = extractEvents(unit, 'fixture.pas');
    expect(events[0]?.readBack).toEqual(['PAGENUMBER']);
    expect(events[0]?.returns).toBe('code');
    expect(events[0]?.constants).toBe('net-status');
    expect(events[0]?.globals).toEqual(['MODULE', 'HTTP', 'UPDATELIST', 'PAGENUMBER', 'WORKPTR']);
  });

  it('preserves source binding order across many globals', (): void => {
    const { events } = extractEvents(
      boolDispatcher(
        "L.LoadObject('TASK', ATask, @m1);",
        "L.LoadObject('HTTP', AHTTP, @m2);",
        "luaPushIntegerGlobal(L.Handle, 'WORKID', 0);",
        "luaPushStringGlobal(L.Handle, 'URL', AURL);",
      )('DownloadImage'),
      'fixture.pas',
    );
    expect(events[0]?.globals).toEqual(['MODULE', 'TASK', 'HTTP', 'WORKID', 'URL']);
  });

  it('reports Do* functions that are not event dispatchers', (): void => {
    const unit = [
      'unit Fixture;',
      'implementation',
      '',
      'function DoInit(const AFileName: String): Boolean;',
      'var',
      '  L: Plua_State;',
      'begin',
      '  L := LuaNewBaseState;',
      '  Result := True;',
      'end;',
      '',
      'end.',
    ].join('\n');
    const { events, nonDispatcherDoFunctions } = extractEvents(unit, 'fixture.pas');
    expect(events).toHaveLength(0);
    expect(nonDispatcherDoFunctions).toEqual(['DoInit']);
  });
});

describe('extractEvents — loud failures', (): void => {
  it('throws on any unrecognized statement, with file and line', (): void => {
    const unit = boolDispatcher("SomeUnknownCall(L.Handle, 'X');")('TaskStart');
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(ContractExtractionError);
    try {
      extractEvents(unit, 'fixture.pas');
      expect.unreachable('must have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ContractExtractionError);
      const e = err as ContractExtractionError;
      expect(e.file).toBe('fixture.pas');
      expect(e.line).toBeGreaterThan(0);
      expect(e.message).toContain('fixture.pas:');
      expect(e.message).toContain('SomeUnknownCall');
    }
  });

  it('throws when the dispatched event name does not match the dispatcher', (): void => {
    const unit = boolDispatcher("L.LoadObject('TASK', ATask, @m);")('TaskStart')
      .replace('L.CallFunction(OnTaskStart);', 'L.CallFunction(OnGetInfo);');
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/DoTaskStart must call exactly L\.CallFunction\(OnTaskStart\); saw OnGetInfo/);
  });

  it('throws when no event function is called at all', (): void => {
    const unit = dispatcherUnit('TaskStart', [
      '  Result := False;',
      '  with TLuaWebsiteModule(AModule.LuaModule) do',
      '    try',
      '      L := GetLuaWebsiteModuleHandler(AModule);',
      "      L.LoadObject('TASK', ATask, @m);",
      '      Result := lua_toboolean(L.Handle, -1);',
      '    except',
      '      on E: Exception do',
      "        SendLogException('LUA>DoTaskStart', E);",
      '    end;',
    ]);
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/DoTaskStart must call exactly L\.CallFunction\(OnTaskStart\); saw no CallFunction/);
  });

  it('throws when the dispatcher never reads a return value', (): void => {
    const unit = dispatcherUnit('TaskStart', [
      '  Result := False;',
      '  with TLuaWebsiteModule(AModule.LuaModule) do',
      '    try',
      '      L := GetLuaWebsiteModuleHandler(AModule);',
      "      L.LoadObject('TASK', ATask, @m);",
      '      L.CallFunction(OnTaskStart);',
      '    except',
      '      on E: Exception do',
      "        SendLogException('LUA>DoTaskStart', E);",
      '    end;',
    ]);
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/never reads a return value/);
  });

  it('throws when a return value is read twice', (): void => {
    const unit = boolDispatcher("L.LoadObject('TASK', ATask, @m);")('TaskStart')
      .replace(
        'Result := lua_toboolean(L.Handle, -1);',
        'Result := lua_toboolean(L.Handle, -1);\n      Result := lua_toboolean(L.Handle, -1);',
      );
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/reads its return value twice/);
  });

  it('throws on a bare integer assignment with no lua_getglobal before it', (): void => {
    const unit = boolDispatcher(
      "L.LoadObject('TASK', ATask, @m);",
      'X := lua_tointeger(L.Handle, -1);',
    )('TaskStart');
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/outside a lua_getglobal read-back/);
  });

  it('throws when the same global is bound twice', (): void => {
    const unit = boolDispatcher(
      "L.LoadObject('HTTP', AHTTP, @m);",
      "L.LoadObject('HTTP', AHTTP2, @m);",
    )('TaskStart');
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/global HTTP bound twice/);
  });

  it('throws when both constant tables are pushed', (): void => {
    const unit = boolDispatcher('LuaPushNetStatus(L.Handle);', 'LuaPushAccountStatus(L.Handle);')(
      'TaskStart',
    );
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/binds both net-status and account-status/);
  });

  it('throws when a global name is not a valid Lua global identifier', (): void => {
    const unit = boolDispatcher("L.LoadObject('bad_name', X, @m);")('TaskStart');
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/invalid global name/);
  });

  it('throws when a function lacks a closing column-0 end;', (): void => {
    const unit = boolDispatcher("L.LoadObject('TASK', ATask, @m);")('TaskStart')
      .replace(/\nend;\n\nend\.\n$/, '\n');
    expect((): void => {
      extractEvents(unit, 'fixture.pas');
    }).toThrow(/no column-0 closing "end;"/);
  });
});

describe('extractModuleBinding — MODULE everywhere rule', (): void => {
  it('verifies a handler that pushes MODULE before every call', (): void => {
    const handler = [
      'unit FixtureHandler;',
      'implementation',
      '',
      'function TLuaWebsiteModuleHandler.LoadModule(const AModule: Pointer): TLuaWebsiteModuleHandler;',
      'begin',
      '  if FLoadedModule = AModule then',
      '    Exit(Self)',
      '  else',
      '  begin',
      '    NewHandle;',
      '    FLoadedModule := nil;',
      '  end;',
      '  M:=TLuaWebsiteModule(TModuleContainer(AModule).LuaModule);',
      '  M.LuaDoMe(FHandle);',
      '  M.LuaPushMe(FHandle);',
      '  FLoadedChunks.AddObject(M.Container.FileName, M.Container.ByteCode);',
      '  FLoadedModule := AModule;',
      '  Result := Self;',
      'end;',
      '',
      'end.',
    ].join('\n');
    expect(extractModuleBinding(handler, 'fixture-handler.pas')).toBe(true);
  });

  it('fails loudly when the handler stops pushing MODULE', (): void => {
    const handler = [
      'unit FixtureHandler;',
      'implementation',
      '',
      'function TLuaWebsiteModuleHandler.LoadModule(const AModule: Pointer): TLuaWebsiteModuleHandler;',
      'begin',
      '  M.LuaDoMe(FHandle);',
      '  FLoadedChunks.AddObject(M.Container.FileName, M.Container.ByteCode);',
      '  Result := Self;',
      'end;',
      '',
      'end.',
    ].join('\n');
    expect((): void => {
      extractModuleBinding(handler, 'fixture-handler.pas');
    }).toThrow(/MODULE binding unverified/);
  });
});

describe('facade registration-table extractors', (): void => {
  const imagePuzzleFixture = [
    'unit FixtureImagePuzzle;',
    'implementation',
    'const',
    '  constructs: packed array [0..2] of luaL_Reg = (',
    "    (name: 'New'; func: @puzzle_create),",
    "    (name: 'Create'; func: @puzzle_create),",
    '    (name: nil; func: nil)',
    '    );',
    '  props: packed array[0..2] of lual_Reg_prop = (',
    "    (name: 'HorBlock'; funcget: @gethor; funcset: nil),",
    "    (name: 'VerBlock'; funcget: @getver; funcset: nil),",
    '    (name: nil; funcget: nil; funcset: nil)',
    '    );',
    '  arrprops: packed array[0..2] of lual_Reg_prop = (',
    "    (name: 'Matrix'; funcget: @mget; funcset: @mset),",
    "    (name: 'Flips'; funcget: @fget; funcset: @fset),",
    '    (name: nil; funcget: nil; funcset: nil)',
    '    );',
    '  methods: packed array [0..1] of luaL_Reg = (',
    "    (name: 'DeScramble'; func: @puzzle_descramble),",
    '    (name: nil; func: nil)',
    '    );',
    '',
    'procedure luaImagePuzzleAddMetaTable(const L: Plua_State; const Obj: Pointer;',
    '  const MetaTable, UserData: Integer);',
    'begin',
    '  luaClassAddFunction(L, MetaTable, UserData, methods);',
    '  luaClassAddProperty(L, MetaTable, UserData, props);',
    '  luaClassAddArrayProperty(L, MetaTable, UserData, arrprops);',
    "  luaClassAddIntegerProperty(L, MetaTable, 'Multiply', @TUserData(Obj).Multiply);",
    'end;',
    '',
    'end.',
  ].join('\n');

  it('extracts luaL_Reg method names in registration order', (): void => {
    expect(extractTXQueryMethods(imagePuzzleFixture, 'fixture.pas')).toEqual(['DeScramble']);
    expect(extractDuktapeMethods(imagePuzzleFixture, 'fixture.pas')).toEqual(['DeScramble']);
  });

  it('extracts constructors, read-only props, array props and typed props', (): void => {
    const surface = extractImagePuzzleSurface(imagePuzzleFixture, 'fixture.pas');
    expect(surface.constructors).toEqual(['New', 'Create']);
    expect(surface.methods).toEqual(['DeScramble']);
    expect(surface.properties).toEqual([
      { name: 'HorBlock', access: 'read-only' },
      { name: 'VerBlock', access: 'read-only' },
      { name: 'Multiply', access: 'read-write' },
    ]);
    expect(surface.arrayProperties).toEqual([
      { name: 'Matrix', access: 'read-write' },
      { name: 'Flips', access: 'read-write' },
    ]);
  });

  it('fails loudly when the declared bound does not match the entry count', (): void => {
    const broken = imagePuzzleFixture.replace(
      'methods: packed array [0..1] of luaL_Reg = (',
      'methods: packed array [0..2] of luaL_Reg = (',
    );
    expect((): void => {
      extractLuaRegNames(broken, 'fixture.pas', 'methods');
    }).toThrow(/declares \[0\.\.2\] but carries 1 named entries/);
  });

  it('fails loudly on an unrecognized table entry', (): void => {
    const broken = imagePuzzleFixture.replace(
      "    (name: 'DeScramble'; func: @puzzle_descramble),",
      '    (name: DeScramble; func: @puzzle_descramble),',
    );
    expect((): void => {
      extractLuaRegNames(broken, 'fixture.pas', 'methods');
    }).toThrow(/unrecognized entry in table methods/);
  });

  const storageFixture = [
    'unit FixtureStorage;',
    'interface',
    '',
    'procedure luaStringsStorageAddMetaTable(const L: Plua_State; const Obj: Pointer;',
    '  const MetaTable, UserData: Integer);',
    '',
    'implementation',
    'const',
    '  methods: packed array [0..3] of luaL_Reg = (',
    "    (name: 'Remove'; func: @strings_remove),",
    "    (name: 'Free'; func: @strings_destroy),",
    "    (name: 'Destroy'; func: @strings_destroy),",
    '    (name: nil; func: nil)',
    '    );',
    '',
    'procedure luaStringsStorageAddMetaTable(const L: Plua_State; const Obj: Pointer;',
    '  const MetaTable, UserData: Integer);',
    'begin',
    '  luaClassAddFunction(L, MetaTable, UserData, methods);',
    '  luaClassAddDefaultArrayProperty(L, MetaTable, UserData, @strings_getvalue, @strings_setvalue);',
    "  luaClassAddProperty(L, MetaTable, UserData, 'Text', @strings_gettext, @strings_settext);",
    "  luaClassAddIntegerProperty(L, MetaTable, 'Tag', @TUserData(Obj).Tag);",
    "  luaClassAddBooleanProperty(L, MetaTable, 'Enable', @TUserData(Obj).Enable);",
    "  luaClassAddStringProperty(L, MetaTable, 'Status', @TUserData(Obj).Status);",
    'end;',
    '',
    'end.',
  ].join('\n');

  it('extracts the Storage surface (forward declaration disambiguated)', (): void => {
    const surface = extractStorageSurface(storageFixture, 'fixture.pas');
    expect(surface.methods).toEqual(['Remove', 'Free', 'Destroy']);
    expect(surface.properties).toEqual([
      { name: 'Text', access: 'read-write' },
      { name: 'Tag', access: 'read-write' },
      { name: 'Enable', access: 'read-write' },
      { name: 'Status', access: 'read-write' },
    ]);
    expect(surface.defaultArrayProperty).toBe('read-write');
  });

  it('fails loudly on an unrecognized AddMetaTable statement', (): void => {
    const broken = storageFixture.replace(
      "  luaClassAddIntegerProperty(L, MetaTable, 'Tag', @TUserData(Obj).Tag);",
      "  luaClassAddMysteryProperty(L, MetaTable, 'Tag');",
    );
    expect((): void => {
      extractStorageSurface(broken, 'fixture.pas');
    }).toThrow(/unrecognized statement inside luaStringsStorageAddMetaTable.*luaClassAddMysteryProperty/s);
  });

  it('extracts Crypto as cryptomethods ++ synacodemethods', (): void => {
    const cryptoFixture = [
      'unit FixtureCrypto;',
      'implementation',
      'const',
      '  cryptomethods: packed array [0..3] of luaL_Reg = (',
      "    (name: 'RC4'; func: @crypto_rc4),",
      "    (name: 'SHA256'; func: @crypto_sha256),",
      "    (name: 'AESCTR'; func: @crypto_aesctr),",
      '    (name: nil; func: nil)',
      '    );',
      '',
      '  synacodemethods: packed array [0..2] of luaL_Reg = (',
      "    (name: 'CRC32'; func: @lua_crc32),",
      "    (name: 'MD4'; func: @lua_md4),",
      '    (name: nil; func: nil)',
      '    );',
      '',
      'function luaopen_crypto(L: Plua_State): Integer; cdecl;',
      'begin',
      '  luaNewLibTable(L, [cryptomethods, synacodemethods]);',
      '  Result := 1;',
      'end;',
      '',
      'end.',
    ].join('\n');
    expect(extractCryptoMethodNames(cryptoFixture, 'fixture.pas')).toEqual([
      'RC4', 'SHA256', 'AESCTR', 'CRC32', 'MD4',
    ]);
  });

  it('fails loudly when the crypto lib no longer concatenates the two tables', (): void => {
    const cryptoFixture = [
      'unit FixtureCrypto;',
      'implementation',
      'const',
      '  cryptomethods: packed array [0..1] of luaL_Reg = (',
      "    (name: 'RC4'; func: @crypto_rc4),",
      '    (name: nil; func: nil)',
      '    );',
      '',
      '  synacodemethods: packed array [0..1] of luaL_Reg = (',
      "    (name: 'CRC32'; func: @lua_crc32),",
      '    (name: nil; func: nil)',
      '    );',
      '',
      'function luaopen_crypto(L: Plua_State): Integer; cdecl;',
      'begin',
      '  luaNewLibTable(L, [onlycryptomethods]);',
      '  Result := 1;',
      'end;',
      '',
      'end.',
    ].join('\n');
    expect((): void => {
      extractCryptoMethodNames(cryptoFixture, 'fixture.pas');
    }).toThrow(/\[cryptomethods, synacodemethods\]/);
  });
});

describe('extractor on the real FMD2 sources (integration)', (): void => {
  /**
   * DESIGN.md §5.2 table, transcribed with MODULE (bound for every event
   * by the handler, LuaWebsiteModuleHandler.pas:47-49) prepended.
   */
  const design52: readonly {
    readonly event: string;
    readonly returns: string;
    readonly globals: readonly string[];
    readonly readBack: readonly string[];
    readonly constants: string;
  }[] = [
    { event: 'GetDirectoryPageNumber', returns: 'code', globals: ['MODULE', 'HTTP', 'UPDATELIST', 'PAGENUMBER', 'WORKPTR'], readBack: ['PAGENUMBER'], constants: 'net-status' },
    { event: 'GetNameAndLink', returns: 'code', globals: ['MODULE', 'HTTP', 'NAMES', 'LINKS', 'UPDATELIST', 'URL'], readBack: [], constants: 'net-status' },
    { event: 'GetInfo', returns: 'code', globals: ['MODULE', 'MANGAINFO', 'HTTP', 'URL'], readBack: [], constants: 'net-status' },
    { event: 'BeforeUpdateList', returns: 'boolean', globals: ['MODULE', 'UPDATELIST'], readBack: [], constants: 'none' },
    { event: 'AfterUpdateList', returns: 'boolean', globals: ['MODULE', 'UPDATELIST'], readBack: [], constants: 'none' },
    { event: 'TaskStart', returns: 'boolean', globals: ['MODULE', 'TASK'], readBack: [], constants: 'none' },
    { event: 'GetPageNumber', returns: 'boolean', globals: ['MODULE', 'TASK', 'HTTP', 'URL'], readBack: [], constants: 'none' },
    { event: 'GetImageURL', returns: 'boolean', globals: ['MODULE', 'TASK', 'HTTP', 'WORKID', 'URL'], readBack: [], constants: 'none' },
    { event: 'BeforeDownloadImage', returns: 'boolean', globals: ['MODULE', 'TASK', 'HTTP', 'WORKID', 'URL'], readBack: [], constants: 'none' },
    { event: 'DownloadImage', returns: 'boolean', globals: ['MODULE', 'TASK', 'HTTP', 'WORKID', 'URL'], readBack: [], constants: 'none' },
    { event: 'SaveImage', returns: 'string', globals: ['MODULE', 'HTTP', 'PATH', 'FILENAME'], readBack: [], constants: 'none' },
    { event: 'AfterImageSaved', returns: 'boolean', globals: ['MODULE', 'FILENAME'], readBack: [], constants: 'none' },
    { event: 'Login', returns: 'boolean', globals: ['MODULE', 'HTTP'], readBack: [], constants: 'account-status' },
    { event: 'AccountState', returns: 'boolean', globals: ['MODULE'], readBack: [], constants: 'account-status' },
    { event: 'CheckSite', returns: 'boolean', globals: ['MODULE'], readBack: [], constants: 'account-status' },
  ];

  it('extracts exactly the 15 DESIGN.md §5.2 rows from the real dispatchers', (): void => {
    const facts = extractContractFacts(realLuaDir);
    expect(facts.events).toHaveLength(15);
    expect(facts.moduleBoundForEveryEvent).toBe(true);
    expect(facts.nonDispatcherDoFunctions).toEqual(['DoInit']);
    // The DESIGN.md table is name-keyed (its display order differs from
    // the Pascal declaration order, which the extractor preserves).
    const byName = new Map(facts.events.map((e): [string, typeof e] => [e.event, e]));
    expect(byName.size).toBe(design52.length);
    for (const expected of design52) {
      const actual = byName.get(expected.event);
      expect(actual, expected.event).toBeDefined();
      expect(actual?.returns, expected.event).toBe(expected.returns);
      expect(actual?.constants, expected.event).toBe(expected.constants);
      expect([...actual?.globals ?? []], expected.event).toEqual(expected.globals);
      expect([...actual?.readBack ?? []], expected.event).toEqual(expected.readBack);
    }
  });

  it('matches every shipped contract.json event row', (): void => {
    const facts = extractContractFacts(realLuaDir);
    expect(contract.events).toHaveLength(facts.events.length);
    for (const ev of facts.events) {
      const row = contract.events.find((r): boolean => r.event === ev.event);
      expect(row, `contract.json row for ${ev.event}`).toBeDefined();
      expect(row?.returns).toBe(ev.returns);
      expect([...row?.globals ?? []]).toEqual(ev.globals);
      expect([...row?.readBack ?? []]).toEqual(ev.readBack);
      expect(row?.constants).toBe(ev.constants);
    }
  });

  it('matches the extractable facade surfaces in contract.json', (): void => {
    const facts = extractContractFacts(realLuaDir);
    const byName = new Map(contract.facades.map((f): [string, FacadeTable] => [f.name, f]));

    const txq = byName.get('TXQuery');
    expect(txq?.methods.map((m): string => m.name)).toEqual(facts.facades.TXQuery.methods);
    expect(facts.facades.TXQuery.methods).toEqual([
      'ParseHTML', 'XPath', 'XPathString', 'XPathStringAll',
      'XPathHREFAll', 'XPathHREFTitleAll', 'XPathCount',
    ]);

    const storage = byName.get('Storage');
    expect(storage?.methods.map((m): string => m.name)).toEqual(facts.facades.Storage.methods);
    const storageExtractedProps = facts.facades.Storage.properties.map(
      (p): { readonly name: string; readonly access: string } => ({ name: p.name, access: p.access }),
    );
    expect(storage?.properties.map((p): { readonly name: string; readonly access: string } => ({
      name: p.name, access: p.access,
    }))).toEqual(storageExtractedProps);
    expect(storage?.defaultArrayProperty?.access).toBe(facts.facades.Storage.defaultArrayProperty);

    const puzzle = byName.get('ImagePuzzle');
    expect(puzzle?.constructors?.map((c): string => c.name)).toEqual(facts.facades.ImagePuzzle.constructors);
    expect(puzzle?.methods.map((m): string => m.name)).toEqual(facts.facades.ImagePuzzle.methods);
    expect(facts.facades.ImagePuzzle.methods).toEqual(['DeScramble']);

    const duktape = byName.get('Duktape');
    expect(duktape?.methods.map((m): string => m.name)).toEqual(facts.facades.Duktape.methods);
    expect(facts.facades.Duktape.methods).toEqual(['ExecJS']);

    const crypto = byName.get('Crypto');
    expect(crypto?.methods.map((m): string => m.name)).toEqual(facts.facades.Crypto.methods);
    expect(facts.facades.Crypto.methods).toHaveLength(59);
    expect(facts.facades.Crypto.methods[0]).toBe('EncryptString');
    expect(facts.facades.Crypto.methods[facts.facades.Crypto.methods.length - 1]).toBe('SHA1LongHash');
  });
});
