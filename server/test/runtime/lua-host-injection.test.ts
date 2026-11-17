import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { HostLogger } from '@fmd/contract';
import type { HttpAbortHandle } from '../../src/engine/contract.js';
import type { EventDispatchResult, EventDispatcher, EventTaskSeed, EventDeadlineController, LuaChunk, LuaChunkCache, LuaChunkSetup, LuaDispatcherShims, LuaEngine, LuaHost, LuaHostFactory, LuaModuleDescriptor, ModuleRegistry } from '../../src/engine/contract.js';
import { EngineInfoService } from '../../src/engine/services/module-info.js';
import { EngineLoginSession as EngineLoginDriver } from '../../src/engine/services/account-session.js';
import { ModuleSyncService } from '../../src/engine/registry/module-sync.js';
import { RecordedResponseResolver } from '../../src/engine/shims/http-shim.js';
import { RecordedHttpTransport } from '../../src/engine/shims/http-transport.js';
import { EgressPolicy } from '../../src/engine/shims/http-egress.js';
import type { RegistrationRecord } from '../../src/engine/registry/capabilities.js';

/**
 * Lua host injection proof (tsk-able-steeple-tints criterion 2): the
 * runtime services (info / login / registry sweep) run against a fully
 * scripted LuaHost test double injected through the SAME contract
 * options field the composition root uses — no engine code modified,
 * no wasmoon anywhere. If a service reached for WasmoonLuaHost or engine
 * internals, this suite could not exist.
 */

// ── the double: contract-implementing host ──────────────────────────

/** Compile-only chunk stand-in (never compiles anything). */
class FakeChunkCache implements LuaChunkCache {
  async get(fileName: string, source: string): Promise<LuaChunk> {
    return { fileName, sha256: '0'.repeat(64), source, bytecode: new Uint8Array(0) };
  }

  peek(): undefined {
    return undefined;
  }

  invalidate(): void {
    // no-op
  }

  get size(): number {
    return 0;
  }

  get compileCount(): number {
    return 0;
  }
}

/** What the double is scripted to do per host. */
export interface FakeHostScript {
  /** Init pass: (file, source, logger) → descriptors ([] = failed file). */
  readonly loadFile: (
    fileName: string,
    source: string,
    logger: HostLogger,
  ) => readonly LuaModuleDescriptor[];
  /** doStringSync read-back answers (code → value). */
  readonly engineAnswers?: Readonly<Record<string, unknown>>;
  /** dispatch() script (default: no_error code 0). */
  readonly dispatch?: (
    descriptor: LuaModuleDescriptor,
    event: string,
  ) => EventDispatchResult;
}

class FakeModuleRegistry implements ModuleRegistry {
  readonly registered: LuaModuleDescriptor[] = [];

  constructor(
    private readonly logger: HostLogger,
    private readonly script: FakeHostScript,
  ) {}

  get modules(): readonly LuaModuleDescriptor[] {
    return this.registered;
  }

  byId(id: string): LuaModuleDescriptor | undefined {
    return this.registered.find((m): boolean => m.id === id);
  }

  async loadFile(
    fileName: string,
    source: string,
    _extraSetup?: LuaChunkSetup,
  ): Promise<readonly LuaModuleDescriptor[]> {
    const descriptors = this.script.loadFile(fileName, source, this.logger);
    this.registered.push(...descriptors);
    return descriptors;
  }
}

/** The engine surface the services touch (loadModule hook + read-backs). */
class FakeLuaEngine implements LuaEngine {
  readonly loadedFiles: string[] = [];
  readonly ran: string[] = [];
  private readonly answers: Readonly<Record<string, unknown>>;
  disposed = 0;

  constructor(answers: Readonly<Record<string, unknown>>) {
    this.answers = answers;
  }

  async loadModule(fileName: string, preChunkSetup?: LuaChunkSetup): Promise<void> {
    this.loadedFiles.push(fileName);
    // The services expect the §5.7 shim install to run here — hand the
    // installer the structural state surface (no-op double).
    preChunkSetup?.(
      { global: { set: (): void => undefined }, doStringSync: (): unknown => undefined },
      { create: (): number => 0, register: (): void => undefined },
    );
  }

  doStringSync(code: string): unknown {
    this.ran.push(code);
    return this.answers[code];
  }

  gcCollect(): void {
    // no-op
  }

  get callsSinceGc(): number {
    return 0;
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

/** Scripted dispatch + TASK read-back. */
class FakeDispatcher implements EventDispatcher {
  readonly dispatchedEvents: string[] = [];

  constructor(private readonly script: FakeHostScript) {}

  dispatch(descriptor: LuaModuleDescriptor, event: string): EventDispatchResult {
    this.dispatchedEvents.push(`${event}:${descriptor.name}`);
    return (
      this.script.dispatch?.(descriptor, event) ?? {
        kind: 'code' as const,
        value: 0,
        readBack: {},
      }
    );
  }

  readTask(): Required<EventTaskSeed> {
    return { pageLinks: [], pageContainerLinks: [], fileNames: [], pageNumber: 0, link: '' };
  }
}

class FakeLuaHost implements LuaHost {
  readonly chunkCache: LuaChunkCache = new FakeChunkCache();
  readonly registry: FakeModuleRegistry;
  readonly engines: FakeLuaEngine[] = [];
  readonly dispatchers: FakeDispatcher[] = [];
  lastShims: LuaDispatcherShims | undefined;
  disposed = 0;

  constructor(
    readonly logger: HostLogger,
    private readonly script: FakeHostScript,
  ) {
    this.registry = new FakeModuleRegistry(logger, script);
  }

  async createEngine(): Promise<LuaEngine> {
    const engine = new FakeLuaEngine(this.script.engineAnswers ?? {});
    this.engines.push(engine);
    return engine;
  }

  createDispatcher(
    _engine: LuaEngine,
    _abort: HttpAbortHandle,
    _deadline?: EventDeadlineController,
    shims?: LuaDispatcherShims,
  ): EventDispatcher {
    const dispatcher = new FakeDispatcher(this.script);
    this.dispatchers.push(dispatcher);
    this.lastShims = shims;
    return dispatcher;
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

/**
 * The factory double — injected EXACTLY like the composition root
 * injects the wasmoon one (same options field, same contract type).
 */
class FakeLuaHostFactory implements LuaHostFactory {
  readonly hosts: FakeLuaHost[] = [];

  constructor(private readonly script: FakeHostScript) {}

  createHost(logger: HostLogger): LuaHost {
    const host = new FakeLuaHost(logger, this.script);
    this.hosts.push(host);
    return host;
  }

  createChunkCache(): LuaChunkCache {
    return new FakeChunkCache();
  }
}

// ── fixtures ────────────────────────────────────────────────────────

function descriptor(overrides: Partial<LuaModuleDescriptor> = {}): LuaModuleDescriptor {
  return {
    id: 'a'.repeat(32),
    name: 'FakeModule',
    rootURL: 'https://fake.example',
    category: 'English',
    accountSupport: false,
    options: [],
    eventHandlers: {},
    sourceFile: 'FakeModule.lua',
    ...overrides,
  };
}

function registration(overrides: Partial<RegistrationRecord> = {}): RegistrationRecord {
  return {
    id: 'a'.repeat(32),
    name: 'FakeModule',
    rootURL: 'https://fake.example',
    category: 'English',
    accountSupport: false,
    options: [],
    file: 'FakeModule.lua',
    capabilities: {
      requires_subprocess: false,
      requires_browser: false,
      bypass_python_gated: false,
      requires_imagepuzzle: false,
      requires_mangafoxwatermark: false,
      events: [],
      known_broken_flags: [],
      live_scrape_fallback: false,
    },
    ...overrides,
  };
}

const MANGAINFO_ANSWERS: Readonly<Record<string, unknown>> = {
  'return MANGAINFO.URL': 'https://fake.example/manga/alpha/',
  'return MANGAINFO.Title': '  Alpha Manga  ',
  'return MANGAINFO.AltTitles': '',
  'return MANGAINFO.Authors': 'Author A',
  'return MANGAINFO.Artists': '',
  'return MANGAINFO.Genres': 'Action',
  'return MANGAINFO.Status': 'Ongoing',
  'return MANGAINFO.Summary': ' A summary ',
  'return MANGAINFO.CoverLink': 'https://fake.example/cover.jpg',
  'return MANGAINFO.Link': 'https://fake.example/manga/alpha/',
  'return MANGAINFO.ChapterLinks.Count': 1,
  'return MANGAINFO.ChapterLinks[0]': 'https://fake.example/manga/alpha/chapter/1',
  'return MANGAINFO.ChapterNames[0]': 'Chapter 1',
};

function fakeEnv(script: FakeHostScript): {
  factory: FakeLuaHostFactory;
  resolver: RecordedResponseResolver;
  transport: RecordedHttpTransport;
  egress: EgressPolicy;
} {
  const resolver = new RecordedResponseResolver([]);
  return {
    factory: new FakeLuaHostFactory(script),
    resolver,
    transport: new RecordedHttpTransport((m, u, b, mt, h) => resolver.resolve(m, u, b, mt, h)),
    egress: new EgressPolicy({ allow: ['fake.example'] }),
  };
}

// ── the proof ───────────────────────────────────────────────────────

describe('Lua host injection — runtime services run on a substituted LuaHost double', (): void => {
  it('EngineInfoService: GetInfo flows through the double; §5.8 reads via the contract engine', async (): Promise<void> => {
    const luaRoot = mkdtempSync(join(tmpdir(), 'fmd-inject-info-'));
    try {
      mkdirSync(join(luaRoot, 'modules'));
      writeFileSync(join(luaRoot, 'modules', 'FakeModule.lua'), '-- double-served module\n');
      const env = fakeEnv({
        loadFile: (): readonly LuaModuleDescriptor[] => [
          descriptor({ id: 'f'.repeat(32), name: 'InfoFake' }),
        ],
        engineAnswers: MANGAINFO_ANSWERS,
      });
      const service = new EngineInfoService({
        luaRoot,
        hostFactory: env.factory,
        modules: (): readonly RegistrationRecord[] => [registration({ id: 'f'.repeat(32) })],
        transport: env.transport,
        egress: env.egress,
      });

      const info = await service.getInfo('f'.repeat(32), 'https://fake.example/manga/alpha');

      // the double's host/engines were driven through the contract surface
      expect(env.factory.hosts).toHaveLength(1);
      const host = env.factory.hosts[0] as FakeLuaHost;
      expect(host.registry.registered.map((m): string => m.name)).toEqual(['InfoFake']);
      expect(host.engines).toHaveLength(1);
      const engine = host.engines[0] as FakeLuaEngine;
      expect(engine.loadedFiles).toEqual(['modules/FakeModule.lua']);
      // §5.8 post-processing ran over the double's doStringSync read-backs
      // (chapter links carry the uData host-strip — the REAL pipeline
      // applied to the double's output, proving the seam end-to-end)
      expect(info.title).toBe('Alpha Manga');
      expect(info.summary).toBe('A summary');
      expect(info.coverLink).toBe('https://fake.example/cover.jpg');
      expect(info.chapterLinks).toEqual(['/manga/alpha/chapter/1']);
      expect(info.chapterNames).toEqual(['Chapter 1']);
      expect(info.numChapter).toBe(1);
      // the §5.4 dispatcher shims (makeHTTP) crossed the contract seam
      expect(typeof host.lastShims?.makeHTTP).toBe('function');
      // per-call host + engine disposed exactly once
      expect(host.disposed).toBe(1);
      expect(engine.disposed).toBe(1);
    } finally {
      rmSync(luaRoot, { recursive: true, force: true });
    }
  });

  it('EngineLoginDriver: OnLogin dispatch + MODULE.Account read-back through the double', async (): Promise<void> => {
    const luaRoot = mkdtempSync(join(tmpdir(), 'fmd-inject-login-'));
    try {
      mkdirSync(join(luaRoot, 'modules'));
      writeFileSync(join(luaRoot, 'modules', 'FakeLogin.lua'), '-- double-served login module\n');
      const env = fakeEnv({
        loadFile: (): readonly LuaModuleDescriptor[] => [
          descriptor({
            id: 'e'.repeat(32),
            name: 'LoginFake',
            accountSupport: true,
            eventHandlers: { Login: 'DoLogin' },
          }),
        ],
        engineAnswers: {
          'return MODULE.Account.Status': 2,
          'return MODULE.Account.Cookies': 'sid=fake-session',
        },
        dispatch: (): EventDispatchResult => ({ kind: 'boolean', value: true }),
      });
      const driver = new EngineLoginDriver({
        luaRoot,
        hostFactory: env.factory,
        modules: (): readonly RegistrationRecord[] => [
          registration({ id: 'e'.repeat(32), file: 'FakeLogin.lua', accountSupport: true }),
        ],
        transport: env.transport,
        egress: env.egress,
      });

      const outcome = await driver.login('e'.repeat(32), {
        enabled: true,
        username: 'user',
        password: 'pass',
      });

      expect(outcome.status).toBe(2); // asValid — read back through the double
      expect(outcome.cookies).toBe('sid=fake-session');
      // the §5.2 account seed crossed the contract dispatcher shims
      const host = env.factory.hosts[0] as FakeLuaHost;
      expect(host.dispatchers[0]?.dispatchedEvents).toEqual(['Login:LoginFake']);
      expect(host.lastShims?.account).toMatchObject({ username: 'user', enabled: true });
      await driver.dispose();
    } finally {
      rmSync(luaRoot, { recursive: true, force: true });
    }
  });

  it('ModuleSyncService sweep: per-file isolation over the registry double', async (): Promise<void> => {
    const luaRoot = mkdtempSync(join(tmpdir(), 'fmd-inject-sweep-'));
    try {
      mkdirSync(join(luaRoot, 'modules'));
      writeFileSync(join(luaRoot, 'modules', 'good.lua'), 'local m = {} function m.Init() end return m');
      writeFileSync(join(luaRoot, 'modules', 'bad.lua'), 'function broken(');
      const factory = new FakeLuaHostFactory({
        loadFile: (
          fileName: string,
          _source: string,
          logger: HostLogger,
        ): readonly LuaModuleDescriptor[] => {
          if (fileName === 'bad.lua') {
            logger.write({
              level: 'error',
              moduleId: '',
              message: 'LUA>DoInit("bad.lua")> attempt to call a nil value',
            });
            return [];
          }
          return [descriptor({ id: 'd'.repeat(32), name: `Swept ${fileName}` })];
        },
      });
      const sync = new ModuleSyncService({ luaRoot, hostFactory: factory });

      const result = await sync.sweep();

      expect(result.summary.totalFiles).toBe(2);
      expect(result.summary.registeredFiles).toBe(1);
      expect(result.summary.failedFiles).toBe(1);
      expect(result.summary.failures).toEqual([
        { file: 'bad.lua', error: 'attempt to call a nil value' },
      ]);
      expect(result.registrations.map((r): string => r.name)).toEqual(['Swept good.lua']);
      // the sweep's host was created + disposed through the factory seam
      expect(factory.hosts).toHaveLength(1);
      expect((factory.hosts[0] as FakeLuaHost).disposed).toBe(1);
    } finally {
      rmSync(luaRoot, { recursive: true, force: true });
    }
  });
});
