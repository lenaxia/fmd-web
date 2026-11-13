import type { HttpAbortHandle } from '@fmd/contract';
import { toBool, toInteger, toStr } from './base-globals.js';
import type { FacadeBridge, FacadeSpec } from './facade.js';

/**
 * Offline facade stubs shared by the Init pass and the event dispatcher.
 * The full §5.4 (HTTP/undici) and §5.6 (TXQuery/InternetTools) semantics
 * are their own stories; these stubs expose the exact surface shape with
 * inert behavior, enough for Init and dispatch-protocol tests.
 */

export interface TStringsHandle {
  readonly spec: FacadeSpec;
  readonly values: string[];
}

/**
 * TStrings facade stub (§5.5, LuaStrings.pas:216-263): Add/Get/Set[i]/
 * Count/Clear/Delete/IndexOf/Reverse/Sort/GetCount + Text/Values[]/Strings[]
 * bracket access. File-backed methods are inert (job-temp fs jail is a
 * later story). Mutations land in `values` so callers/tests can read them
 * back host-side.
 */
export function makeTStrings(bridge: FacadeBridge): TStringsHandle {
  const values: string[] = [];

  const nameOf = (line: string): string => {
    const eq = line.indexOf('=');
    return eq === -1 ? '' : line.slice(0, eq).trim();
  };

  const valuesSpec: FacadeSpec = {
    get: (k) => {
      for (const line of values) {
        if (nameOf(line) === toStr(k)) {
          const eq = line.indexOf('=');
          return eq === -1 ? '' : line.slice(eq + 1);
        }
      }
      return '';
    },
    set: (k, v) => {
      const name = toStr(k);
      const entry = `${name}=${toStr(v)}`;
      for (let i = 0; i < values.length; i += 1) {
        if (nameOf(values[i] ?? '') === name) {
          values[i] = entry;
          return;
        }
      }
      values.push(entry);
    },
  };

  const stringsSpec: FacadeSpec = {
    get: (k) => values[toInteger(k)] ?? '',
    set: (k, v) => {
      values[toInteger(k)] = toStr(v);
    },
  };
  const valuesFacadeId = bridge.create('', valuesSpec);
  const stringsFacadeId = bridge.create('', stringsSpec);

  const indexOf = (needle: string): number => {
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] === needle) {
        return i;
      }
    }
    return -1;
  };

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    Add: (v: unknown) => {
      values.push(toStr(v));
      return undefined;
    },
    AddText: (v: unknown) => {
      for (const line of toStr(v).split('\n')) {
        values.push(line);
      }
      return undefined;
    },
    Get: (i: unknown) => values[toInteger(i)] ?? '',
    Set: (i: unknown, v: unknown) => {
      values[toInteger(i)] = toStr(v);
      return undefined;
    },
    Clear: () => {
      values.length = 0;
      return undefined;
    },
    Delete: (i: unknown) => {
      values.splice(toInteger(i), 1);
      return undefined;
    },
    IndexOf: (v: unknown) => indexOf(toStr(v)),
    IndexOfName: (v: unknown) => {
      for (let i = 0; i < values.length; i += 1) {
        if (nameOf(values[i] ?? '') === toStr(v)) {
          return i;
        }
      }
      return -1;
    },
    Reverse: () => {
      values.reverse();
      return undefined;
    },
    Sort: () => {
      values.sort();
      return undefined;
    },
    GetCount: () => values.length,
    GetText: () => values.join('\n'),
    SetText: (v: unknown) => {
      values.length = 0;
      for (const line of toStr(v).split('\n')) {
        values.push(line);
      }
      return undefined;
    },
    // fs-backed and stream methods stay inert until the §5.5 story
    LoadFromFile: noopFn,
    SaveToFile: noopFn,
    LoadFromStream: noopFn,
    SaveToStream: noopFn,
  };

  const spec: FacadeSpec = {
    get(key) {
      if (typeof key === 'number') {
        return values[key] ?? '';
      }
      switch (key) {
        case 'Count':
          return values.length;
        case 'Text':
          return values.join('\n');
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
        values[key] = toStr(value);
        return;
      }
      if (key === 'Text') {
        values.length = 0;
        for (const line of toStr(value).split('\n')) {
          values.push(line);
        }
      }
      // unknown keys: silent no-op
    },
    len() {
      return values.length;
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

  return { spec, values };
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
