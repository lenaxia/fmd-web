/**
 * ENGINE THREAD — worker side (§5.12 interim topology).
 *
 * The wasmoon Lua engine runs IN-PROCESS on its host thread, and the
 * §5.4 HTTP transport port is SYNCHRONOUS by contract (the Lua facade
 * calls it from a blocked thread — `Atomics.wait` against the transport
 * pump worker). While the engine lived on the MAIN event-loop thread
 * that block froze the whole server: every module HTTP hop (GetInfo,
 * GetPageNumber, GetImageURL …) stalled Fastify for up to the hop
 * timeout (15 s against a silent origin — the Downloads-page lockup).
 *
 * This module is the engine-thread half of the fix: it runs INSIDE one
 * dedicated worker_threads Worker and hosts the real engine services
 * (`EngineInfoService`, `EngineDownloadHooks`) with worker-local
 * dependencies — a fresh `LoopbackHttpTransport` (its blocking `send`
 * is exactly what a non-main thread is FOR), a worker-local
 * `EgressPolicy`, and per-run cookie-jar replicas seeded from the main
 * thread. The main-thread half (`engine-thread.ts`) marshals plain
 * payloads across and merges the jar back into the §5.3 module-state
 * service after every operation.
 *
 * Message shape (both directions JSON-cloneable):
 *   → { id, op, …payload }
 *   ← { id, ok: true, …result } | { id, ok: false, error }
 * `records` (HostLogRecord[]) and `cookies` ([name, value][]) ride every
 * response so the main thread can forward logs and persist the jar.
 *
 * Ops are handled STRICTLY SERIALLY (a promise chain): one engine at a
 * time, mirroring the pre-thread serialization the main event loop
 * imposed anyway — while a hung hop blocks this worker, the server's
 * main loop stays free (the defect being fixed).
 */
import type { MessagePort } from 'node:worker_threads';
import type { HostLogRecord } from '@fmd/contract';
import { ApiError } from '@fmd/contract';
import { createModuleRuntime } from './module-runtime.js';
import { LoopbackHttpTransport } from '../shims/http-transport.js';
import { EgressPolicy } from '../shims/http-egress.js';
import { CookieJar } from '../shims/http-cookies.js';
import type { ProxyConfig } from '../shims/http-proxy.js';
import { FlareSolverrBypassExecutor } from '../sidecar/bypass-adapter.js';
import { EngineInfoService } from './module-info.js';
import { EngineDownloadHooks, type ModuleDownloadHooks } from './download-hooks.js';
import type { RegistrationRecord } from '../registry/capabilities.js';
import type { ModuleSharedState } from '../state/module-state.js';
import type { TaskWriter } from './download-ports.js';

/** Plain transport/egress configuration marshaled per operation. */
export interface EngineThreadDeps {
  readonly luaRoot: string;
  readonly modules: readonly RegistrationRecord[];
  readonly allowedHosts: readonly string[];
  readonly ca?: readonly string[];
  readonly tlsVerify?: boolean;
  readonly egressAllow: readonly string[];
  readonly bypassUrl?: string;
  /** §5.3 jar replica seed (main-thread snapshot). */
  readonly cookies: ReadonlyArray<readonly [string, string]>;
  /** Settings-resolved proxy for the run (plain config). */
  readonly proxy?: ProxyConfig;
}

interface ChapterSession {
  readonly hooks: ModuleDownloadHooks;
  readonly jar: CookieJar;
  readonly records: HostLogRecord[];
}

/** Serialized error envelope ({@link rehydrateError} main side). */
export interface SerializedError {
  readonly api?: { readonly status: number; readonly code: string; readonly message: string };
  readonly message: string;
}

interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly error?: SerializedError;
  readonly info?: unknown;
  readonly sessionId?: string;
  readonly value?: unknown;
  readonly task?: TaskSnapshot;
  readonly cookies?: ReadonlyArray<readonly [string, string]>;
  readonly records?: readonly HostLogRecord[];
}

/** The TaskWriter fields that cross the thread boundary. */
export interface TaskSnapshot {
  readonly pageLinks: string[];
  readonly pageContainerLinks: string[];
  readonly fileNames: string[];
  readonly pageNumber: number;
  readonly link: string;
}

export function serializeError(cause: unknown): SerializedError {
  if (cause instanceof ApiError) {
    return {
      api: { status: cause.status, code: cause.code, message: cause.message },
      message: cause.message,
    };
  }
  return { message: cause instanceof Error ? cause.message : String(cause) };
}

/** Worker-local dedup for swallowed expression WARNs (bounded set). */
class BoundedDeduper {
  private readonly seen = new Set<string>();
  public report(moduleId: string, template: string): boolean {
    const key = `${moduleId}|${template}`;
    if (this.seen.has(key)) {
      return false;
    }
    if (this.seen.size >= 512) {
      this.seen.clear();
    }
    this.seen.add(key);
    return true;
  }
}

/** One per-config cache for stateful worker-side resources. */
class ResourceCache<T> {
  private entry: { readonly key: string; readonly value: T } | undefined;

  public get(key: string, make: () => T, dispose?: (value: T) => void): T {
    if (this.entry !== undefined && this.entry.key === key) {
      return this.entry.value;
    }
    if (this.entry !== undefined && dispose !== undefined) {
      dispose(this.entry.value);
    }
    const value = make();
    this.entry = { key, value };
    return value;
  }

  public disposeAll(dispose?: (value: T) => void): void {
    if (this.entry !== undefined && dispose !== undefined) {
      dispose(this.entry.value);
    }
    this.entry = undefined;
  }
}

const transports = new ResourceCache<LoopbackHttpTransport>();
const bypasses = new ResourceCache<FlareSolverrBypassExecutor>();
const deduper = new BoundedDeduper();

function depsKey(deps: EngineThreadDeps): string {
  return JSON.stringify([deps.allowedHosts, deps.ca ?? [], deps.tlsVerify ?? null]);
}

function transportFor(deps: EngineThreadDeps): LoopbackHttpTransport {
  return transports.get(depsKey(deps), (): LoopbackHttpTransport => {
    const allowedHosts = [...deps.allowedHosts];
    return new LoopbackHttpTransport({
      allowedHosts,
      ...(deps.ca !== undefined && deps.ca.length > 0 ? { ca: [...deps.ca] } : {}),
      ...(deps.tlsVerify !== undefined ? { tlsVerify: deps.tlsVerify } : {}),
    });
  }, (t): void => { t.dispose(); });
}

function bypassFor(deps: EngineThreadDeps): FlareSolverrBypassExecutor | undefined {
  if (deps.bypassUrl === undefined || deps.bypassUrl === '') {
    return undefined;
  }
  return bypasses.get(deps.bypassUrl, (): FlareSolverrBypassExecutor =>
    new FlareSolverrBypassExecutor({ baseUrl: deps.bypassUrl as string }), (b): void => { b.dispose(); });
}

function jarFrom(cookies: ReadonlyArray<readonly [string, string]>): CookieJar {
  const jar = new CookieJar();
  for (const [name, value] of cookies) {
    jar.set(name, value);
  }
  return jar;
}

function jarPairs(jar: CookieJar): Array<[string, string]> {
  return jar.entries().map(([name, value]): [string, string] => [name, value]);
}

/** Structural §5.3 stand-in: only `.cookies` + `.persist()` are consumed
 * by the info/download services; persistence is owned by the MAIN
 * thread (it merges the marshaled jar back into the real service). */
function fakeSharedState(moduleId: string, jar: CookieJar): ModuleSharedState {
  return {
    moduleId,
    cookies: jar,
    persist: async (): Promise<void> => undefined,
  } as unknown as ModuleSharedState;
}

function snapshotOf(task: TaskWriter): TaskSnapshot {
  return {
    pageLinks: [...task.pageLinks],
    pageContainerLinks: [...task.pageContainerLinks],
    fileNames: [...task.fileNames],
    pageNumber: task.pageNumber,
    link: task.link,
  };
}

function writerFrom(snapshot: TaskSnapshot): TaskWriter {
  return {
    pageLinks: [...snapshot.pageLinks],
    pageContainerLinks: [...snapshot.pageContainerLinks],
    fileNames: [...snapshot.fileNames],
    pageNumber: snapshot.pageNumber,
    link: snapshot.link,
  };
}

let nextSessionId = 1;
const sessions = new Map<string, ChapterSession>();

/** The production substrate (the sanctioned host-factory door): the
 * worker-side engine services construct their hosts exactly like the
 * in-process ones did, through `createModuleRuntime()`. */
const workerSubstrate = createModuleRuntime();

async function runInfo(deps: EngineThreadDeps, moduleId: string, url: string): Promise<Partial<WorkerResponse>> {
  const records: HostLogRecord[] = [];
  const jar = jarFrom(deps.cookies);
  const transport = transportFor(deps);
  const bypass = bypassFor(deps);
  const service = new EngineInfoService({
    luaRoot: deps.luaRoot,
    modules: (): readonly RegistrationRecord[] => deps.modules,
    transport,
    egress: new EgressPolicy({ allow: [...deps.egressAllow] }),
    swallowDeduper: deduper,
    logSink: (record): void => {
      records.push(record);
    },
    ...(deps.proxy !== undefined ? { proxyFor: (): ProxyConfig | undefined => deps.proxy } : {}),
    ...(bypass !== undefined ? { bypass } : {}),
    moduleState: (): Promise<ModuleSharedState> => Promise.resolve(fakeSharedState(moduleId, jar)),
    hostFactory: workerSubstrate.createHostFactory(),
  });
  try {
    const info = await service.getInfo(moduleId, url);
    return { info, cookies: jarPairs(jar), records };
  } finally {
    await service.dispose();
  }
}

async function createChapterSession(deps: EngineThreadDeps, moduleId: string): Promise<Partial<WorkerResponse>> {
  const records: HostLogRecord[] = [];
  const jar = jarFrom(deps.cookies);
  const transport = transportFor(deps);
  const bypass = bypassFor(deps);
  const hooks = await EngineDownloadHooks.create(moduleId, {
    luaRoot: deps.luaRoot,
    modules: (): readonly RegistrationRecord[] => deps.modules,
    transport,
    egress: new EgressPolicy({ allow: [...deps.egressAllow] }),
    swallowDeduper: deduper,
    logSink: (record): void => {
      records.push(record);
    },
    ...(deps.proxy !== undefined ? { proxyFor: (): ProxyConfig | undefined => deps.proxy } : {}),
    ...(bypass !== undefined ? { bypass } : {}),
    moduleState: (): Promise<ModuleSharedState> => Promise.resolve(fakeSharedState(moduleId, jar)),
    hostFactory: workerSubstrate.createHostFactory(),
  });
  const sessionId = `s${String(nextSessionId)}`;
  nextSessionId += 1;
  sessions.set(sessionId, { hooks, jar, records });
  return { sessionId, cookies: jarPairs(jar), records };
}

async function callChapterSession(
  sessionId: string,
  method: 'taskStart' | 'getPageNumber' | 'getImageURL' | 'beforeDownloadImage',
  task: TaskSnapshot,
  args: { readonly url?: string; readonly workId?: number },
): Promise<Partial<WorkerResponse>> {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    throw new Error(`engine thread: unknown chapter session ${JSON.stringify(sessionId)}`);
  }
  const writer = writerFrom(task);
  let value: unknown;
  if (method === 'taskStart') {
    value = await session.hooks.taskStart?.(writer) ?? true;
  } else if (method === 'getPageNumber') {
    value = await session.hooks.getPageNumber(writer, args.url ?? '');
  } else if (method === 'getImageURL') {
    value = await session.hooks.getImageURL(writer, args.workId ?? 0, args.url ?? '');
  } else {
    value = await session.hooks.beforeDownloadImage?.(args.workId ?? 0, args.url ?? '');
  }
  return {
    value,
    task: snapshotOf(writer),
    cookies: jarPairs(session.jar),
    records: [...session.records.splice(0, session.records.length)],
  };
}

async function disposeChapterSession(sessionId: string): Promise<Partial<WorkerResponse>> {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    throw new Error(`engine thread: unknown chapter session ${JSON.stringify(sessionId)}`);
  }
  sessions.delete(sessionId);
  await session.hooks.dispose();
  return {
    cookies: jarPairs(session.jar),
    records: session.records.splice(0, session.records.length),
  };
}

interface EngineThreadRequest {
  readonly id: number;
  readonly op: string;
  readonly deps?: EngineThreadDeps;
  readonly moduleId?: string;
  readonly url?: string;
  readonly sessionId?: string;
  readonly method?: 'taskStart' | 'getPageNumber' | 'getImageURL' | 'beforeDownloadImage';
  readonly task?: TaskSnapshot;
  readonly args?: { readonly url?: string; readonly workId?: number };
}

/** Entry point invoked by the bootstrap script (see engine-thread.ts). */
export function startEngineWorkerThread(parentPort: MessagePort): void {
  let chain: Promise<void> = Promise.resolve();

  const handle = async (message: EngineThreadRequest): Promise<void> => {
    const reply = (body: Partial<WorkerResponse> & { readonly ok: boolean }): void => {
      parentPort.postMessage({ id: message.id, ...body });
    };
    try {
      switch (message.op) {
        case 'info.get': {
          if (message.deps === undefined || message.moduleId === undefined || message.url === undefined) {
            throw new Error('engine thread: malformed info.get request');
          }
          const result = await runInfo(message.deps, message.moduleId, message.url);
          reply({ ok: true, ...result });
          return;
        }
        case 'chapter.create': {
          if (message.deps === undefined || message.moduleId === undefined) {
            throw new Error('engine thread: malformed chapter.create request');
          }
          const result = await createChapterSession(message.deps, message.moduleId);
          reply({ ok: true, ...result });
          return;
        }
        case 'chapter.call': {
          if (message.sessionId === undefined || message.method === undefined || message.task === undefined) {
            throw new Error('engine thread: malformed chapter.call request');
          }
          const result = await callChapterSession(
            message.sessionId,
            message.method,
            message.task,
            message.args ?? {},
          );
          reply({ ok: true, ...result });
          return;
        }
        case 'chapter.dispose': {
          if (message.sessionId === undefined) {
            throw new Error('engine thread: malformed chapter.dispose request');
          }
          const result = await disposeChapterSession(message.sessionId);
          reply({ ok: true, ...result });
          return;
        }
        case 'ping': {
          reply({ ok: true });
          return;
        }
        default:
          throw new Error(`engine thread: unknown op ${JSON.stringify(message.op)}`);
      }
    } catch (cause: unknown) {
      reply({ ok: false, error: serializeError(cause) });
    }
  };

  parentPort.on('message', (message: EngineThreadRequest): void => {
    // STRICT serialization: one engine operation at a time (the same
    // discipline the single-threaded main loop imposed before).
    chain = chain.then((): Promise<void> => handle(message)).catch((): void => undefined);
  });
}
