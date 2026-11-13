import type { ModuleId } from '@fmd/contract';
import {
  AsyncMutex,
  AsyncRWLock,
  LockHoldTracker,
  PerKeyMutexPool,
  hostOf,
} from './locks.js';
import type { ModuleStatePersistence, PersistedModuleState } from './persistence.js';

/**
 * Per-module shared state service (DESIGN.md §5.3): ONE host-side instance
 * per module, independent of the worker pool — cookie jar (RW lock),
 * `MODULE.Storage` KV (per-key mutex), `Account` (mutex), module settings
 * (copy-on-read), bypass state, per-host connection limiter. Same-module
 * events MAY run concurrently across workers (D12); ONLY these objects
 * lock — never an event, and never across an injected user callback
 * (the {@link LockHoldTracker} is the test detector).
 *
 * Mirrors the locked Pascal objects: `LuaStringsStorage.pas:17,75`
 * (Storage critical section), `httpcookiemanager.pas:46` (cookie
 * critical section), `WebsiteModules.pas:90` (module Guardian).
 */

export type AccountStatus = 0 | 1 | 2 | 3; // asUnknown, asChecking, asValid, asInvalid
export type OptionValue = boolean | string | number;

/** Snapshot returned by reads — callers never hold a live reference (copy-on-read). */
export interface CookieSnapshot {
  readonly entries: Readonly<Record<string, string>>;
  readonly count: number;
  /** `Cookie` request-header form (`name=value; name=value`). */
  readonly requestHeader: string;
  /** FMD2 `TStrings.Text` form joined with `;` (`Settings.HTTP.Cookies`). */
  readonly settingsText: string;
}

export interface AccountSnapshot {
  readonly enabled: boolean;
  readonly username: string;
  readonly password: string;
  readonly cookies: string;
  readonly status: AccountStatus;
}

export interface SettingsSnapshot {
  readonly enabled: boolean;
  /** ';'-joined module-settings cookies (`Settings.HTTP.Cookies`). */
  readonly cookies: string;
  readonly userAgent: string;
  readonly options: Readonly<Record<string, OptionValue>>;
}

/** Parse FMD2 settings cookie text (`a=1; b=2`) into pairs. */
export function parseCookieText(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of text.split(';')) {
    const item = part.trim();
    if (item === '') {
      continue;
    }
    const eq = item.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    out.push([item.slice(0, eq).trim(), item.slice(eq + 1).trim()]);
  }
  return out;
}

/** Shared per-module cookie jar — RW lock (§5.3), snapshot-on-read. */
export class SharedCookieJar {
  private readonly jar = new Map<string, string>();

  constructor(private readonly lock: AsyncRWLock) {}

  /** Shared read — returns an immutable snapshot. */
  async snapshot(): Promise<CookieSnapshot> {
    return this.lock.runRead(() => this.snapshotSync());
  }

  /** Exclusive write transaction. The lock NEVER spans user callbacks. */
  async write<T>(fn: (jar: SharedCookieJar) => T | Promise<T>): Promise<T> {
    return this.lock.runWrite(() => fn(this));
  }

  /** Mutators (JS-atomic). Concurrency tests use `write`/`snapshot` for RW semantics. */
  set(name: string, value: string): void {
    this.jar.set(name.toLowerCase(), value);
  }

  get(name: string): string {
    return this.jar.get(name.toLowerCase()) ?? '';
  }

  remove(name: string): void {
    this.jar.delete(name.toLowerCase());
  }

  clear(): void {
    this.jar.clear();
  }

  /** One Set-Cookie header's first name=value pair (`ParseServerCookies`). */
  addServerCookie(setCookie: string): void {
    const pair = setCookie.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      return;
    }
    this.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }

  /** Merge a cookie snapshot or pairs under one write lock. */
  mergeEntries(pairs: Iterable<[string, string]>): void {
    for (const [k, v] of pairs) {
      this.set(k, v);
    }
  }

  snapshotSync(): CookieSnapshot {
    const entries = Object.freeze(Object.fromEntries(this.jar));
    return {
      entries,
      count: this.jar.size,
      requestHeader: [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
      settingsText: [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join(';'),
    };
  }

  get size(): number {
    return this.jar.size;
  }
}

/** `MODULE.Storage` KV — per-key mutex (§5.3, `LuaStringsStorage.pas:17,75`). */
export class SharedStorage {
  private readonly map = new Map<string, string>();

  constructor(private readonly keyMutexes: PerKeyMutexPool) {}

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  /** FMD2 `Storage.Values[key].Contains('true')` reads need '' for missing keys. */
  getOrEmpty(key: string): string {
    return this.map.get(key) ?? '';
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map);
  }

  /** Replace the whole map (Init-time seeding / persistence load). */
  loadAll(entries: Record<string, string>): void {
    for (const [k, v] of Object.entries(entries)) {
      this.map.set(k, v);
    }
  }

  /** `Storage.Text` = newline-joined `name=value` lines (TStrings.Text). */
  get text(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
  }

  set text(value: string) {
    this.map.clear();
    for (const line of value.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        this.map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
    }
  }

  /**
   * Read-modify-write transaction on ONE key — the per-key mutex. Same-key
   * transactions serialize; different keys run concurrently (the granularity
   * the tests assert).
   */
  runExclusive<T>(key: string, fn: (current: string | undefined) => T | Promise<T>): Promise<T> {
    return this.keyMutexes.runExclusive(key, () => fn(this.map.get(key)));
  }

  /**
   * Committing transaction: `fn` returns the new value, written back under
   * the per-key mutex (concurrent transacts on one key compose exactly).
   */
  async transact(key: string, fn: (current: string | undefined) => string | Promise<string>): Promise<string> {
    return this.keyMutexes.runExclusive(key, async () => {
      const next = await fn(this.map.get(key));
      this.map.set(key, next);
      return next;
    });
  }
}

/** `MODULE.Account` — mutex-guarded credentials/status (§5.3). */
export class SharedAccount {
  enabled = false;
  username = '';
  password = '';
  cookies = '';
  status: AccountStatus = 0; // asUnknown

  constructor(private readonly mutex: AsyncMutex) {}

  async snapshot(): Promise<AccountSnapshot> {
    return this.mutex.runExclusive(() => ({
      enabled: this.enabled,
      username: this.username,
      password: this.password,
      cookies: this.cookies,
      status: this.status,
    }));
  }

  /** Exclusive transaction (Login/AccountState flows). */
  runExclusive<T>(fn: (account: SharedAccount) => T | Promise<T>): Promise<T> {
    return this.mutex.runExclusive(() => fn(this));
  }
}

/**
 * Per-module settings — copy-on-read (§5.3: "options = copy-on-read"):
 * every read returns a frozen snapshot; mutations go through the settings
 * mutex. Hosts the bypass-persisted `cookies`/`ua` (`m.Settings.HTTP.*`,
 * `LuaWebsiteBypass.pas:182-183`).
 */
export class ModuleSettings {
  enabled = true;
  cookies = '';
  userAgent = '';
  private readonly options = new Map<string, OptionValue>();

  constructor(private readonly mutex: AsyncMutex) {}

  async snapshot(): Promise<SettingsSnapshot> {
    return this.mutex.runExclusive(() => this.snapshotSync());
  }

  /** Synchronous snapshot for the request path (JS-atomic; copy-on-read). */
  snapshotSync(): SettingsSnapshot {
    return Object.freeze({
      enabled: this.enabled,
      cookies: this.cookies,
      userAgent: this.userAgent,
      options: Object.freeze(Object.fromEntries(this.options)),
    });
  }

  getOption(name: string): OptionValue | undefined {
    return this.options.get(name);
  }

  setOption(name: string, value: OptionValue): void {
    this.options.set(name, value);
  }

  async setCookies(text: string): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.cookies = text;
    });
  }

  async setUserAgent(ua: string): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.userAgent = ua;
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.enabled = enabled;
    });
  }

  loadPersisted(row: PersistedModuleState): void {
    this.enabled = row.enabled;
    this.cookies = row.cookies;
    this.userAgent = row.ua;
    for (const [k, v] of Object.entries(row.options ?? {})) {
      this.options.set(k, v);
    }
  }
}

/**
 * Per-module single-flight gate for the bypass (FMD2 `TWebsiteBypass.Guardian`
 * used with `TryEnterCriticalsection`, `LuaWebsiteBypass.pas:161,196-200`):
 * `tryEnter` = TryEnter — a concurrent LOSER must proceed with the plain
 * request, never wait behind an in-flight bypass.
 */
export class BypassGate {
  private held = false;
  private enteredCount = 0;

  /** TryEnter semantics: true = winner (must call leave()), false = loser. */
  tryEnter(): boolean {
    if (this.held) {
      return false;
    }
    this.held = true;
    this.enteredCount += 1;
    return true;
  }

  leave(): void {
    this.held = false;
  }

  get busy(): boolean {
    return this.held;
  }

  /** Total successful tryEnter calls (test diagnostics). */
  get entries(): number {
    return this.enteredCount;
  }
}

/**
 * Per-host connection limiter (mirrors FMD2 `THTTPQueue`, `WebsiteModules.pas`
 * `MaxConnectionLimit` — a limit of 0 means "no limit", `:543-550`). Per-host
 * FIFO slots; hosts are independent.
 */
export class HostConnectionLimiter {
  private readonly limits = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Array<() => void>>();

  constructor(private defaultLimit = 0) {}

  setDefaultLimit(limit: number): void {
    this.defaultLimit = Math.max(0, Math.trunc(limit));
  }

  setHostLimit(host: string, limit: number): void {
    this.limits.set(host.toLowerCase(), Math.max(0, Math.trunc(limit)));
  }

  limitFor(host: string): number {
    return this.limits.get(host.toLowerCase()) ?? this.defaultLimit;
  }

  activeFor(host: string): number {
    return this.active.get(host.toLowerCase()) ?? 0;
  }

  /** Acquire one connection slot for `url`'s host; 0-limit = immediate. */
  async acquire(url: string): Promise<() => void> {
    const host = hostOf(url);
    const limit = this.limitFor(host);
    if (limit <= 0) {
      return () => undefined;
    }
    const n = this.activeFor(host);
    if (n < limit) {
      this.active.set(host, n + 1);
      return this.makeRelease(host);
    }
    return new Promise<() => void>((resolve) => {
      let q = this.queues.get(host);
      if (q === undefined) {
        q = [];
        this.queues.set(host, q);
      }
      // The releasing slot hands off directly — the active count never changes.
      q.push(() => resolve(this.makeRelease(host)));
    });
  }

  private makeRelease(host: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.queues.get(host)?.shift();
      if (next !== undefined) {
        next(); // slot transfers directly to the next waiter
        return;
      }
      const n = this.activeFor(host) - 1;
      if (n <= 0) {
        this.active.delete(host);
      } else {
        this.active.set(host, n);
      }
    };
  }
}

/** One module's shared state bundle (§5.3 item 1). */
export interface ModuleSharedState {
  readonly moduleId: ModuleId;
  readonly cookies: SharedCookieJar;
  readonly storage: SharedStorage;
  readonly account: SharedAccount;
  readonly settings: ModuleSettings;
  readonly bypass: BypassGate;
  readonly limiter: HostConnectionLimiter;
  /** Persist this module's module_state row (cookies/ua/options/storage). */
  persist(): Promise<void>;
}

export interface ModuleStateServiceOptions {
  /** module_state persistence (§9); omit = no persistence (in-service only). */
  readonly persistence?: ModuleStatePersistence;
  /** Default per-host connection limit for new module states (0 = unlimited). */
  readonly defaultConnectionLimit?: number;
}

export interface ModuleStateSnapshot {
  readonly moduleId: ModuleId;
  readonly cookieCount: number;
  readonly storageKeys: readonly string[];
  readonly accountStatus: 'asUnknown' | 'asChecking' | 'asValid' | 'asInvalid';
  readonly settings: SettingsSnapshot;
  readonly bypassBusy: boolean;
}

const ACCOUNT_STATUS_NAMES = ['asUnknown', 'asChecking', 'asValid', 'asInvalid'] as const;

/**
 * The shared-state service (§5.3): `forModule(id)` hands out THE one state
 * bundle per module (created on first use, seeded from persistence), across
 * every worker/event touching that module. `restartWith`-style recovery is
 * simply a NEW service over the same persistence adapter.
 */
export class ModuleStateService {
  private readonly states = new Map<ModuleId, ModuleSharedState>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  /** Hold tracker shared by every lock in this service (the test detector). */
  readonly tracker = new LockHoldTracker();

  constructor(private readonly options: ModuleStateServiceOptions = {}) {}

  /** Ensure the persistence rows are loaded (once per service instance). */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (this.loadPromise === null) {
      this.loadPromise = (async () => {
        if (this.options.persistence !== undefined) {
          const rows = await this.options.persistence.loadAll();
          for (const [id, row] of Object.entries(rows)) {
            const state = this.createState(id);
            this.seedFromPersistence(state, row);
            this.states.set(id, state);
          }
        }
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  /** THE per-module instance (created once, reused by all workers/events). */
  async forModule(moduleId: ModuleId): Promise<ModuleSharedState> {
    await this.ensureLoaded();
    let state = this.states.get(moduleId);
    if (state === undefined) {
      state = this.createState(moduleId);
      this.states.set(moduleId, state);
    }
    return state;
  }

  /** Synchronous access for paths that already hold the state (no create). */
  peek(moduleId: ModuleId): ModuleSharedState | undefined {
    return this.states.get(moduleId);
  }

  get moduleIds(): ModuleId[] {
    return [...this.states.keys()];
  }

  /** Write module_state rows for every loaded module (§9 cookies/ua). */
  async flush(): Promise<void> {
    if (this.options.persistence === undefined) {
      return;
    }
    for (const state of this.states.values()) {
      await this.persistState(state);
    }
  }

  /** Live snapshot for diagnostics/API (§9 module_state projection). */
  async snapshot(moduleId: ModuleId): Promise<ModuleStateSnapshot> {
    const state = await this.forModule(moduleId);
    const jar = await state.cookies.snapshot();
    const settings = await state.settings.snapshot();
    const account = await state.account.snapshot();
    return {
      moduleId,
      cookieCount: jar.count,
      storageKeys: state.storage.keys(),
      accountStatus: ACCOUNT_STATUS_NAMES[account.status],
      settings,
      bypassBusy: state.bypass.busy,
    };
  }

  private createState(moduleId: ModuleId): ModuleSharedState {
    const tracker = this.tracker;
    const cookies = new SharedCookieJar(new AsyncRWLock(tracker, `cookies:${moduleId}`));
    const storage = new SharedStorage(new PerKeyMutexPool(tracker));
    const account = new SharedAccount(new AsyncMutex(tracker, `account:${moduleId}`));
    const settings = new ModuleSettings(new AsyncMutex(tracker, `settings:${moduleId}`));
    const limiter = new HostConnectionLimiter(this.options.defaultConnectionLimit ?? 0);
    const state: ModuleSharedState = {
      moduleId,
      cookies,
      storage,
      account,
      settings,
      bypass: new BypassGate(),
      limiter,
      persist: () => this.persistState(state),
    };
    return state;
  }

  private seedFromPersistence(state: ModuleSharedState, row: PersistedModuleState): void {
    state.settings.loadPersisted(row);
    state.cookies.mergeEntries(parseCookieText(row.cookies));
    state.storage.loadAll(row.storage ?? {});
  }

  private async persistState(state: ModuleSharedState): Promise<void> {
    const persistence = this.options.persistence;
    if (persistence === undefined) {
      return;
    }
    const settings = await state.settings.snapshot();
    await persistence.save(state.moduleId, {
      cookies: settings.cookies,
      ua: settings.userAgent,
      enabled: settings.enabled,
      options: { ...settings.options },
      storage: state.storage.snapshot(),
    });
  }
}

/** `emptySnapshot` compatibility for the §9 projection placeholder users. */
export function emptySnapshot(moduleId: ModuleId): ModuleStateSnapshot {
  return {
    moduleId,
    cookieCount: 0,
    storageKeys: [],
    accountStatus: 'asUnknown',
    settings: Object.freeze({ enabled: true, cookies: '', userAgent: '', options: Object.freeze({}) }),
    bypassBusy: false,
  };
}
