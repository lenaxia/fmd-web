import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConstantBinding, EventReturnKind, PropertyAccess } from '../types.js';

/**
 * Conservative extractor for the DESIGN.md §5 compatibility contract
 * (task: make the §5.2-class of transcription error mechanically
 * impossible).
 *
 * Two duties, both fail-loud:
 *
 * 1. Parse the 15 `Do*` event dispatcher bodies in
 *    `LuaWebsiteModules.pas` using ONLY the binding vocabulary:
 *    `L.LoadObject`, `LuaPushNetStatus`, `LuaPushAccountStatus`,
 *    `luaPushIntegerGlobal`, `luaPushStringGlobal`, `lua_getglobal`
 *    read-back, and the `lua_tointeger`/`lua_toboolean`/`luaToString`
 *    return reads. ANY unrecognized statement inside a dispatcher body
 *    throws with file:line — the extractor never guesses.
 *
 * 2. Extract facade registration tables (`luaL_Reg` / `lual_Reg_prop`
 *    packed arrays) from LuaXQuery.pas, LuaImagePuzzle.pas,
 *    LuaDuktape.pas, LuaStringsStorage.pas and LuaCrypto.pas, including
 *    the declared array upper-bound sanity check.
 *
 * `MODULE` is verified separately from LuaWebsiteModuleHandler.pas
 * (LoadModule pushes it before every dispatched call).
 */

/** Raised on ANY pattern the conservative vocabulary does not recognize. */
export class ContractExtractionError extends Error {
  readonly file: string;
  readonly line: number;

  constructor(message: string, file: string, line: number) {
    super(`${file}:${line}: ${message}`);
    this.name = 'ContractExtractionError';
    this.file = file;
    this.line = line;
  }
}

/** One §5.2 event row, extracted from a `Do*` dispatcher body. */
export interface ExtractedEvent {
  /** Dispatcher name without the `Do` prefix, e.g. `GetDirectoryPageNumber`. */
  readonly event: string;
  /** Return-kind read after `L.CallFunction`. */
  readonly returns: EventReturnKind;
  /** Which status-constant table the dispatcher binds. */
  readonly constants: ConstantBinding;
  /**
   * Exact bound globals in binding order; `MODULE` (bound by the module
   * handler before every dispatcher) is always first.
   */
  readonly globals: readonly string[];
  /** Globals read back after the call (`lua_getglobal`); `PAGENUMBER` only. */
  readonly readBack: readonly string[];
}

/** Property name + access mode extracted from a Pascal registration table. */
export interface ExtractedProperty {
  readonly name: string;
  readonly access: PropertyAccess;
}

/** Surface of one facade, extracted from its registration tables. */
export interface ExtractedFacadeSurface {
  readonly methods: readonly string[];
  readonly properties: readonly ExtractedProperty[];
  readonly arrayProperties?: readonly ExtractedProperty[];
  readonly defaultArrayProperty?: PropertyAccess;
  readonly constructors?: readonly string[];
}

/** Everything the extractor can prove from the FMD2 Pascal sources. */
export interface ExtractedFacts {
  /** The event dispatchers, in declaration order. */
  readonly events: readonly ExtractedEvent[];
  /** True when the handler provably pushes `MODULE` before every call. */
  readonly moduleBoundForEveryEvent: boolean;
  /** `Do*` functions seen that are NOT event dispatchers (transparency). */
  readonly nonDispatcherDoFunctions: readonly string[];
  /** Extractable facade surfaces, keyed by contract facade name. */
  readonly facades: Readonly<
    Record<'TXQuery' | 'Storage' | 'ImagePuzzle' | 'Duktape' | 'Crypto', ExtractedFacadeSurface>
  >;
}

interface Line {
  readonly no: number;
  readonly text: string;
  /** Untrimmed original, for column-0 `end;` body-closer detection. */
  readonly raw: string;
}

function toLines(source: string): readonly Line[] {
  return source
    .split(/\r?\n/)
    .map((text, i): Line => ({ no: i + 1, text: text.trim(), raw: text }));
}

/**
 * The line that closes a function/procedure body: `end;` starting at
 * column 0 (FMD2 style — nested closes are always indented).
 */
function findBodyCloser(lines: readonly Line[], from: number, fileName: string, opener: number): Line {
  const closing = lines.find(
    (l): boolean => l.no >= from && /^end;\s*(\/\/.*)?$/.test(l.raw),
  );
  if (closing === undefined) {
    throw new ContractExtractionError('body has no column-0 closing "end;"', fileName, opener);
  }
  return closing;
}

/** The first line matching `pred` at/after `from` (1-based, inclusive). */
function findLine(lines: readonly Line[], from: number, pred: (l: Line) => boolean): Line | undefined {
  return lines.find((l): boolean => l.no >= from && pred(l));
}

interface DoFunctionBody {
  readonly name: string;
  readonly startLine: number;
  readonly body: readonly Line[];
  /** True when the body enters the module-handler context (`AModule.LuaModule`). */
  readonly isEventDispatcher: boolean;
}

/**
 * Find the IMPLEMENTATION body of a procedure that may also have a
 * forward declaration in the interface section: the match is the one
 * whose signature is followed by `begin` before any new section keyword.
 */
function findProcedureImpl(lines: readonly Line[], name: string, fileName: string): Line {
  const declPattern = new RegExp(`^(procedure|function) ${name}\\(`);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as Line;
    if (!declPattern.test(line.text)) {
      continue;
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
      const next = lines[j] as Line;
      if (next.text === 'begin') {
        return line;
      }
      // Section keywords only count at column 0 — indented `const` lines
      // are signature continuations.
      if (/^(procedure|function|const|type|var|initialization|implementation|end[.;])/.test(next.raw)) {
        break; // a declaration, not the implementation — try next match
      }
    }
  }
  throw new ContractExtractionError(`implementation body of ${name} not found`, fileName, 1);
}

/**
 * Locate every `function Do<Name>(...)` body: from the `begin` that
 * opens it to the column-0 `end;` that closes it.
 */
function findDoFunctionBodies(source: string, fileName: string): readonly DoFunctionBody[] {
  const lines = toLines(source);
  const bodies: DoFunctionBody[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as Line;
    const m = /^function (Do[A-Za-z]+)\(/.exec(line.text);
    if (m === null) {
      continue;
    }
    const name = m[1] ?? '';
    const begin = findLine(lines, line.no + 1, (l): boolean => l.text === 'begin');
    if (begin === undefined) {
      throw new ContractExtractionError(
        `function ${name} has no opening "begin"`, fileName, line.no,
      );
    }
    const closing = findBodyCloser(lines, begin.no + 1, fileName, line.no);
    const body: Line[] = [];
    for (let j = begin.no; j < closing.no; j += 1) {
      body.push(lines[j] as Line);
    }
    const bodyText = body.map((l): string => l.text).join('\n');
    bodies.push({
      name,
      startLine: line.no,
      body,
      isEventDispatcher: bodyText.includes('AModule.LuaModule'),
    });
  }
  return bodies;
}

const GLOBAL_NAME_PATTERN = /^[A-Z][A-Za-z]*$/;

interface DispatcherState {
  kind: EventReturnKind | undefined;
  netStatus: boolean;
  accountStatus: boolean;
  globals: string[];
  readBack: string[];
  calledEvent: string | undefined;
  pendingReadBack: boolean;
}

/**
 * Parse ONE `Do*` dispatcher body with the strict binding vocabulary.
 * Anything else inside the body throws `ContractExtractionError` with
 * the offending file:line.
 */
function parseDispatcherBody(fn: DoFunctionBody, fileName: string): ExtractedEvent {
  const event = fn.name.startsWith('Do') ? fn.name.slice(2) : fn.name;
  const state: DispatcherState = {
    kind: undefined,
    netStatus: false,
    accountStatus: false,
    globals: [],
    readBack: [],
    calledEvent: undefined,
    pendingReadBack: false,
  };

  for (const { no, text } of fn.body) {
    if (text === '' || text === 'begin' || text === 'try' || text === 'except' || text === 'end;') {
      continue;
    }
    // default-result initialization before the guarded block
    if (/^Result := (False|INFORMATION_NOT_FOUND|'');$/.test(text)) {
      continue;
    }
    if (text === 'with TLuaWebsiteModule(AModule.LuaModule) do') {
      continue;
    }
    if (text === 'L := GetLuaWebsiteModuleHandler(AModule);') {
      continue;
    }
    if (text === 'on E: Exception do') {
      continue;
    }
    if (/^SendLogException\(/.test(text)) {
      continue;
    }
    if (text === 'LuaPushNetStatus(L.Handle);') {
      if (state.netStatus) {
        throw new ContractExtractionError(`LuaPushNetStatus bound twice in Do${event}`, fileName, no);
      }
      state.netStatus = true;
      continue;
    }
    if (text === 'LuaPushAccountStatus(L.Handle);') {
      if (state.accountStatus) {
        throw new ContractExtractionError(`LuaPushAccountStatus bound twice in Do${event}`, fileName, no);
      }
      state.accountStatus = true;
      continue;
    }
    const loadObject = /^L\.LoadObject\('([^']+)', /.exec(text);
    if (loadObject !== null) {
      bindGlobal(state, loadObject[1] ?? '', fileName, no, event);
      continue;
    }
    const pushInt = /^luaPushIntegerGlobal\(L\.Handle, '([^']+)', /.exec(text);
    if (pushInt !== null) {
      bindGlobal(state, pushInt[1] ?? '', fileName, no, event);
      continue;
    }
    const pushStr = /^luaPushStringGlobal\(L\.Handle, '([^']+)', /.exec(text);
    if (pushStr !== null) {
      bindGlobal(state, pushStr[1] ?? '', fileName, no, event);
      continue;
    }
    const getGlobal = /^lua_getglobal\(L\.Handle, '([^']+)'\);$/.exec(text);
    if (getGlobal !== null) {
      const name = getGlobal[1] ?? '';
      if (!GLOBAL_NAME_PATTERN.test(name)) {
        throw new ContractExtractionError(
          `invalid read-back global name "${name}" in Do${event}`, fileName, no,
        );
      }
      state.readBack.push(name);
      state.pendingReadBack = true;
      continue;
    }
    if (text === 'if not lua_isnoneornil(L.Handle, -1) then') {
      if (!state.pendingReadBack) {
        throw new ContractExtractionError(
          `lua_isnoneornil guard without a preceding lua_getglobal read-back in Do${event}`,
          fileName, no,
        );
      }
      continue;
    }
    const readInt = /^([A-Za-z]+) := lua_tointeger\(L\.Handle, -1\);$/.exec(text);
    if (readInt !== null) {
      const target = readInt[1] ?? '';
      if (target === 'Result') {
        if (state.kind !== undefined) {
          throw new ContractExtractionError(`Do${event} reads its return value twice`, fileName, no);
        }
        state.kind = 'code';
        state.pendingReadBack = false;
        continue;
      }
      if (!state.pendingReadBack) {
        throw new ContractExtractionError(
          `"${target} := lua_tointeger(...)" outside a lua_getglobal read-back in Do${event}`,
          fileName, no,
        );
      }
      state.pendingReadBack = false;
      continue;
    }
    if (text === 'Result := lua_toboolean(L.Handle, -1);') {
      if (state.kind !== undefined) {
        throw new ContractExtractionError(`Do${event} reads its return value twice`, fileName, no);
      }
      state.kind = 'boolean';
      continue;
    }
    if (text === 'Result := luaToString(L.Handle, -1);') {
      if (state.kind !== undefined) {
        throw new ContractExtractionError(`Do${event} reads its return value twice`, fileName, no);
      }
      state.kind = 'string';
      continue;
    }
    const call = /^L\.CallFunction\(On([A-Za-z]+)\);$/.exec(text);
    if (call !== null) {
      if (state.calledEvent !== undefined) {
        throw new ContractExtractionError(`Do${event} calls more than one event function`, fileName, no);
      }
      state.calledEvent = call[1] ?? '';
      continue;
    }
    throw new ContractExtractionError(
      `unrecognized statement inside Do${event} body: "${text}"`, fileName, no,
    );
  }

  if (state.calledEvent === undefined || state.calledEvent !== event) {
    throw new ContractExtractionError(
      `Do${event} must call exactly L.CallFunction(On${event}); saw ` +
      `${state.calledEvent === undefined ? 'no CallFunction' : `On${state.calledEvent}`}`,
      fileName, fn.startLine,
    );
  }
  if (state.kind === undefined) {
    throw new ContractExtractionError(
      `Do${event} never reads a return value (lua_tointeger/lua_toboolean/luaToString)`,
      fileName, fn.startLine,
    );
  }
  if (state.netStatus && state.accountStatus) {
    throw new ContractExtractionError(
      `Do${event} binds both net-status and account-status constants`, fileName, fn.startLine,
    );
  }
  const constants: ConstantBinding = state.netStatus
    ? 'net-status'
    : state.accountStatus
      ? 'account-status'
      : 'none';

  return {
    event,
    returns: state.kind,
    constants,
    globals: ['MODULE', ...state.globals],
    readBack: state.readBack,
  };
}

function bindGlobal(
  state: DispatcherState,
  name: string,
  fileName: string,
  line: number,
  event: string,
): void {
  if (!GLOBAL_NAME_PATTERN.test(name)) {
    throw new ContractExtractionError(`invalid global name "${name}" in Do${event}`, fileName, line);
  }
  if (state.globals.includes(name)) {
    throw new ContractExtractionError(`global ${name} bound twice in Do${event}`, fileName, line);
  }
  state.globals.push(name);
}

/**
 * Extract the §5.2 event table from LuaWebsiteModules.pas. Emits one row
 * per event dispatcher (in declaration order); `Do*` helpers that are
 * not dispatchers (e.g. DoInit) are reported separately so nothing is
 * silently swallowed.
 */
export function extractEvents(source: string, fileName: string): {
  readonly events: readonly ExtractedEvent[];
  readonly nonDispatcherDoFunctions: readonly string[];
} {
  const events: ExtractedEvent[] = [];
  const nonDispatcherDoFunctions: string[] = [];
  for (const fn of findDoFunctionBodies(source, fileName)) {
    if (!fn.isEventDispatcher) {
      nonDispatcherDoFunctions.push(fn.name);
      continue;
    }
    events.push(parseDispatcherBody(fn, fileName));
  }
  return { events, nonDispatcherDoFunctions };
}

/**
 * Prove the handler-side rule that `MODULE` is bound before every
 * dispatched call: `LoadModule` must run `LuaDoMe` + `LuaPushMe` (the
 * latter pushes the `MODULE` global, LuaWebsiteModules.pas:822).
 */
export function extractModuleBinding(handlerSource: string, fileName: string): boolean {
  const lines = toLines(handlerSource);
  const loadModule = findLine(
    lines, 1,
    (l): boolean => /^function TLuaWebsiteModuleHandler\.LoadModule\(/.test(l.text),
  );
  if (loadModule === undefined) {
    throw new ContractExtractionError('TLuaWebsiteModuleHandler.LoadModule not found', fileName, 1);
  }
  const closing = findBodyCloser(lines, loadModule.no, fileName, loadModule.no);
  const body = lines
    .filter((l): boolean => l.no > loadModule.no && l.no < closing.no)
    .map((l): string => l.text);
  const doMe = body.findIndex((t): boolean => t === 'M.LuaDoMe(FHandle);');
  const pushMe = body.findIndex((t): boolean => t === 'M.LuaPushMe(FHandle);');
  if (doMe === -1 || pushMe === -1) {
    throw new ContractExtractionError(
      'LoadModule no longer runs M.LuaDoMe(FHandle); M.LuaPushMe(FHandle); — MODULE binding unverified',
      fileName, loadModule.no,
    );
  }
  return true;
}

interface LuaRegEntry {
  readonly name: string;
  readonly access?: PropertyAccess;
}

/**
 * Extract the exact entry list of one `nameVar: packed array [0..N] of
 * luaL_Reg` (or `lual_Reg_prop`) registration table (Pascal's lowercase
 * `lual_Reg` spelling is accepted case-insensitively). Enforces the
 * declared upper bound: N === named entries + 1 (the nil sentinel).
 */
export function extractLuaRegEntries(
  source: string,
  fileName: string,
  nameVar: string,
  entryKind: 'luaL_Reg' | 'lual_Reg_prop' = 'luaL_Reg',
): readonly LuaRegEntry[] {
  const lines = toLines(source);
  const decl = findLine(
    lines, 1,
    (l): boolean => new RegExp(
      `^${nameVar}\\s*:\\s*packed array\\s*\\[\\s*0\\s*\\.\\.\\s*(\\d+)\\s*\\]\\s*of\\s+${entryKind}\\s*=\\s*\\(`,
      'i',
    ).test(l.text),
  );
  if (decl === undefined) {
    throw new ContractExtractionError(
      `registration table "${nameVar}: packed array [...] of ${entryKind}" not found`, fileName, 1,
    );
  }
  const boundMatch = new RegExp(
    `^${nameVar}\\s*:\\s*packed array\\s*\\[\\s*0\\s*\\.\\.\\s*(\\d+)\\s*\\]`, 'i',
  ).exec(decl.text);
  const upperBound = Number(boundMatch?.[1]);
  if (!Number.isInteger(upperBound)) {
    throw new ContractExtractionError(`cannot read upper bound of table ${nameVar}`, fileName, decl.no);
  }

  const entries: LuaRegEntry[] = [];
  const entryPattern =
    entryKind === 'luaL_Reg'
      ? /^\(\s*name:\s*'([^']+)';\s*func:\s*@[A-Za-z0-9_.]+\s*\),?$/
      : /^\(\s*name:\s*'([^']+)';\s*funcget:\s*@[A-Za-z0-9_.]+;\s*funcset:\s*(nil|@[A-Za-z0-9_.]+)\s*\),?$/;
  const sentinelPattern =
    entryKind === 'luaL_Reg'
      ? /^\(\s*name:\s*nil;\s*func:\s*nil\s*\)/
      : /^\(\s*name:\s*nil;\s*funcget:\s*nil;\s*funcset:\s*nil\s*\)/;

  for (let i = decl.no + 1; i <= lines.length; i += 1) {
    const line = lines[i - 1] as Line;
    if (sentinelPattern.test(line.text)) {
      if (entries.length !== upperBound) {
        throw new ContractExtractionError(
          `table ${nameVar} declares [0..${upperBound}] but carries ${entries.length} named entries`,
          fileName, line.no,
        );
      }
      return entries;
    }
    const entry = entryPattern.exec(line.text);
    if (entry !== null) {
      entries.push(
        entryKind === 'luaL_Reg'
          ? { name: entry[1] ?? '' }
          : {
              name: entry[1] ?? '',
              access: entry[2] === 'nil' ? 'read-only' : 'read-write',
            },
      );
      continue;
    }
    if (line.text === '') {
      continue;
    }
    throw new ContractExtractionError(
      `unrecognized entry in table ${nameVar}: "${line.text}"`, fileName, line.no,
    );
  }
  throw new ContractExtractionError(
    `table ${nameVar} has no nil sentinel — extraction aborted`, fileName, decl.no,
  );
}

/**
 * Extract the exact name list of one `nameVar: packed array [0..N] of
 * luaL_Reg` registration table.
 */
export function extractLuaRegNames(
  source: string,
  fileName: string,
  nameVar: string,
  entryKind: 'luaL_Reg' | 'lual_Reg_prop' = 'luaL_Reg',
): readonly string[] {
  return extractLuaRegEntries(source, fileName, nameVar, entryKind)
    .map((e): string => e.name);
}

function extractPropTable(
  source: string,
  fileName: string,
  nameVar: string,
): readonly ExtractedProperty[] {
  return extractLuaRegEntries(source, fileName, nameVar, 'lual_Reg_prop').map(
    (e): ExtractedProperty => ({ name: e.name, access: e.access ?? 'read-write' }),
  );
}

/**
 * Statements allowed inside an `AddMetaTable` body (facade registration
 * plumbing). Anything else fails loudly.
 */
function parseAddMetaTableBody(
  source: string,
  fileName: string,
  procedureName: string,
): {
  readonly plainProps: readonly ExtractedProperty[];
  readonly arrayProps: readonly ExtractedProperty[];
  readonly defaultArray: PropertyAccess | undefined;
  readonly usesMethodsTable: boolean;
  readonly usesPropsTable: boolean;
  readonly usesArrayPropsTable: boolean;
} {
  const lines = toLines(source);
  const proc = findProcedureImpl(lines, procedureName, fileName);
  const begin = findLine(lines, proc.no + 1, (l): boolean => l.text === 'begin');
  if (begin === undefined) {
    throw new ContractExtractionError(`${procedureName} has no opening "begin"`, fileName, proc.no);
  }
  const closing = findBodyCloser(lines, begin.no + 1, fileName, proc.no);
  const body = lines.filter((l): boolean => l.no > begin.no && l.no < closing.no);

  const plainProps: ExtractedProperty[] = [];
  const arrayProps: ExtractedProperty[] = [];
  let defaultArray: PropertyAccess | undefined;
  let usesMethodsTable = false;
  let usesPropsTable = false;
  let usesArrayPropsTable = false;

  for (const { no, text } of body) {
    if (text === '' || text === 'begin' || /^var\b/.test(text)) {
      continue;
    }
    if (/^luaClassAddFunction\(L, MetaTable, UserData, methods\);?$/.test(text)) {
      usesMethodsTable = true;
      continue;
    }
    if (/^luaClassAddProperty\(L, MetaTable, UserData, props\);?$/.test(text)) {
      usesPropsTable = true;
      continue;
    }
    if (/^luaClassAddArrayProperty\(L, MetaTable, UserData, arrprops\);?$/.test(text)) {
      usesArrayPropsTable = true;
      continue;
    }
    const defaultArrayCall =
      /^luaClassAddDefaultArrayProperty\(L, MetaTable, UserData, @([A-Za-z0-9_]+), @([A-Za-z0-9_]+)\);?$/.exec(text);
    if (defaultArrayCall !== null) {
      if (defaultArray !== undefined) {
        throw new ContractExtractionError(`${procedureName} registers two default array properties`, fileName, no);
      }
      defaultArray = defaultArrayCall[1] === defaultArrayCall[2] ? 'read-only' : 'read-write';
      continue;
    }
    const plainCall =
      /^luaClassAddProperty\(L, MetaTable, UserData, '([A-Za-z0-9_]+)', @([A-Za-z0-9_]+), (@[A-Za-z0-9_]+|nil)\);?$/.exec(text);
    if (plainCall !== null) {
      plainProps.push({
        name: plainCall[1] ?? '',
        access: plainCall[3] === 'nil' ? 'read-only' : 'read-write',
      });
      continue;
    }
    const typedCall =
      /^luaClassAdd(Integer|Boolean|String)Property\(L, MetaTable, '([A-Za-z0-9_]+)', @/.exec(text);
    if (typedCall !== null) {
      plainProps.push({ name: typedCall[2] ?? '', access: 'read-write' });
      continue;
    }
    const arrayCall =
      /^luaClassAddArrayProperty\(L, MetaTable, '([A-Za-z0-9_]+)', @([A-Za-z0-9_]+), (@[A-Za-z0-9_]+|nil)\);?$/.exec(text);
    if (arrayCall !== null) {
      arrayProps.push({
        name: arrayCall[1] ?? '',
        access: arrayCall[3] === 'nil' ? 'read-only' : 'read-write',
      });
      continue;
    }
    if (/^luaClassAddObject\(L, MetaTable, /.test(text)) {
      // object-valued property registered with a nested facade metatable
      // (e.g. Headers/Cookies/Document); the value side is contract data.
      const obj = /^luaClassAddObject\(L, MetaTable, [A-Za-z0-9_().]+, '([A-Za-z0-9_]+)', @/.exec(text);
      if (obj !== null) {
        plainProps.push({ name: obj[1] ?? '', access: 'read-write' });
        continue;
      }
    }
    throw new ContractExtractionError(
      `unrecognized statement inside ${procedureName}: "${text}"`, fileName, no,
    );
  }

  return {
    plainProps,
    arrayProps,
    defaultArray,
    usesMethodsTable,
    usesPropsTable,
    usesArrayPropsTable,
  };
}

/**
 * Storage facade (MODULE.Storage): LuaStringsStorage.pas:143-159 —
 * methods table + default array property + Text/Tag/Enable/Status.
 */
export function extractStorageSurface(source: string, fileName: string): ExtractedFacadeSurface {
  const methods = extractLuaRegNames(source, fileName, 'methods');
  const body = parseAddMetaTableBody(source, fileName, 'luaStringsStorageAddMetaTable');
  if (!body.usesMethodsTable) {
    throw new ContractExtractionError(
      'luaStringsStorageAddMetaTable does not register the methods table', fileName, 1,
    );
  }
  if (body.defaultArray === undefined) {
    throw new ContractExtractionError(
      'luaStringsStorageAddMetaTable lost its default array property (Storage[key])', fileName, 1,
    );
  }
  return {
    methods,
    properties: body.plainProps,
    defaultArrayProperty: body.defaultArray,
  };
}

/**
 * ImagePuzzle facade: LuaImagePuzzle.pas:73-91,99 — New/Create
 * constructors, HorBlock/VerBlock read-only, Matrix/Flips array
 * read-write, Multiply integer read-write, DeScramble method.
 */
export function extractImagePuzzleSurface(source: string, fileName: string): ExtractedFacadeSurface {
  const constructors = extractLuaRegNames(source, fileName, 'constructs');
  const methods = extractLuaRegNames(source, fileName, 'methods');
  const props = extractPropTable(source, fileName, 'props');
  const arrprops = extractPropTable(source, fileName, 'arrprops');
  const body = parseAddMetaTableBody(source, fileName, 'luaImagePuzzleAddMetaTable');
  if (!body.usesMethodsTable || !body.usesPropsTable || !body.usesArrayPropsTable) {
    throw new ContractExtractionError(
      'luaImagePuzzleAddMetaTable does not register all four tables', fileName, 1,
    );
  }
  return {
    methods,
    properties: [...props, ...body.plainProps],
    arrayProperties: [...arrprops, ...body.arrayProps],
    constructors,
  };
}

/** TXQuery facade methods: LuaXQuery.pas:192-201. */
export function extractTXQueryMethods(source: string, fileName: string): readonly string[] {
  return extractLuaRegNames(source, fileName, 'methods');
}

/** Duktape facade methods: LuaDuktape.pas:27-30. */
export function extractDuktapeMethods(source: string, fileName: string): readonly string[] {
  return extractLuaRegNames(source, fileName, 'methods');
}

/**
 * Crypto facade methods: LuaCrypto.pas:429-494 — the lib table is
 * [cryptomethods, synacodemethods] concatenated (LuaCrypto.pas:496-500).
 */
export function extractCryptoMethodNames(source: string, fileName: string): readonly string[] {
  const crypto = extractLuaRegNames(source, fileName, 'cryptomethods');
  const synacode = extractLuaRegNames(source, fileName, 'synacodemethods');
  const libLine = toLines(source)
    .find((l): boolean => l.text === 'luaNewLibTable(L, [cryptomethods, synacodemethods]);');
  if (libLine === undefined) {
    throw new ContractExtractionError(
      'luaopen_crypto no longer builds the lib from [cryptomethods, synacodemethods]',
      fileName, 1,
    );
  }
  return [...crypto, ...synacode];
}

const REQUIRED_SOURCES = [
  'LuaWebsiteModules.pas',
  'LuaWebsiteModuleHandler.pas',
  'LuaXQuery.pas',
  'LuaImagePuzzle.pas',
  'LuaDuktape.pas',
  'LuaStringsStorage.pas',
  'LuaCrypto.pas',
] as const;

/**
 * Run every extractor over the real FMD2 `baseunits/lua` directory.
 * Throws `ContractExtractionError` on any unrecognized pattern.
 */
export function extractContractFacts(luaDir: string): ExtractedFacts {
  const read = (unit: string): string =>
    readFileSync(join(luaDir, unit), 'utf8');

  const modulesSrc = read('LuaWebsiteModules.pas');
  const handlerSrc = read('LuaWebsiteModuleHandler.pas');
  const { events, nonDispatcherDoFunctions } = extractEvents(modulesSrc, 'LuaWebsiteModules.pas');

  return {
    events,
    nonDispatcherDoFunctions,
    moduleBoundForEveryEvent: extractModuleBinding(handlerSrc, 'LuaWebsiteModuleHandler.pas'),
    facades: {
      TXQuery: {
        methods: extractTXQueryMethods(read('LuaXQuery.pas'), 'LuaXQuery.pas'),
        properties: [],
      },
      Storage: extractStorageSurface(read('LuaStringsStorage.pas'), 'LuaStringsStorage.pas'),
      ImagePuzzle: extractImagePuzzleSurface(read('LuaImagePuzzle.pas'), 'LuaImagePuzzle.pas'),
      Duktape: {
        methods: extractDuktapeMethods(read('LuaDuktape.pas'), 'LuaDuktape.pas'),
        properties: [],
      },
      Crypto: {
        methods: extractCryptoMethodNames(read('LuaCrypto.pas'), 'LuaCrypto.pas'),
        properties: [],
      },
    },
  };
}

export { REQUIRED_SOURCES };
