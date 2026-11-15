import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LuaFactory, type LuaEngine as WasmoonEngine } from 'wasmoon';
import {
  AntiBotInterceptor,
  type AntiBotResponseView,
  type BypassContext,
  type BypassExecutor,
  type InterceptableRequest,
  type InterceptResult,
} from '../../../src/engine/state/antibot.js';
import { ModuleStateService, type ModuleSharedState } from '../../../src/engine/state/module-state.js';
import { createIdleEnvironment, installBaseEnvironment } from '../../../src/engine/lua/base-globals.js';
import { FacadeBridge, escapeLuaString } from '../../../src/engine/lua/facade.js';
import { createMemoryLogger, type MemoryLogger } from '../../../src/engine/lua/logger.js';
import { FMD2_LUA_ROOT, installShims, type InstalledShims } from '../../../src/engine/shims/install.js';
import {
  RecordedResponseResolver,
  makeHttpShim,
  type HttpDocument,
  type HttpShimHandle,
  type HttpShimOptions,
} from '../../../src/engine/shims/http-shim.js';
import { LoopbackHttpTransport } from '../../../src/engine/shims/http-transport.js';
import { EgressPolicy } from '../../../src/engine/shims/http-egress.js';
import type { BypassExecutorPort, BypassRequest, BypassSolution } from '../../../src/engine/sidecar/bypass-adapter.js';

/**
 * Antibot interceptor PIPELINE integration (audit bucket B, DESIGN.md
 * §12 Phase-0 bypass fixtures, §5.9, §13.1): the interceptor is driven
 * end-to-end OFFLINE against a local mock server that emits real
 * antibot signatures (corpus/fixtures/antibot/), with the REAL FMD2
 * bypass scripts (`checkantibot.lua` heuristic + `websitebypass.lua` →
 * `cloudflare.lua` bypass, require chain incl. `fmd.duktape` ExecJS,
 * `fmd.crypto.EncodeURLElement`, `utils.json`) executing inside a real
 * wasmoon engine through the v0 shim installer.
 *
 * NOT live Cloudflare capture (fragile, ToS-adjacent — the audited,
 * agreed level): the mock's challenge page, signature matrix and
 * FlareSolverr endpoints are deterministic fixtures derived from
 * FMD2's own Lua patterns (see corpus/fixtures/antibot/README.md).
 * The IUAM answer is VALIDATED by the mock against the constant the
 * challenge JS computes through Duktape.enc/dec — a broken duktape
 * shim fails the bypass, and the test.
 *
 * Pipeline coverage per test:
 * 1. detection — every checkantibot.lua:5-12 signature over real
 *    loopback responses read by the REAL Lua heuristic;
 * 2. IUAM pipeline — detect → serialize → single-flight → challenge JS
 *    via the duktape shim → cookies cleared-then-set + UA persisted →
 *    reload='false' means NO re-issue (script-owned flag);
 * 3. FlareSolverr pipeline — webdriver branch through the subprocess
 *    stub's LuaSubprocess.pas 4-value return → applyCookies
 *    (ClearCookiesStorage + UA) → Storage['reload']='true' → the
 *    interceptor re-issues the original request;
 * 4. concurrency — ≥8 parallel image downloads on ONE module during a
 *    bypass window: exactly one bypass execution, losers resolve while
 *    the bypass is still pending (timing assertion).
 */

// --- fixtures ----------------------------------------------------------------

const FIXTURE_DIR = '/workspace/fmd-web/corpus/fixtures/antibot';

interface AntibotManifest {
  readonly constants: {
    readonly challengeTokenB64: string;
    readonly challengeTokenPlain: string;
    readonly expectedAnswerFormula: string;
    readonly expectedAnswer: string;
    readonly expectedTimeoutMs: number;
    readonly cfClearanceValue: string;
    readonly anonCookie: string;
    readonly flaresolverrMsg: string;
    readonly flaresolverrUserAgent: string;
    readonly flaresolverrClearance: string;
    readonly reloadStrings: readonly string[];
    readonly iuamChallengeMediaPathPrefix: string;
    readonly reloadChallengeMediaPathPrefix: string;
  };
}

interface SignatureEntry {
  readonly fixtureId: string;
  readonly path: string;
  readonly status: number;
  readonly contentType: string;
  readonly server: string;
  readonly expectHit: boolean;
  readonly description: string;
}

const manifest = JSON.parse(readFileSync(`${FIXTURE_DIR}/manifest.json`, 'utf8')) as AntibotManifest;
const CONSTANTS = manifest.constants;
const challengeHtml = readFileSync(`${FIXTURE_DIR}/challenge-iuam.html`, 'utf8');
const challengeBlockHtml = readFileSync(`${FIXTURE_DIR}/challenge-block.html`, 'utf8');
const signaturePlan = JSON.parse(readFileSync(`${FIXTURE_DIR}/signature-plan.json`, 'utf8')) as {
  readonly signatureEntries: readonly SignatureEntry[];
};
const flaresolverrFixtures = JSON.parse(readFileSync(`${FIXTURE_DIR}/flaresolverr-endpoints.json`, 'utf8')) as {
  readonly health: { readonly msg: string };
  readonly solution: {
    readonly status: number;
    readonly userAgent: string;
    readonly cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  };
};
const configDefault = readFileSync(`${FIXTURE_DIR}/websitebypass-config-default.json`, 'utf8');
const configFlaresolverrTemplate = JSON.parse(
  readFileSync(`${FIXTURE_DIR}/websitebypass-config-flaresolverr.json`, 'utf8'),
) as { use_webdriver: boolean; debug: boolean; flaresolverr_port: number; testing: boolean; flaresolverr_ip: string };

/** The wasm MEMFS path `cloudflare.lua:load_config()` reads (literal backslashes). */
const CONFIG_MOUNT_PATH = 'lua\\websitebypass\\websitebypass_config.json';

// --- mock antibot server (worker thread: the Lua-facing request path is sync) --

const MOCK_SERVER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
const C = workerData.constants;
const reloadHits = new Map();
const captures = [];

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function route(req, res, body) {
  const path = req.url || '';
  const cookieHeader = String(req.headers.cookie ?? '');
  captures.push({
    method: req.method,
    path,
    cookie: cookieHeader,
    body,
    referer: String(req.headers.referer ?? ''),
    origin: String(req.headers.origin ?? ''),
  });
  const cookies = parseCookies(cookieHeader);

  // FlareSolverr health endpoint (cloudflare.lua probes GET / before its retry loop)
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', Server: 'flaresolverr' });
    res.end(JSON.stringify(workerData.flaresolverr.health));
    return;
  }

  // IUAM solve POST — validate the JS-computed answer through Duktape primitives
  if (req.method === 'POST' && path.startsWith('/cdn-cgi/l/chk_jschl')) {
    const pairs = {};
    for (const kv of body.split('&')) {
      const eq = kv.indexOf('=');
      if (eq > 0) {
        try {
          pairs[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1));
        } catch {
          pairs[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
    }
    const solved =
      pairs['jschl_answer'] === C.expectedAnswer &&
      typeof pairs['jschl_vc'] === 'string' && pairs['jschl_vc'] !== '' &&
      typeof pairs['pass'] === 'string' && pairs['pass'] !== '' &&
      typeof pairs['r'] === 'string' && pairs['r'] !== '';
    if (solved) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        Server: 'cloudflare',
        'Set-Cookie': 'cf_clearance=' + C.cfClearanceValue + '; Path=/',
      });
      res.end('<html><body>challenge cleared</body></html>');
    } else {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', Server: 'cloudflare' });
      res.end('Access denied. Your IP address has been banned.');
    }
    return;
  }

  // cleared media: content page; reload-prefixed paths show the interstitial
  // on the bypass's own re-request first (cloudflare.lua creatReloadStrings),
  // then content on the interceptor's reload re-issue
  if (req.method === 'GET' && path.startsWith('/media/') && cookies['cf_clearance']) {
    if (path.startsWith(C.reloadChallengeMediaPathPrefix)) {
      const hits = (reloadHits.get(path) ?? 0) + 1;
      reloadHits.set(path, hits);
      if (hits === 1) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Server: 'cloudflare' });
        res.end('<html><head><title>' + C.reloadStrings[0] + '</title></head><body>' + C.reloadStrings[1] + '</body></html>');
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'image/png', Server: 'cloudflare' });
    res.end('PNGDATA-' + path);
    return;
  }

  // signature matrix (checkantibot.lua:5-12 shapes)
  const sig = workerData.signatureEntries.find((e) => e.path === path);
  if (req.method === 'GET' && sig !== undefined) {
    const headers = { 'Content-Type': sig.contentType };
    if (sig.server !== '') headers['Server'] = sig.server;
    res.writeHead(sig.status, headers);
    res.end('<html>signature response</html>');
    return;
  }

  // antibot challenge pages: reload-prefixed paths get the webdriver-only
  // block page (NO jschl form — the FlareSolverr scenario must take ONLY the
  // webdriver branch); iuam-prefixed paths get the IUAM challenge (503)
  if (req.method === 'GET' && path.startsWith('/media/')) {
    if (path.startsWith(C.reloadChallengeMediaPathPrefix)) {
      res.writeHead(403, {
        'Content-Type': 'text/html; charset=utf-8',
        Server: 'cloudflare',
        'Set-Cookie': C.anonCookie + '; Path=/',
      });
      res.end(workerData.challengeBlockHtml);
      return;
    }
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      Server: 'cloudflare',
      'Set-Cookie': C.anonCookie + '; Path=/',
    });
    res.end(workerData.challengeHtml);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => route(req, res, Buffer.concat(chunks).toString('utf8')));
});
server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ type: 'listening', port: server.address().port });
});
parentPort.on('message', (msg) => {
  if (msg.type === 'captures') parentPort.postMessage({ type: 'captures', captures });
  else if (msg.type === 'close') {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }
});
`;

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly cookie: string;
  readonly body: string;
  readonly referer: string;
  readonly origin: string;
}

interface MockAntiBotServer {
  readonly origin: string;
  readonly port: number;
  captures(): Promise<CapturedRequest[]>;
  close(): Promise<void>;
}

async function startMockAntiBotServer(): Promise<MockAntiBotServer> {
  const worker = new Worker(MOCK_SERVER_SCRIPT, {
    eval: true,
    workerData: {
      constants: CONSTANTS,
      challengeHtml,
      challengeBlockHtml,
      signatureEntries: signaturePlan.signatureEntries,
      flaresolverr: flaresolverrFixtures,
    },
  });
  const port: number = await new Promise((resolve, reject) => {
    worker.on('message', (m: { type: string; port?: number }) => {
      if (m.type === 'listening' && m.port !== undefined) {
        resolve(m.port);
      }
    });
    worker.on('error', reject);
  });
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    captures: () =>
      new Promise((resolve, reject) => {
        const onMessage = (m: { type: string; captures?: CapturedRequest[] }): void => {
          if (m.type === 'captures') {
            worker.off('message', onMessage);
            resolve(m.captures ?? []);
          }
        };
        worker.on('message', onMessage);
        worker.on('error', reject);
        worker.postMessage({ type: 'captures' });
      }),
    close: () =>
      new Promise((resolve) => {
        worker.postMessage({ type: 'close' });
        worker.on('exit', () => resolve());
      }),
  };
}

// --- real-script engine harness ----------------------------------------------

interface ScenarioOptions {
  readonly module: ModuleSharedState;
  /** wasm MEMFS content for websitebypass_config.json (load_config's file). */
  readonly mountConfig: string;
  /** §5.11 sidecar port for fmd.subprocess (undefined = denied stub). */
  readonly sidecar?: BypassExecutorPort;
}

/**
 * One wasmoon engine carrying the REAL FMD2 websitebypass chunks in the
 * same global scope (LuaWebsiteBypass.pas loads checkantibot.lua +
 * websitebypass.lua side by side), the v0 shim installer (require chain,
 * TXQuery, Duktape-on-node:vm) and the request-scoped HTTP facade bound
 * to the engine's `HTTP` global — the FMD2 per-event binding shape.
 */
class BypassEngine {
  private constructor(
    private readonly wasmoon: WasmoonEngine,
    private readonly bridge: FacadeBridge,
    readonly kit: InstalledShims,
    readonly logger: MemoryLogger,
    private shimOptions: HttpShimOptions,
  ) {}

  static async create(options: ScenarioOptions, transport: LoopbackHttpTransport): Promise<BypassEngine> {
    const factory = new LuaFactory();
    await factory.mountFile(CONFIG_MOUNT_PATH, options.mountConfig);
    const wasmoon = await factory.createEngine();
    const bridge = new FacadeBridge(wasmoon);
    const logger = createMemoryLogger();
    const env = createIdleEnvironment(logger);
    installBaseEnvironment(wasmoon, bridge, () => env);
    const egress = new EgressPolicy({ allow: ['127.0.0.1'] });
    const resolver = new RecordedResponseResolver([]);
    const shimOptions: HttpShimOptions = {
      resolver,
      abort: env.abort,
      documents: new Map<number, HttpDocument>(),
      transport,
      egress,
      sharedCookies: options.module.cookies,
    };
    const kit = installShims(wasmoon, bridge, {
      resolver,
      abort: env.abort,
      logger,
      moduleId: 'antibot-pipeline-it',
      transport,
      egress,
      sharedCookies: options.module.cookies,
      ...(options.sidecar !== undefined ? { bypass: options.sidecar } : {}),
    });
    // installShims owns the document map (CreateTXQuery resolution) —
    // makeHttpHandle() registers request documents into kit.documents.
    // Real FMD2 chunks — one shared global scope (FMD2 LuaWebsiteBypass.pas)
    wasmoon.doStringSync(readFileSync(`${FMD2_LUA_ROOT}/websitebypass/checkantibot.lua`, 'utf8'));
    wasmoon.doStringSync(readFileSync(`${FMD2_LUA_ROOT}/websitebypass/websitebypass.lua`, 'utf8'));
    return new BypassEngine(wasmoon, bridge, kit, logger, shimOptions);
  }

  /** A fresh request-scoped HTTP facade (the FULL handle, not just the spec). */
  makeHttpHandle(): HttpShimHandle {
    return makeHttpShim(this.bridge, { ...this.shimOptions, documents: this.kit.documents });
  }

  /** Rebind the engine's HTTP global to a request-scoped facade object. */
  bindHttp(handle: HttpShimHandle): void {
    this.bridge.create('HTTP', handle.spec);
  }

  /** Bind MODULE over the §5.3 shared state (cloudflare.lua touches Storage). */
  bindModule(module: ModuleSharedState): void {
    // re-point new request facades at THIS scenario's shared jar
    this.shimOptions = { ...this.shimOptions, sharedCookies: module.cookies };
    const storageId = this.bridge.create('', {
      get: (k) => (typeof k === 'string' ? module.storage.getOrEmpty(k) : undefined),
      set: (k, v) => {
        if (typeof k === 'string') {
          module.storage.set(k, v === null || v === undefined ? '' : String(v));
        }
      },
    });
    this.bridge.create('MODULE', {
      get: () => undefined,
      set: () => undefined,
      sub: (k) => (k === 'Storage' ? storageId : undefined),
    });
  }

  /** The REAL checkantibot.lua heuristic against the bound HTTP object. */
  checkAntiBotLua(): boolean {
    return this.wasmoon.doStringSync('return ____CheckAntiBot(HTTP)') === true;
  }

  /** The REAL ____WebsiteBypass dispatch (websitebypass.lua → cloudflare.lua). */
  websiteBypass(method: string, url: string): boolean {
    return (
      this.wasmoon.doStringSync(
        `return ____WebsiteBypass('${escapeLuaString(method)}', '${escapeLuaString(url)}')`,
      ) === true
    );
  }

  runLua(code: string): unknown {
    return this.wasmoon.doStringSync(code);
  }

  errorRecords(): number {
    return this.logger.records.filter((r) => r.level === 'error').length;
  }

  async dispose(): Promise<void> {
    this.wasmoon.global.close();
    this.bridge.dispose();
  }
}

/** InterceptableRequest over the REAL HTTP shim facade (loopback transport). */
class PipelineRequest implements InterceptableRequest {
  readonly handle: HttpShimHandle;
  terminated = false;
  resets = 0;
  executions = 0;

  constructor(
    private readonly engine: BypassEngine,
    readonly method: string,
    readonly url: string,
  ) {
    this.handle = engine.makeHttpHandle();
  }

  get userAgent(): string {
    return this.handle.pipeline.userAgent;
  }

  setAllowServerErrorResponse(value: boolean): void {
    this.handle.pipeline.allowServerErrorResponse = value;
  }

  reset(): void {
    this.resets += 1;
    (this.handle.spec.get('Reset') as () => void)();
  }

  view(): AntiBotResponseView {
    return {
      resultCode: this.handle.pipeline.resultCode,
      contentType: this.handle.headers.get('Content-Type'),
      server: this.handle.headers.get('Server'),
    };
  }

  async execute(): Promise<boolean> {
    this.engine.bindHttp(this.handle); // global HTTP := THIS object
    this.executions += 1;
    const lua =
      this.method === 'GET'
        ? `return HTTP.GET('${escapeLuaString(this.url)}')`
        : `return HTTP.Request('${escapeLuaString(this.method)}', '${escapeLuaString(this.url)}')`;
    return this.engine.runLua(lua) === true;
  }
}

/**
 * The §5.11 stub-profile executor: runs the REAL ____WebsiteBypass
 * dispatch in the engine. An open window holds the executor at its
 * entry (awaiting), which yields the thread — exactly the window the
 * concurrency test needs (losers proceed while the bypass is pending).
 */
class RealScriptBypassExecutor implements BypassExecutor {
  readonly entries: Array<{ host: string; url: string; settingsCookiesAtEntry: string }> = [];
  private releaseWindow: (() => void) | null = null;
  private windowPromise: Promise<void> | null = null;
  released = true;

  constructor(private readonly engine: BypassEngine) {}

  get available(): boolean {
    return true;
  }

  openWindow(): void {
    this.windowPromise = new Promise<void>((resolve) => {
      this.releaseWindow = resolve;
    });
    this.released = false;
  }

  closeWindow(): void {
    this.released = true;
    this.releaseWindow?.();
  }

  async bypass(ctx: BypassContext): Promise<boolean> {
    this.entries.push({
      host: ctx.host,
      url: ctx.url,
      settingsCookiesAtEntry: ctx.module.settings.snapshotSync().cookies,
    });
    if (this.windowPromise !== null) {
      await this.windowPromise;
    }
    this.engine.bindHttp((ctx.request as PipelineRequest).handle);
    return this.engine.websiteBypass(ctx.method, ctx.url);
  }
}

/** Fake §5.11 sidecar port (the stub-profile subprocess routes here). */
class FakeSidecarPort implements BypassExecutorPort {
  readonly solveCalls: string[] = [];

  constructor(private readonly solution: BypassSolution) {}

  async health(): Promise<boolean> {
    return true;
  }

  async solve(request: BypassRequest): Promise<BypassSolution> {
    this.solveCalls.push(request.url);
    return this.solution;
  }

  solveSync(request: BypassRequest): BypassSolution {
    this.solveCalls.push(request.url);
    return this.solution;
  }

  dispose(): void {
    void undefined;
  }
}

/** The interceptor wired to the REAL Lua heuristic (with depth telemetry). */
function makeRealScriptInterceptor(
  engine: BypassEngine,
): { interceptor: AntiBotInterceptor; maxObserved: () => number } {
  let inside = 0;
  let maxInside = 0;
  const interceptor = new AntiBotInterceptor({
    check: () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      try {
        return engine.checkAntiBotLua();
      } finally {
        inside -= 1;
      }
    },
  });
  return { interceptor, maxObserved: () => maxInside };
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- suite ---------------------------------------------------------------------

describe('antibot interceptor pipeline (real FMD2 bypass scripts, offline mock server)', () => {
  const transport = new LoopbackHttpTransport();
  let server: MockAntiBotServer;
  let engine: BypassEngine; // default config (use_webdriver=false) — IUAM + matrix + concurrency
  let flareEngine: BypassEngine; // flaresolverr config — webdriver reload scenario

  beforeAll(async () => {
    server = await startMockAntiBotServer();
  }, 30_000);

  afterAll(async () => {
    await Promise.all([engine?.dispose(), flareEngine?.dispose()]);
    transport.dispose();
    await server?.close();
  });

  async function freshModule(): Promise<{ service: ModuleStateService; module: ModuleSharedState }> {
    const service = new ModuleStateService();
    const module = await service.forModule('antibot-it');
    return { service, module };
  }

  function makeFlaresolverrSidecar(): FakeSidecarPort {
    return new FakeSidecarPort({
      url: `${server.origin}/media/reload-1.webp`,
      status: flaresolverrFixtures.solution.status,
      headers: {},
      body: '',
      cookies: flaresolverrFixtures.solution.cookies.map((c) => ({
        ...c,
        domain: '127.0.0.1',
        path: '/',
        expires: 1893456000,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      })),
      userAgent: flaresolverrFixtures.solution.userAgent,
    });
  }

  it('detects every checkantibot.lua:5-12 signature over real loopback responses (real Lua heuristic)', async () => {
    const { module } = await freshModule();
    engine = await BypassEngine.create({ module, mountConfig: configDefault }, transport);
    engine.bindModule(module);
    engine.bindHttp(engine.makeHttpHandle()); // heuristic reads the bound HTTP object
    const { interceptor, maxObserved } = makeRealScriptInterceptor(engine);

    for (const entry of signaturePlan.signatureEntries) {
      const request = new PipelineRequest(engine, 'GET', `${server.origin}${entry.path}`);
      const ok = await request.execute(); // real HTTP shim → loopback mock
      expect(ok, `${entry.fixtureId}: request succeeded`).toBe(true);
      expect(request.view().resultCode, entry.fixtureId).toBe(entry.status);
      const hit = await interceptor.checkAntiBotActive(request);
      expect(hit, `${entry.fixtureId}: ${entry.description}`).toBe(entry.expectHit);
    }

    // ONE global check at a time (serialized through the real script)
    expect(maxObserved()).toBe(1);
    expect(engine.errorRecords()).toBe(0);
  }, 30_000);

  it('intercept negative: a plain 403 (nginx) stays path=plain — the bypass scripts never run', async () => {
    const { module } = await freshModule();
    engine.bindModule(module);
    const executor = new RealScriptBypassExecutor(engine);
    const { interceptor } = makeRealScriptInterceptor(engine);
    const request = new PipelineRequest(engine, 'GET', `${server.origin}/sig/403-nginx-html`);

    const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });

    expect(outcome).toEqual({ result: true, antibotHit: false, path: 'plain' });
    expect(executor.entries).toHaveLength(0); // ____WebsiteBypass never ran
    expect(request.executions).toBe(1);
    expect(module.bypass.entries).toBe(0);
  }, 15_000);

  it('IUAM pipeline: detect → serialize → single-flight → challenge JS via duktape shim → cookies/UA persisted; reload=false keeps the single execution', async () => {
    const { module } = await freshModule();
    await module.settings.setCookies('stale=1'); // cleared-then-set probe (:177/:182)
    engine.bindModule(module);
    const executor = new RealScriptBypassExecutor(engine);
    const { interceptor, maxObserved } = makeRealScriptInterceptor(engine);
    const request = new PipelineRequest(engine, 'GET', `${server.origin}${CONSTANTS.iuamChallengeMediaPathPrefix}1.webp`);
    const before = request.handle.pipeline.userAgent;
    expect(before).not.toBe('');
    expect(request.handle.pipeline.allowServerErrorResponse).toBe(false); // caller had ASR off

    const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });

    expect(outcome).toEqual({ result: true, antibotHit: true, path: 'bypass' });
    // AllowServerErrorResponse forced on the REAL pipeline object (:156)
    expect(request.handle.pipeline.allowServerErrorResponse).toBe(true);
    // exactly ONE execution: the real script set Storage['reload']='false' → no re-issue
    expect(request.executions).toBe(1);
    expect(request.resets).toBe(0);
    expect(module.storage.get('reload')).toBe('false');
    // cookies cleared-then-set in module settings (:177 then :182) — the stale
    // settings cookie is gone, the bypass-obtained clearance persisted
    const settings = await module.settings.snapshot();
    expect(settings.cookies).not.toContain('stale=1');
    expect(settings.cookies).toContain(`cf_clearance=${CONSTANTS.cfClearanceValue}`);
    expect(settings.enabled).toBe(true); // (:181)
    // UA persisted (:183) — the request object's own agent
    expect(settings.userAgent).toBe(before);
    expect(module.bypass.entries).toBe(1);
    expect(executor.entries).toHaveLength(1);
    expect(executor.entries[0]!.host).toBe('127.0.0.1');
    expect(executor.entries[0]!.settingsCookiesAtEntry).toBe(''); // cleared BEFORE the bypass ran
    // the challenge answer was produced by ExecJS (Duktape.enc/dec) and
    // VALIDATED by the mock — a broken shim fails the bypass above
    const captures = await server.captures();
    const solve = captures.find((c) => c.method === 'POST');
    expect(solve).toBeDefined();
    expect(solve!.path).toBe('/cdn-cgi/l/chk_jschl?__cf_chl_jschl_tk__=tk520formtoken');
    expect(solve!.body).toContain('jschl_vc=vc-520');
    expect(solve!.body).toContain('pass=pass-520');
    expect(solve!.body).toContain('r=challenge-r-520');
    expect(solve!.body).toContain(`jschl_answer=${CONSTANTS.expectedAnswer.replace(/=/g, '%3D')}`);
    expect(solve!.origin).toContain(server.origin); // applyCookies' Origin header (leading space is OWS on the wire)
    // clean run: no SendError from the real scripts (challenge solved first try)
    expect(
      engine.errorRecords(),
      engine.logger.records.filter((r) => r.level === 'error').map((r) => r.message).join(' | '),
    ).toBe(0);
    expect(maxObserved()).toBe(1);
  }, 45_000);

  it('FlareSolverr pipeline: webdriver branch → applyCookies → Storage reload=true → the interceptor re-issues the original request', async () => {
    const { module } = await freshModule();
    await module.settings.setCookies('stale=1');
    const sidecar = makeFlaresolverrSidecar();
    const config = { ...configFlaresolverrTemplate, flaresolverr_port: server.port };
    flareEngine = await BypassEngine.create(
      { module, mountConfig: JSON.stringify(config), sidecar },
      transport,
    );
    flareEngine.bindModule(module);
    const executor = new RealScriptBypassExecutor(flareEngine);
    const { interceptor } = makeRealScriptInterceptor(flareEngine);
    const request = new PipelineRequest(
      flareEngine,
      'GET',
      `${server.origin}${CONSTANTS.reloadChallengeMediaPathPrefix}1.webp`,
    );

    const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });

    expect(outcome).toEqual({ result: true, antibotHit: true, path: 'bypass' });
    // the REAL cloudflare.lua reload branch ran: result==2 path set the flag
    expect(module.storage.get('reload')).toBe('true');
    // the interceptor re-issued the original request (:184-188)
    expect(request.resets).toBe(1); // Reset() before the re-issue (:186)
    expect(request.executions).toBe(2); // initial + re-issue
    expect(request.handle.pipeline.allowServerErrorResponse).toBe(true);
    expect(request.handle.pipeline.resultCode).toBe(200); // re-issue landed on content
    // sidecar-routed subprocess: exactly one solve — cloudflare.lua hands the
    // sidecar the ROOT url (url:match('(https?://[^/]+)'), cmd_[3]), not the path
    expect(sidecar.solveCalls).toEqual([server.origin]);
    // applyCookies cleared the jar (ClearCookiesStorage) then set the solved
    // cookie + UA; the interceptor persisted exactly that (:182-183)
    const settings = await module.settings.snapshot();
    expect(settings.cookies).toContain(`cf_clearance=${CONSTANTS.flaresolverrClearance}`);
    expect(settings.cookies).not.toContain('anon='); // challenge-page cookie wiped
    expect(settings.cookies).not.toContain('stale=1'); // stale settings cookie gone
    expect(settings.userAgent).toBe(CONSTANTS.flaresolverrUserAgent);
    // the wire saw the sequence: initial challenge → health → reload-check → re-issue
    const captures = await server.captures();
    const media = captures.filter((c) => c.path === `${CONSTANTS.reloadChallengeMediaPathPrefix}1.webp`);
    expect(media).toHaveLength(3);
    expect(media[0]!.cookie).not.toContain('cf_clearance'); // initial 503
    expect(media[1]!.cookie).toContain(`cf_clearance=${CONSTANTS.flaresolverrClearance}`); // bypass re-request
    expect(media[2]!.cookie).toContain(`cf_clearance=${CONSTANTS.flaresolverrClearance}`); // interceptor re-issue
    const health = captures.find((c) => c.path === '/');
    expect(health).toBeDefined(); // FlareSolverr health probe through the REAL HTTP shim
    expect(sidecar.solveCalls).toHaveLength(1);
  }, 45_000);

  it('≥8 parallel image downloads on ONE module during a bypass window: exactly one bypass, losers not delayed', async () => {
    const { module } = await freshModule();
    engine.bindModule(module);
    const executor = new RealScriptBypassExecutor(engine);
    executor.openWindow(); // the bypass window: held open until all losers resolved
    const { interceptor, maxObserved } = makeRealScriptInterceptor(engine);
    // the mock's capture log is cumulative across the suite — scope this
    // test's wire assertions to its own window
    const capturesBefore = (await server.captures()).length;

    interface WorkerRecord {
      outcome: InterceptResult | null;
      path: string;
      latencyMs: number;
      releasedWhenResolved: boolean;
    }
    // gate: exactly the 7 FALLTHROUGHS resolved their first intercept —
    // the winner's first intercept only resolves INSIDE the bypass
    // (after the window closes), so it must not join this gate
    const allFallthroughs = defer();
    let fallthroughCount = 0;
    const workers = Array.from({ length: 8 }, (_, i) => {
      const record: WorkerRecord = {
        outcome: null,
        path: '',
        latencyMs: 0,
        releasedWhenResolved: false,
      };
      const started = Date.now();
      const download = (async (): Promise<boolean> => {
        const request = new PipelineRequest(engine, 'GET', `${server.origin}${CONSTANTS.iuamChallengeMediaPathPrefix}c${String(i)}.webp`);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const outcome = await interceptor.intercept(request, module, { bypassExecutor: executor });
          if (record.outcome === null) {
            record.outcome = outcome;
            record.path = outcome.path;
            record.latencyMs = Date.now() - started;
            record.releasedWhenResolved = executor.released;
            if (outcome.path === 'fallthrough') {
              fallthroughCount += 1;
              if (fallthroughCount === 7) {
                allFallthroughs.resolve();
              }
            }
          }
          if (outcome.result) {
            return true;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        return false;
      })();
      return { record, download };
    });

    await waitFor(() => executor.entries.length === 1, 'the single bypass winner to enter');
    await allFallthroughs.promise; // the 7 losers proceeded, none waited
    expect(executor.released).toBe(false); // … while the bypass is STILL pending
    executor.closeWindow();

    const results = await Promise.all(workers.map((w) => w.download));
    expect(results).toEqual([true, true, true, true, true, true, true, true]);

    // losers' first intercepts resolved while the window was open: the
    // initial request + fallthrough re-issue round-trips completed in
    // milliseconds — never serialized behind the (seconds-long) bypass
    const fallthroughs = workers.filter((w) => w.record.path === 'fallthrough');
    const winners = workers.filter((w) => w.record.path === 'bypass');
    expect(
      fallthroughs,
      `records: ${JSON.stringify(workers.map((w) => w.record))}`,
    ).toHaveLength(7);
    expect(
      winners,
      `records: ${JSON.stringify(workers.map((w) => w.record))}`,
    ).toHaveLength(1);
    for (const loser of fallthroughs) {
      // released=false at resolution time = the bypass was STILL pending
      // when this loser's first intercept completed — it never waited behind it
      expect(
        !loser.record.releasedWhenResolved,
        `record: ${JSON.stringify(loser.record)}`,
      ).toBe(true);
      expect(loser.record.latencyMs).toBeLessThan(1500);
    }

    // exactly ONE bypass execution for all 8 workers
    expect(executor.entries).toHaveLength(1);
    expect(module.bypass.entries).toBe(1);
    const captures = (await server.captures()).slice(capturesBefore);
    const solves = captures.filter((c) => c.method === 'POST' && c.path.startsWith('/cdn-cgi/l/chk_jschl'));
    expect(solves).toHaveLength(1); // exactly one IUAM solve on the wire
    // global check serialization held under 8 concurrent workers (real heuristic)
    expect(maxObserved()).toBe(1);
    // shared clearance: every worker's subsequent plain request succeeded with it
    const jar = module.cookies.snapshotSync();
    expect(jar.entries['cf_clearance']).toBe(CONSTANTS.cfClearanceValue);
    expect(module.storage.get('reload')).toBe('false'); // IUAM never re-issues
    expect(engine.errorRecords()).toBe(0);
  }, 60_000);
});
