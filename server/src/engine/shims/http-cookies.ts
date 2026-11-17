import type { LuaCookieJarPort } from '../contract.js';
import { NameValueMap } from './http-headers.js';

/**
 * Cookie jar + the shared-state port (DESIGN §5.3/§5.4): the per-object
 * cookie facade is backed by the module's shared cookie jar (one
 * host-side instance per module, `httpcookiemanager.pas` semantics) so
 * cookies persist across request-scoped HTTP objects; without a shared
 * port the jar is local to the object (unit-test mode).
 */

/**
 * Structural port implemented by the state service's `SharedCookieJar`
 * (engine/state/module-state.ts: get/set/remove/clear/addServerCookie/
 * size/snapshotSync) — the shim depends on this narrow interface, never
 * on the concrete service. Owned by the contract (LuaCookieJarPort) so
 * the LuaHost/LuaDispatcherShims boundary carries it; this alias keeps
 * the historical name working.
 */
export type CookieJarPort = LuaCookieJarPort;

/** Cookie name/value pairs of a jar snapshot (jar order). */
function jarPairs(jar: CookieJarPort): Array<[string, string]> {
  if (jar instanceof CookieJar) {
    return jar.entries();
  }
  const shared = jar as CookieJarPort & {
    snapshotSync?: () => { readonly entries: Readonly<Record<string, string>> };
    snapshot?: () => Record<string, string>;
  };
  if (shared.snapshotSync !== undefined) {
    return Object.entries(shared.snapshotSync().entries);
  }
  if (shared.snapshot !== undefined) {
    return Object.entries(shared.snapshot());
  }
  return [];
}

/** Local (non-shared) jar — the CookieJarPort fallback. */
export class CookieJar implements CookieJarPort {
  /** lower(name) → [written name, value]; first-written casing is kept. */
  private readonly jar = new Map<string, [string, string]>();

  get size(): number {
    return this.jar.size;
  }

  get(name: string): string {
    return this.jar.get(name.toLowerCase())?.[1] ?? '';
  }

  set(name: string, value: string): void {
    const key = name.toLowerCase();
    const existing = this.jar.get(key);
    if (existing !== undefined) {
      existing[1] = value;
      return;
    }
    this.jar.set(key, [name, value]);
  }

  remove(name: string): void {
    this.jar.delete(name.toLowerCase());
  }

  clear(): void {
    this.jar.clear();
  }

  addServerCookie(setCookie: string): void {
    const pair = firstCookiePair(setCookie);
    if (pair !== undefined) {
      this.set(pair[0], pair[1]);
    }
  }

  entries(): Array<[string, string]> {
    return [...this.jar.values()].map(([written, value]) => [written, value] as [string, string]);
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [written, value] of this.jar.values()) {
      out[written] = value;
    }
    return out;
  }
}

/**
 * First `name=value` pair of a Set-Cookie line (`ParseServerCookies`,
 * httpcookiemanager.pas: attributes after the first ';' are dropped).
 */
export function firstCookiePair(setCookie: string): [string, string] | undefined {
  const pair = setCookie.split(';')[0] ?? '';
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    return undefined;
  }
  return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
}

/**
 * The object-level cookie store: jar (shared port or local) + the raw
 * '='-less lines `MergeCookies` appends (httpsendthread.pas:773-787).
 * All §5.4 cookie methods delegate here.
 */
export class CookieStore {
  private readonly rawLines: string[] = [];

  constructor(private readonly jar: CookieJarPort) {}

  /** Case-insensitive `Values[name]` get. */
  get(name: string): string {
    return this.jar.get(name);
  }

  /** Case-insensitive `Values[name]` set. */
  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  /** `name=value` lines (jar pairs in order, then bare merged lines). */
  lines(): string[] {
    return [...jarPairs(this.jar).map(([k, v]) => `${k}=${v}`), ...this.rawLines];
  }

  /** Indexed read `Cookies[i]` (0-based, TStrings.Strings). */
  lineAt(index: number): string {
    return this.lines()[index] ?? '';
  }

  count(): number {
    return this.lines().length;
  }

  /** `ClearCookies` (httpsendthread.pas:951-953). */
  clear(): void {
    this.jar.clear();
    this.rawLines.length = 0;
  }

  /** `GetCookies` (:758-768): `; `-joined lines. */
  getCookieString(): string {
    return this.lines().join('; ');
  }

  /** One Set-Cookie line into the jar (first pair wins). */
  addServerCookie(setCookie: string): void {
    this.jar.addServerCookie(setCookie);
  }

  /**
   * `MergeCookies` (:773-787): ';'-split; `name=value` pairs overwrite,
   * bare lines are appended once.
   */
  merge(cookieString: string): void {
    for (const part of cookieString.split(';')) {
      const s = part.trim();
      if (s === '') {
        continue;
      }
      const eq = s.indexOf('=');
      if (eq > 0) {
        this.set(s.slice(0, eq).trim(), s.slice(eq + 1).trim());
      } else if (!this.lines().includes(s)) {
        this.rawLines.push(s);
      }
    }
  }

  /**
   * `RemoveCookie` (:830-839): delete by name; empty name is a no-op.
   */
  remove(name: string): void {
    if (name === '') {
      return;
    }
    this.jar.remove(name);
    const i = this.rawLines.indexOf(name);
    if (i !== -1) {
      this.rawLines.splice(i, 1);
    }
  }

  /** `Cookie` request-header form — jar pairs only (`; `-joined). */
  requestHeader(): string {
    return jarPairs(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Feed one response's Set-Cookie headers (HTTPMethod :572-574). */
  feedResponseHeaders(headers: NameValueMap): void {
    for (const [name, value] of headers.entries()) {
      if (name.toLowerCase() !== 'set-cookie') {
        continue;
      }
      for (const line of value.split('\n')) {
        const trimmed = line.trim();
        if (trimmed !== '') {
          this.addServerCookie(trimmed);
        }
      }
    }
  }
}
