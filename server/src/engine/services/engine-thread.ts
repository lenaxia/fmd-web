/**
 * ENGINE THREAD — main side (§5.12 interim topology).
 *
 * Root cause this file fixes: the wasmoon engine ran on the server's
 * MAIN event-loop thread, and every module HTTP hop blocks its calling
 * thread inside `LoopbackHttpTransport.send()` (chunked `Atomics.wait`
 * — by design, for a blocked WORKER thread). One silent/slow origin
 * therefore froze the ENTIRE server for up to the 15 s hop timeout:
 * the Downloads page sat on "Loading jobs…" while a chapter's
 * GetPageNumber/GetImageURL dispatches hung, and /readyz stalled with
 * it (a lockup, not a crash — the loop resumed the moment the hop
 * timed out).
 *
 * `EngineThread` owns ONE persistent worker thread that hosts the real
 * engine (see engine-thread-worker.ts). The offloaded services below
 * keep the exact `ModuleInfoPort` / `ModuleDownloadHooks` contracts the
 * assembly and the download lane already consume, so the only
 * behavioral change is WHERE the blocking wait happens — a worker
 * thread, where it belongs.
 *
 * Marshaling discipline (per operation):
 * - registry rows, proxies, timeouts: plain config, re-read live from
 *   the main-thread closures (`modules()`, `proxyFor`) every op;
 * - §5.3 shared cookie jar: snapshot seeded into the worker BEFORE the
 *   dispatch, marshaled back and merged into the real module-state jar
 *   AFTER it (persistence stays main-thread owned);
 * - engine log records: collected worker-side, forwarded to the real
 *   `logSink` after every op;
 * - `ApiError`s: serialized `{status, code, message}` and rehydrated
 *   main-side so the API envelope is byte-identical.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { HostLogRecord, NormalizedInfo } from '@fmd/contract';
import { ApiError } from '@fmd/contract';
import type { ModuleDownloadHooks } from './download-hooks.js';
import type { ModuleInfoPort, EngineInfoOptions } from './module-info.js';
import type { EngineDownloadOptions } from './download-hooks.js';
import type { TaskWriter } from './download-ports.js';
import type { ModuleRuntime } from './module-runtime.js';
import type { ModuleSharedState } from '../state/module-state.js';
import type {
  SerializedError,
  TaskSnapshot,
} from './engine-thread-worker.js';

/** Plain per-operation dependency payload (worker constructs the rest). */
export interface EngineThreadRequestDeps {
  readonly luaRoot: string;
  readonly modules: unknown;
  readonly allowedHosts: readonly string[];
  readonly ca?: readonly string[];
  readonly tlsVerify?: boolean;
  readonly egressAllow: readonly string[];
  readonly bypassUrl?: string;
  readonly cookies: ReadonlyArray<readonly [string, string]>;
  readonly proxy?: unknown;
}

interface ThreadResponse {
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

/** Worker bootstrap: resolve-shim .js→.ts (source runs), then load the
 * worker module. Kept as an eval script exactly like the transport /
 * sidecar workers — no build-path coupling for the worker file itself. */
const ENGINE_WORKER_BOOTSTRAP = `
(async () => {
  const { parentPort, workerData } = await import('node:worker_threads');
  // Type-stripping runs .ts directly on node >= 23.6, but the TS sources
  // import siblings with .js suffixes (NodeNext convention) — remap the
  // missing ones so the SOURCE tree is loadable (vitest / dev); compiled
  // dist paths resolve natively and never hit the fallback.
  const mod = await import('node:module');
  if (typeof mod.registerHooks === 'function') {
    mod.registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (typeof specifier === 'string' && specifier.endsWith('.js')) {
            return nextResolve(specifier.slice(0, -3) + '.ts', context);
          }
          throw error;
        }
      },
    });
  }
  const entry = await import(workerData.workerModule);
  entry.startEngineWorkerThread(parentPort);
})().catch((error) => {
  console.error('[engine-thread] bootstrap failed:', error);
  process.exit(1);
});
`;

function resolveWorkerModuleUrl(): string {
  const compiled = new URL('./engine-thread-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(compiled))) {
    return compiled.href;
  }
  // Repo-layout build fallback: running from server/src (vitest) with a
  // compiled server/dist tree present. The SOURCE tree cannot load in a
  // raw worker under node type-stripping (parameter properties are
  // emit-only syntax), so the compiled sibling is the faithful stand-in
  // — same sources, built by `tsc -b` (the dev/preview flow builds
  // before running anyway).
  const self = import.meta.url;
  const srcAt = self.indexOf('/src/');
  if (srcAt !== -1 && self.indexOf('/dist/src/') === -1) {
    const distWorker = new URL(
      './engine-thread-worker.js',
      `${self.slice(0, srcAt)}/dist/src/engine/services/engine-thread.js`,
    );
    if (existsSync(fileURLToPath(distWorker))) {
      return distWorker.href;
    }
  }
  return new URL('./engine-thread-worker.ts', import.meta.url).href;
}

/** Rehydrate a worker-side failure into the same throwable shape the
 * in-process services raised (`ApiError` envelope preserved). */
function rehydrateError(error: SerializedError): Error {
  if (error.api !== undefined) {
    return new ApiError(error.api.status, error.api.code as ApiError['code'], error.api.message);
  }
  return new Error(error.message);
}

export class EngineThread {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (response: ThreadResponse) => void;
    reject: (cause: Error) => void;
  }>();
  private disposed = false;

  public readonly options: {
    readonly allowedHosts: readonly string[];
    readonly egressAllow: readonly string[];
    readonly ca?: readonly string[];
    readonly tlsVerify?: boolean;
    readonly bypassUrl?: string;
    readonly workerModuleUrl?: string;
  };

  public constructor(options: EngineThread['options']) {
    this.options = options;
  }

  /** Fire one RPC op; the worker answers with a single response. */
  public call(op: string, payload: Record<string, unknown> = {}): Promise<ThreadResponse> {
    if (this.disposed) {
      return Promise.reject(new Error('engine thread disposed'));
    }
    const worker = this.ensureWorker();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<ThreadResponse>((resolve, reject): void => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, ...payload });
    });
  }

  public dispose(): void {
    this.disposed = true;
    for (const [, entry] of this.pending) {
      entry.reject(new Error('engine thread disposed'));
    }
    this.pending.clear();
    if (this.worker !== null) {
      void this.worker.terminate();
      this.worker = null;
    }
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) {
      return this.worker;
    }
    const worker = new Worker(ENGINE_WORKER_BOOTSTRAP, {
      eval: true,
      workerData: {
        workerModule: this.options.workerModuleUrl ?? resolveWorkerModuleUrl(),
      },
    });
    worker.on('message', (message: ThreadResponse): void => {
      const entry = this.pending.get(message.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(message.id);
      entry.resolve(message);
    });
    // Resilience (the transport-worker pattern): a dead worker fails
    // its pending RPCs and is FORGOTTEN — the next op respawns fresh.
    const failAll = (why: string): void => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`engine thread died: ${why}`));
      }
      this.pending.clear();
      if (this.worker === worker) {
        this.worker = null;
      }
    };
    worker.on('error', (error: Error): void => {
      failAll(error.message);
    });
    worker.on('exit', (code: number): void => {
      if (code !== 0) {
        failAll(`exit code ${String(code)}`);
      } else if (this.worker === worker) {
        this.worker = null;
      }
    });
    this.worker = worker;
    return worker;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Offloaded services (the ModuleRuntime seams the assembly consumes)
// ─────────────────────────────────────────────────────────────────────

function jarPairsOf(state: ModuleSharedState | undefined): Array<[string, string]> {
  if (state === undefined) {
    return [];
  }
  const snapshot = state.cookies.snapshotSync();
  return Object.entries(snapshot.entries);
}

function forwardRecords(
  logSink: ((record: HostLogRecord) => void) | undefined,
  records: readonly HostLogRecord[] | undefined,
): void {
  if (logSink === undefined || records === undefined) {
    return;
  }
  for (const record of records) {
    logSink(record);
  }
}

async function mergeJarBack(
  moduleState: ((moduleId: string) => Promise<ModuleSharedState>) | undefined,
  moduleId: string,
  cookies: ReadonlyArray<readonly [string, string]> | undefined,
): Promise<void> {
  if (moduleState === undefined || cookies === undefined || cookies.length === 0) {
    return;
  }
  const state = await moduleState(moduleId);
  state.cookies.mergeEntries(cookies as Array<[string, string]>);
  await state.persist();
}

/** The §5.8 info port, executed on the engine thread. */
export class OffloadedInfoService implements ModuleInfoPort {
  public constructor(
    private readonly options: EngineInfoOptions,
    private readonly thread: EngineThread,
    private readonly threadOptions: {
      readonly allowedHosts: readonly string[];
      readonly egressAllow: readonly string[];
      readonly ca?: readonly string[];
      readonly tlsVerify?: boolean;
      readonly bypassUrl?: string;
    },
  ) {}

  public async getInfo(moduleId: string, url: string): Promise<NormalizedInfo> {
    const state = this.options.moduleState !== undefined
      ? await this.options.moduleState(moduleId)
      : undefined;
    const response = await this.thread.call('info.get', {
      moduleId,
      url,
      deps: {
        luaRoot: this.options.luaRoot,
        modules: this.options.modules(),
        allowedHosts: this.threadOptions.allowedHosts,
        ...(this.threadOptions.ca !== undefined ? { ca: this.threadOptions.ca } : {}),
        ...(this.threadOptions.tlsVerify !== undefined
          ? { tlsVerify: this.threadOptions.tlsVerify }
          : {}),
        egressAllow: this.threadOptions.egressAllow,
        ...(this.threadOptions.bypassUrl !== undefined
          ? { bypassUrl: this.threadOptions.bypassUrl }
          : {}),
        cookies: jarPairsOf(state),
        ...(this.options.proxyFor !== undefined
          ? { proxy: this.options.proxyFor(moduleId) ?? null }
          : {}),
      } satisfies EngineThreadRequestDeps,
    });
    forwardRecords(this.options.logSink, response.records);
    await mergeJarBack(this.options.moduleState, moduleId, response.cookies);
    if (!response.ok) {
      throw rehydrateError(
        response.error ?? { message: 'engine thread: info.get failed without an error envelope' },
      );
    }
    return response.info as never;
  }

  public async dispose(): Promise<void> {
    // The thread is process-owned (assembly drain disposes it).
  }
}

function snapshotWriter(task: TaskWriter): TaskSnapshot {
  return {
    pageLinks: [...task.pageLinks],
    pageContainerLinks: [...task.pageContainerLinks],
    fileNames: [...task.fileNames],
    pageNumber: task.pageNumber,
    link: task.link,
  };
}

function applyWriter(task: TaskWriter, snapshot: TaskSnapshot | undefined): void {
  if (snapshot === undefined) {
    return;
  }
  task.pageLinks.length = 0;
  task.pageLinks.push(...snapshot.pageLinks);
  task.pageContainerLinks.length = 0;
  task.pageContainerLinks.push(...snapshot.pageContainerLinks);
  task.fileNames.length = 0;
  task.fileNames.push(...snapshot.fileNames);
  task.pageNumber = snapshot.pageNumber;
}

/** One chapter's §5.2 hooks, executed on the engine thread (the
 * dispatcher/engine/shims live worker-side for the chapter's lifetime). */
class OffloadedDownloadHooks implements ModuleDownloadHooks {
  private sessionId: string | undefined;

  public constructor(
    sessionId: string | undefined,
    private readonly moduleId: string,
    private readonly options: EngineDownloadOptions,
    private readonly thread: EngineThread,
  ) {
    this.sessionId = sessionId;
  }

  public static async create(
    moduleId: string,
    options: EngineDownloadOptions,
    thread: EngineThread,
    threadOptions: {
      readonly allowedHosts: readonly string[];
      readonly egressAllow: readonly string[];
      readonly ca?: readonly string[];
      readonly tlsVerify?: boolean;
      readonly bypassUrl?: string;
    },
  ): Promise<OffloadedDownloadHooks> {
    const state = options.moduleState !== undefined
      ? await options.moduleState(moduleId)
      : undefined;
    const response = await thread.call('chapter.create', {
      moduleId,
      deps: {
        luaRoot: options.luaRoot,
        modules: options.modules(),
        allowedHosts: threadOptions.allowedHosts,
        ...(threadOptions.ca !== undefined ? { ca: threadOptions.ca } : {}),
        ...(threadOptions.tlsVerify !== undefined ? { tlsVerify: threadOptions.tlsVerify } : {}),
        egressAllow: threadOptions.egressAllow,
        ...(threadOptions.bypassUrl !== undefined ? { bypassUrl: threadOptions.bypassUrl } : {}),
        cookies: jarPairsOf(state),
        ...(options.proxyFor !== undefined ? { proxy: options.proxyFor(moduleId) ?? null } : {}),
      } satisfies EngineThreadRequestDeps,
    });
    forwardRecords(options.logSink, response.records);
    await mergeJarBack(options.moduleState, moduleId, response.cookies);
    if (!response.ok) {
      throw rehydrateError(
        response.error ?? { message: 'engine thread: chapter.create failed without an error envelope' },
      );
    }
    return new OffloadedDownloadHooks(response.sessionId, moduleId, options, thread);
  }

  public async taskStart(task: TaskWriter): Promise<boolean> {
    const value = await this.call('taskStart', task, {});
    return value === true;
  }

  public async getPageNumber(task: TaskWriter, url: string): Promise<boolean> {
    const value = await this.call('getPageNumber', task, { url });
    return value === true;
  }

  public async getImageURL(task: TaskWriter, workId: number, url: string): Promise<boolean> {
    const value = await this.call('getImageURL', task, { url, workId });
    return value === true;
  }

  public async beforeDownloadImage(
    workId: number,
    url: string,
  ): Promise<{ url?: string; headers?: Record<string, string> } | undefined> {
    return this.call('beforeDownloadImage', undefined, { url, workId }) as
      Promise<{ url?: string; headers?: Record<string, string> } | undefined>;
  }

  public async dispose(): Promise<void> {
    if (this.sessionId === undefined) {
      return;
    }
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    const response = await this.thread.call('chapter.dispose', { sessionId });
    forwardRecords(this.options.logSink, response.records);
    await mergeJarBack(this.options.moduleState, this.moduleId, response.cookies);
    if (!response.ok) {
      throw rehydrateError(
        response.error ?? { message: 'engine thread: chapter.dispose failed without an error envelope' },
      );
    }
  }

  private async call(
    method: 'taskStart' | 'getPageNumber' | 'getImageURL' | 'beforeDownloadImage',
    task: TaskWriter | undefined,
    args: { readonly url?: string; readonly workId?: number },
  ): Promise<unknown> {
    if (this.sessionId === undefined) {
      throw new Error('engine thread: chapter session already disposed');
    }
    const response = await this.thread.call('chapter.call', {
      sessionId: this.sessionId,
      method,
      ...(task !== undefined ? { task: snapshotWriter(task) } : {}),
      args,
    });
    if (task !== undefined) {
      applyWriter(task, response.task);
    }
    forwardRecords(this.options.logSink, response.records);
    await mergeJarBack(this.options.moduleState, this.moduleId, response.cookies);
    if (!response.ok) {
      throw rehydrateError(
        response.error ?? { message: `engine thread: ${method} failed without an error envelope` },
      );
    }
    return response.value;
  }
}

/**
 * Wrap a substrate so its INFO + DOWNLOAD seams execute on the engine
 * thread. The remaining seams (host factory for the registry sweep,
 * directory walker, login sessions) stay on the calling thread — they
 * are boot-time or user-triggered paths, not the downloads lane.
 */
export function offloadEngineSubstrate(delegate: ModuleRuntime, thread: EngineThread): ModuleRuntime {
  const threadOptions = {
    allowedHosts: thread.options.allowedHosts,
    egressAllow: thread.options.egressAllow,
    ...(thread.options.ca !== undefined ? { ca: thread.options.ca } : {}),
    ...(thread.options.tlsVerify !== undefined ? { tlsVerify: thread.options.tlsVerify } : {}),
    ...(thread.options.bypassUrl !== undefined ? { bypassUrl: thread.options.bypassUrl } : {}),
  };
  return {
    createHostFactory: delegate.createHostFactory,
    createSweep: delegate.createSweep,
    createDirectoryWalker: delegate.createDirectoryWalker,
    createLoginSession: delegate.createLoginSession,
    ...(delegate.initialModules !== undefined ? { initialModules: delegate.initialModules } : {}),
    createInfoService: (options): ModuleInfoPort =>
      new OffloadedInfoService(options, thread, threadOptions),
    createDownloadHooks: (moduleId, options): Promise<ModuleDownloadHooks> =>
      OffloadedDownloadHooks.create(moduleId, options, thread, threadOptions),
  };
}
