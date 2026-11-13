import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { HttpAbortHandle } from '@fmd/contract';
import { toBool, toInteger, toStr } from './base-globals.js';
import type { FacadeBridge, FacadeSpec } from './facade.js';
import { PascalTStrings } from './tstrings.js';

/**
 * Offline facade stubs shared by the Init pass and the event dispatcher.
 * The full §5.4 (HTTP/undici) semantics is its own story; the HTTP stub
 * exposes the exact surface shape with inert behavior. The TStrings facade
 * is at FULL contract over `PascalTStrings` (§5.5, FPC TStringList
 * semantics — see tstrings.ts for the case-by-case documentation).
 */

/** Jailed file IO contract for TStrings LoadFromFile/SaveToFile (§8 jail). */
export interface TStringsFileIO {
  /** Read + return the file content; throw on missing/undecodable. */
  loadFromFile(path: string): string;
  /** Write the content; throw on failure. */
  saveToFile(path: string, content: string): void;
}

export interface TStringsHandle {
  readonly spec: FacadeSpec;
  readonly list: PascalTStrings;
}

/**
 * TStrings facade (§5.5, LuaStrings.pas:216-263) over PascalTStrings:
 * Add/AddText/Get/Set[i]/Count/Clear/Delete/IndexOf/IndexOfName/Reverse/
 * Sort/GetCount/GetText/SetText + Text/CommaText/DelimitedText/Delimiter/
 * NameValueSeparator properties + Values[]/Strings[] sub-facades + 0-based
  * default bracket access. LoadFrom/SaveTo route through the injected
 * jailed IO (`io`); without one they raise (FMD2 parity: the jail not being
 * configured is a host setup error, and Pascal LoadFromFile on a missing
 * file raises too). Mutations land in `handle.list` so callers/tests can
 * harvest them host-side.
 */
export function makeTStrings(bridge: FacadeBridge, io?: TStringsFileIO): TStringsHandle {
  const list = new PascalTStrings();

  const readFile = (path: unknown): string => {
    if (io === undefined) {
      throw new Error('LoadFromFile: no jailed file IO configured for this list');
    }
    return io.loadFromFile(toStr(path));
  };
  const writeFile = (path: unknown, content: unknown): void => {
    if (io === undefined) {
      throw new Error('SaveToFile: no jailed file IO configured for this list');
    }
    io.saveToFile(toStr(path), content === undefined || content === null ? '' : toStr(content));
  };

  const valuesFacadeId = bridge.create('', {
    get: (k) => list.getValue(toStr(k)),
    set: (k, v) => {
      list.setValue(toStr(k), toStr(v));
    },
  });
  const stringsFacadeId = bridge.create('', {
    get: (k) => list.get(toInteger(k)),
    set: (k, v) => {
      list.set(toInteger(k), toStr(v));
    },
  });

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    Add: (v: unknown) => {
      list.add(toStr(v));
      return undefined; // strings_add: Result := 0 → nil (LuaStrings.pas:67-71)
    },
    AddText: (v: unknown) => {
      list.addText(toStr(v));
      return undefined;
    },
    Get: (i: unknown) => list.get(toInteger(i)),
    Set: (i: unknown, v: unknown) => {
      list.set(toInteger(i), toStr(v));
      return undefined;
    },
    Clear: () => {
      list.clear();
      return undefined;
    },
    Delete: (i: unknown) => {
      list.delete(toInteger(i));
      return undefined;
    },
    IndexOf: (v: unknown) => list.indexOf(toStr(v)),
    IndexOfName: (v: unknown) => list.indexOfName(toStr(v)),
    Reverse: () => {
      list.reverse();
      return undefined;
    },
    Sort: () => {
      list.sort();
      return undefined;
    },
    GetCount: () => list.count,
    GetText: () => list.getText(),
    SetText: (v: unknown) => {
      list.setText(toStr(v));
      return undefined;
    },
    LoadFromFile: (path: unknown) => {
      list.setText(readFile(path));
      return undefined;
    },
    SaveToFile: (path: unknown) => {
      writeFile(path, list.getText());
      return undefined;
    },
    // stream overloads need the §5.4 stream facade; FMD2 raises on
    // non-stream userdata too (luaToUserData type check)
    LoadFromStream: () => {
      throw new Error('LoadFromStream: stream objects are not available in this build');
    },
    SaveToStream: () => {
      throw new Error('SaveToStream: stream objects are not available in this build');
    },
  };

  const spec: FacadeSpec = {
    get(key) {
      if (typeof key === 'number') {
        return list.get(key);
      }
      switch (key) {
        case 'Count':
          return list.count;
        case 'Text':
          return list.getText();
        case 'CommaText':
          return list.getCommaText();
        case 'DelimitedText':
          return list.getDelimitedText();
        case 'Delimiter':
          return list.delimiter;
        case 'NameValueSeparator':
          return list.nameValueSeparator;
        default:
          break;
      }
      const method = methods[key];
      if (method !== undefined) {
        return method;
      }
      return undefined; // unknown key: silent no-op (LuaClass semantics)
    },
    set(key, value) {
      if (typeof key === 'number') {
        list.set(key, toStr(value));
        return;
      }
      switch (key) {
        case 'Text':
          list.setText(toStr(value));
          return;
        case 'CommaText':
          list.setCommaText(toStr(value));
          return;
        case 'DelimitedText':
          list.setDelimitedText(toStr(value));
          return;
        case 'Delimiter':
          list.delimiter = toStr(value).slice(0, 1); // String(...)[1]
          return;
        case 'NameValueSeparator':
          list.nameValueSeparator = toStr(value).slice(0, 1);
          return;
        default:
          // unknown keys + read-only Count: silent no-op (LuaClass semantics)
          return;
      }
    },
    len() {
      return list.count;
    },
    sub(key) {
      if (key === 'Values') {
        return valuesFacadeId;
      }
      if (key === 'Strings') {
        return stringsFacadeId;
      }
      return undefined;
    },
  };

  return { spec, list };
}

/**
 * Realpath-jailed TStrings file IO (§8.2): paths must resolve INSIDE
 * `jailRoot`; symlinks escaping the jail are refused (readlink walk).
 */
export function createJailedFileIO(jailRoot: string): TStringsFileIO {
  const root = realpathSync(jailRoot);

  const jailed = (path: string): string => {
    const abs = resolve(root, path);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
      throw new Error(`path escapes the jail: ${path}`);
    }
    return abs;
  };

  /** Refuse symlinks that resolve outside the jail (component walk). */
  const checkReal = (abs: string): void => {
    let cur = abs;
    while (true) {
      if (existsSync(cur) && statSync(cur).isSymbolicLink()) {
        const target = realpathSync(cur);
        if (target !== root && !target.startsWith(root + sep)) {
          throw new Error(`path escapes the jail (symlink): ${cur}`);
        }
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };

  return {
    loadFromFile(path: string): string {
      const abs = jailed(path);
      checkReal(abs);
      return readFileSync(abs, 'utf8');
    },
    saveToFile(path: string, content: string): void {
      const abs = jailed(path);
      checkReal(abs);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    },
  };
}

/**
 * HTTP facade stub (§5.4, LuaHTTPSend.pas:171-198): exact surface shape,
 * offline behavior — requests return false, defaults per contract.json
 * (`RetryCount=0`, `MaxRedirect=5`), `Terminated` read-only from the
 * injected abort handle.
 */
export function makeHTTPSpec(abortProvider: () => HttpAbortHandle, bridge: FacadeBridge): FacadeSpec {
  const backing = new Map<string, string | number | boolean>([
    ['Timeout', 0],
    ['RetryCount', 0],
    ['MaxRedirect', 5],
    ['EnabledCookies', true],
    ['FollowRedirection', true],
    ['AllowServerErrorResponse', false],
    ['Compress', false],
    ['MimeType', ''],
    ['UserAgent', ''],
  ]);
  const headers = makeTStrings(bridge);
  const cookies = makeTStrings(bridge);
  const documentFacadeId = bridge.create('', {
    get: (k) => (k === 'Size' ? 0 : undefined),
    set: () => undefined,
  });
  const headersFacadeId = bridge.create('', headers.spec);
  const cookiesFacadeId = bridge.create('', cookies.spec);
  return {
    get(key) {
      if (typeof key !== 'string') {
        return undefined;
      }
      if (key === 'Terminated') {
        return abortProvider().terminated;
      }
      if (key === 'ResultCode') {
        return 0;
      }
      if (key === 'ResultString' || key === 'LastURL') {
        return '';
      }
      const stored = backing.get(key);
      if (stored !== undefined) {
        return stored;
      }
      const method = HTTP_METHODS[key];
      return method !== undefined ? method : undefined;
    },
    set(key, value) {
      if (typeof key === 'string' && backing.has(key)) {
        const current = backing.get(key);
        backing.set(
          key,
          typeof current === 'number'
            ? toInteger(value)
            : typeof current === 'boolean'
              ? toBool(value)
              : toStr(value),
        );
      }
      // read-only + unknown keys: silent no-op
    },
    sub(key) {
      if (key === 'Headers') {
        return headersFacadeId;
      }
      if (key === 'Cookies') {
        return cookiesFacadeId;
      }
      if (key === 'Document') {
        return documentFacadeId;
      }
      return undefined;
    },
  };
}

const HTTP_METHODS: Record<string, () => unknown> = {
  Request: returnFalse,
  GET: returnFalse,
  POST: returnFalse,
  HEAD: returnFalse,
  XHR: returnFalse,
  Reset: noopFn,
  ResetBasic: noopFn,
  ClearCookies: noopFn,
  ClearCookiesStorage: noopFn,
  GetCookies: noopFn,
  AddServerCookies: noopFn,
  ParseServerCookies: noopFn,
  MergeCookies: noopFn,
  RemoveCookie: noopFn,
  SetProxy: noopFn,
};

function returnFalse(): boolean {
  return false;
}

function noopFn(): undefined {
  return undefined;
}

/**
 * TXQuery facade stub (§5.6, LuaXQuery.pas:192-201): exact method surface,
 * empty results (FMD2 swallows evaluation errors → empty too,
 * XQueryEngineHTML.pas:358-399).
 */
export function makeTXQuerySpec(): FacadeSpec {
  return {
    get(key) {
      const method = TXQUERY_METHODS[key];
      return method !== undefined ? method : undefined;
    },
    set() {
      // unknown keys: silent no-op
    },
  };
}

const TXQUERY_METHODS: Record<string, () => unknown> = {
  ParseHTML: noopFn,
  XPath: returnStubIXQValue,
  XPathString: returnEmptyString,
  XPathStringAll: returnEmptyString,
  XPathHREFAll: noopFn,
  XPathHREFTitleAll: noopFn,
  XPathCount: returnZero,
};

function returnZero(): number {
  return 0;
}

function returnEmptyString(): string {
  return '';
}

function returnStubIXQValue(): Record<string, never> {
  return {};
}
