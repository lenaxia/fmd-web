/**
 * Smoke run core (DESIGN.md §13 nightly live smoke skeleton): opens one
 * real engine session per sampled seed module, dispatches its GetInfo
 * event through the contract dispatcher over LIVE network (the caller
 * must construct the live resolver), and classifies per-module
 * pass/fail. The per-module pass-rate JSON is the nightly artifact.
 *
 * Network gate: `runSmokeModules` REFUSES to run unless
 * `options.live === true` with a resolver — the CLI is the only place
 * that flag is accepted, and nothing in CI constructs it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryLogger } from '../../src/engine/lua/logger.js';
import { createLuaHost } from '../../src/engine/lua/host.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../src/engine/lua/abort.js';
import { createContractDispatcher } from '../../src/engine/events/dispatcher.js';
import type { FacadeBridge, FacadeSpec } from '../../src/engine/lua/facade.js';
import {
  installShims,
  initShimsHook,
  loadRealModuleFile,
  FMD2_LUA_ROOT,
} from '../../src/engine/shims/install.js';
import type { RecordedResponseResolver } from '../../src/engine/shims/http-shim.js';
import { loadSeedManifest } from '@fmd/corpus/corpus-loader';
import type { SeedModuleRef } from './rotation.js';

/** One dispatched-event outcome inside a module's smoke run. */
export interface SmokeEventResult {
  readonly event: string;
  readonly url: string;
  readonly status: 'pass' | 'fail';
  /** NetStatusCode on pass (0 = no_error); 0 also on transport failure. */
  readonly resultCode: number;
  /** Human detail: derived title on pass, first failure reason on fail. */
  readonly detail: string;
}

/** Per-module smoke outcome — the pass-rate unit of the report. */
export interface SmokeModuleResult {
  readonly module: string;
  readonly moduleFile: string;
  readonly moduleId: string;
  readonly url: string;
  readonly events: readonly SmokeEventResult[];
  readonly passRate: number;
  readonly durationMs: number;
}

/** Top-level nightly report (the JSON artifact). */
export interface SmokeReport {
  readonly generatedAt: string;
  readonly live: boolean;
  readonly rotationIndex: number;
  readonly sampleSize: number;
  readonly seedTotal: number;
  readonly moduleResults: readonly SmokeModuleResult[];
  /** Aggregate over every dispatched event. */
  readonly passRate: number;
}

export interface SmokeRunOptions {
  /** Must be explicitly true — the network gate. */
  readonly live: true;
  readonly resolver: RecordedResponseResolver;
  readonly luaRoot?: string;
  /** Override every module's seed entry URL (single-module verification use). */
  readonly urlOverride?: string;
}

/** Locate the module's Lua file (modules/ then templates/). */
export function locateModuleFile(luaRoot: string, name: string): string | undefined {
  for (const dir of ['modules', 'templates']) {
    const candidate = join(luaRoot, dir, `${name}.lua`);
    if (existsSync(candidate)) {
      return `${dir}/${name}.lua`;
    }
  }
  return undefined;
}

/** Classify one dispatched GetInfo as a smoke pass/fail. */
function classifyGetInfo(
  url: string,
  dispatch: () => unknown,
  readLua: (code: string) => unknown,
  errorCountBefore: number,
  errorCountAfter: () => number,
): SmokeEventResult {
  let result: unknown;
  try {
    result = dispatch();
  } catch (err) {
    return {
      event: 'GetInfo',
      url,
      status: 'fail',
      resultCode: 0,
      detail: `dispatch threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const failure = ((): string | undefined => {
    if (typeof result === 'object' && result !== null && 'kind' in result) {
      const r = result as { kind: string; value?: unknown; reason?: string };
      if (r.kind === 'failed') {
        return r.reason ?? 'failed (no reason)';
      }
      if (r.kind === 'code' && r.value !== 0) {
        return `net status ${String(r.value)} (non-zero)`;
      }
      if (r.kind !== 'code') {
        return `unexpected dispatch result kind: ${r.kind}`;
      }
      return undefined;
    }
    return `unexpected dispatch result: ${String(result)}`;
  })();
  if (failure !== undefined) {
    return { event: 'GetInfo', url, status: 'fail', resultCode: 0, detail: failure };
  }
  if (errorCountAfter() > errorCountBefore) {
    return {
      event: 'GetInfo',
      url,
      status: 'fail',
      resultCode: 0,
      detail: 'host error-level log record emitted during dispatch',
    };
  }
  const title = readLua('return MANGAINFO.Title');
  const links = readLua('return MANGAINFO.ChapterLinks.Count');
  return {
    event: 'GetInfo',
    url,
    status: 'pass',
    resultCode: 0,
    detail: `title="${String(title)}" chapters=${String(links)}`,
  };
}

/**
 * Run GetInfo live for each sampled seed module. Rejects loudly unless
 * `live: true` and a resolver are supplied — the gate.
 */
export async function runSmokeModules(
  sample: readonly SeedModuleRef[],
  options: SmokeRunOptions,
): Promise<SmokeReport> {
  if (options.live !== true || options.resolver === undefined) {
    throw new Error(
      'smoke runs are network-gated: construct with { live: true, resolver } from the --live CLI path only',
    );
  }
  const luaRoot = options.luaRoot ?? FMD2_LUA_ROOT;
  const moduleResults: SmokeModuleResult[] = [];
  let passed = 0;
  let total = 0;
  for (const ref of sample) {
    const seed = loadSeedManifest(ref.dir);
    const result = await runOneModule(seed, luaRoot, options.resolver, options.urlOverride);
    moduleResults.push(result);
    passed += result.events.filter((e) => e.status === 'pass').length;
    total += result.events.length;
  }
  return {
    generatedAt: new Date().toISOString(),
    live: true,
    rotationIndex: -1,
    sampleSize: sample.length,
    seedTotal: sample.length,
    moduleResults,
    passRate: total === 0 ? 0 : passed / total,
  };
}

async function runOneModule(
  seed: ReturnType<typeof loadSeedManifest>,
  luaRoot: string,
  resolver: RecordedResponseResolver,
  urlOverride?: string,
): Promise<SmokeModuleResult> {
  const startedAt = Date.now();
  const primary = seed.manifest.entries[0];
  const moduleFile = locateModuleFile(luaRoot, seed.manifest.module);
  const url = urlOverride ?? primary?.url ?? '';
  if (primary === undefined || moduleFile === undefined) {
    return {
      module: seed.manifest.module,
      moduleFile: moduleFile ?? '(not found)',
      moduleId: seed.manifest.moduleId,
      url,
      events: [
        {
          event: 'GetInfo',
          url,
          status: 'fail',
          resultCode: 0,
          detail:
            primary === undefined
              ? 'seed manifest has no entries'
              : `module file not found under ${luaRoot}`,
        },
      ],
      passRate: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const logger = createMemoryLogger();
  const host = createLuaHost(logger);
  const abort = new DeadlineAbortHandle(createDeadlineCells());
  const hook = initShimsHook({ resolver, abort, logger, moduleId: moduleFile, luaRoot });
  let event: SmokeEventResult;
  try {
    const descriptors = await loadRealModuleFile(host, luaRoot, moduleFile, hook);
    if (descriptors.length === 0) {
      throw new Error('Init pass produced no module descriptor');
    }
    const descriptor = descriptors[0];
    if (descriptor === undefined) {
      throw new Error('no module descriptor');
    }
    const engine = await host.createEngine();
    let makeHTTP: ((bridge: FacadeBridge) => FacadeSpec) | undefined;
    await engine.loadModule(moduleFile, (inner, bridge) => {
      const installed = installShims(inner, bridge, {
        resolver,
        abort,
        logger,
        moduleId: descriptor.id,
        luaRoot,
      });
      makeHTTP = installed.makeHTTP;
    });
    if (makeHTTP === undefined) {
      throw new Error('shim install did not run');
    }
    const dispatcher = createContractDispatcher(engine, abort, logger, undefined, undefined, undefined, {
      makeHTTP,
    });
    const errorCountBefore = logger.records.filter((r) => r.level === 'error').length;
    event = classifyGetInfo(
      url,
      () => dispatcher.dispatch(descriptor, 'GetInfo', { url }),
      (code) => engine.innerEngine.doStringSync(code),
      errorCountBefore,
      () => logger.records.filter((r) => r.level === 'error').length,
    );
    await engine.dispose();
  } catch (err) {
    event = {
      event: 'GetInfo',
      url,
      status: 'fail',
      resultCode: 0,
      detail: `setup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  await host.dispose();
  return {
    module: seed.manifest.module,
    moduleFile,
    moduleId: seed.manifest.moduleId,
    url,
    events: [event],
    passRate: event.status === 'pass' ? 1 : 0,
    durationMs: Date.now() - startedAt,
  };
}
