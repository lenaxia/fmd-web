import { toBool, toInteger, toStr } from './base-globals.js';
import type { FacadeBridge, FacadeSpec } from './facade.js';
import { PascalTStrings, compareText } from './tstrings.js';

/**
 * MODULE.Storage facade (§5.5, LuaStringsStorage.pas:143-159) + the
 * `StorageStrings` seam it runs on (§5.3 shared state service).
 *
 * Contract (LuaStringsStorage.pas:11-63, FPC TStringList-backed):
 *  - KV default-array property (`Storage['key']`): TStringList Values
 *    semantics — names match ASCII-case-INSENSITIVELY (FPC IndexOfName /
 *    CompareText), value = everything after the first '=' separator,
 *    UNTRIMMED; missing key reads ''.
 *  - Text get/set: FPC TStrings.Text (trailing line break on non-empty;
 *    #10/#13/CRLF breaks; trailing break adds no item on set).
 *  - Remove(key): IndexOfName + Delete; missing key is a silent no-op.
 *  - Tag (Integer, default 0), Enable (Boolean, default True), Status
 *    (String, default 'my status of TStringsStorage' — the Pascal ctor's
 *    `Status := 'my status of ' + Self.ClassName`).
 *  - Free/Destroy are host-owned no-ops here: destroying the shared state
 *    from module code would corrupt other workers (§5.3); modules never
 *    call them (documented deviation from LuaStringsStorage.pas:81-85).
 *
 * THREAD SAFETY (§5.3): every op runs behind `enter()`/`exit()` of the
 * injected lock. On the JS host the event loop makes the synchronous,
 * non-awaiting closures atomic; the lock object stays THE serialization
 * point the worker-pool story wires cross-thread access through.
 */

export interface StorageStrings {
  /** Values[key] read (case-insensitive name, untrimmed value; '' absent). */
  getValue(key: string): string;
  /** Values[key] write (in-place overwrite or append, FPC SetValue). */
  setValue(key: string, value: string): void;
  /** The whole KV text (FPC GetText: trailing line break when non-empty). */
  getText(): string;
  setText(text: string): void;
  /** Remove(key) — IndexOfName + Delete; missing key is a silent no-op. */
  remove(key: string): void;
  /** Current keys in list order (host snapshot/persistence). */
  keys(): string[];
  tag: number;
  enable: boolean;
  status: string;
}

/** LuaStringsStorage.pas:56-59 ctor defaults. */
export const STORAGE_STATUS_DEFAULT = 'my status of TStringsStorage';

export interface StorageLock {
  enter(): void;
  exit(): void;
}

/** The default backing: FPC TStringList semantics behind a critical section. */
export class TStringsStorageStrings implements StorageStrings {
  private readonly strings = new PascalTStrings();

  constructor(private readonly lock: StorageLock = { enter: () => undefined, exit: () => undefined }) {}

  getValue(key: string): string {
    this.lock.enter();
    try {
      return this.strings.getValue(key);
    } finally {
      this.lock.exit();
    }
  }

  setValue(key: string, value: string): void {
    this.lock.enter();
    try {
      this.strings.setValue(key, value);
    } finally {
      this.lock.exit();
    }
  }

  getText(): string {
    this.lock.enter();
    try {
      return this.strings.getText();
    } finally {
      this.lock.exit();
    }
  }

  setText(text: string): void {
    this.lock.enter();
    try {
      this.strings.setText(text);
    } finally {
      this.lock.exit();
    }
  }

  remove(key: string): void {
    // LuaStringsStorage.pas:44-55 — probe the index outside the section
    const i = this.strings.indexOfName(key);
    if (i < 0 || i >= this.strings.count) return;
    this.lock.enter();
    try {
      this.strings.delete(i);
    } finally {
      this.lock.exit();
    }
  }

  keys(): string[] {
    this.lock.enter();
    try {
      return this.strings.snapshot().map((line) => {
        const eq = line.indexOf('=');
        return eq === -1 ? line : line.slice(0, eq);
      });
    } finally {
      this.lock.exit();
    }
  }

  tag = 0;
  enable = true;
  status = STORAGE_STATUS_DEFAULT;
}

/**
 * §5.3 adapter: layer the FMD2 TStrings semantics (case-insensitive names,
 * untrimmed values) onto a plain string-map shared-state backing. Reads scan
 * keys ASCII-case-insensitively so `Storage['token']` and `Storage['Token']`
 * hit the same entry; writes reuse the EXISTING key casing.
 */
export function storageStringsFromMap(
  map: Map<string, string>,
  lock: StorageLock = { enter: () => undefined, exit: () => undefined },
): StorageStrings {
  const findKey = (name: string): string | undefined =>
    [...map.keys()].find((k) => compareText(k, name) === 0);
  const impl = new TStringsStorageStrings(lock);
  return {
    getValue(key: string): string {
      lock.enter();
      try {
        const actual = findKey(key);
        return actual === undefined ? '' : (map.get(actual) ?? '');
      } finally {
        lock.exit();
      }
    },
    setValue(key: string, value: string): void {
      lock.enter();
      try {
        const actual = findKey(key);
        map.set(actual ?? key, value);
      } finally {
        lock.exit();
      }
    },
    getText(): string {
      lock.enter();
      try {
        const entries = [...map.entries()];
        return entries.length === 0 ? '' : entries.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      } finally {
        lock.exit();
      }
    },
    setText(text: string): void {
      lock.enter();
      try {
        map.clear();
        // FPC SetTextStr line splitting; entries keep raw values (untrimmed)
        for (const line of textSplitLines(text)) {
          const eq = line.indexOf('=');
          if (eq > -1 && eq > 0) {
            map.set(line.slice(0, eq), line.slice(eq + 1));
          }
        }
      } finally {
        lock.exit();
      }
    },
    remove(key: string): void {
      lock.enter();
      try {
        const actual = findKey(key);
        if (actual !== undefined) map.delete(actual);
      } finally {
        lock.exit();
      }
    },
    keys(): string[] {
      lock.enter();
      try {
        return [...map.keys()];
      } finally {
        lock.exit();
      }
    },
    get tag() {
      return impl.tag;
    },
    set tag(v: number) {
      impl.tag = v;
    },
    get enable() {
      return impl.enable;
    },
    set enable(v: boolean) {
      impl.enable = v;
    },
    get status() {
      return impl.status;
    },
    set status(v: string) {
      impl.status = v;
    },
  };
}

/** FPC GetNextLine (stringl.inc:834): #10/#13/CRLF breaks; trailing → no item. */
function textSplitLines(value: string): string[] {
  const out: string[] = [];
  let p = 0;
  while (p < value.length) {
    const start = p;
    while (p < value.length && value.charCodeAt(p) !== 10 && value.charCodeAt(p) !== 13) {
      p += 1;
    }
    out.push(value.slice(start, p));
    if (value.charCodeAt(p) === 13) p += 1;
    if (value.charCodeAt(p) === 10) p += 1;
  }
  return out;
}

/**
 * The MODULE.Storage Lua facade spec over a `StorageStrings` backing
 * (§5.5, LuaStringsStorage.pas:143-159): KV default-array access, Text
 * get/set, Remove/Tag/Enable/Status, host-owned Free/Destroy.
 */
export function makeStorageSpec(bridge: FacadeBridge, storage: StorageStrings): FacadeSpec {
  void bridge;
  return {
    get(key) {
      if (typeof key === 'number') {
        return undefined; // Storage KV is string-keyed only
      }
      switch (key) {
        case 'Text':
          return storage.getText();
        case 'Tag':
          return storage.tag;
        case 'Enable':
          return storage.enable;
        case 'Status':
          return storage.status;
        case 'Remove':
          return (k: unknown) => {
            storage.remove(toStr(k));
            return undefined;
          };
        case 'Free':
        case 'Destroy':
          return () => undefined;
        default:
          return storage.getValue(key); // KV default-array access (§5.3)
      }
    },
    set(key, value) {
      if (typeof key !== 'string') {
        return;
      }
      switch (key) {
        case 'Text':
          storage.setText(toStr(value));
          return;
        case 'Tag':
          storage.tag = toInteger(value);
          return;
        case 'Enable':
          storage.enable = toBool(value);
          return;
        case 'Status':
          storage.status = toStr(value);
          return;
        default:
          storage.setValue(key, toStr(value));
          return;
      }
    },
  };
}
