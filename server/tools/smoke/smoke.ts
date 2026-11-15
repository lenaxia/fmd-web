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
import type { EgressPolicy } from '../../src/engine/shims/http-egress.js';
import { loadSeedManifest } from '@fmd/corpus/corpus-loader';
import type { SeedModuleRef } from './rotation.js';

/** Failure taxonomy of the smoke report (per-event classification). */
export type SmokeClassification =
  | 'pass'
  | 'transport'
  | 'http'
  | 'dispatch'
  | 'setup'
  | 'host-error'
  | 'skip:account-gated';

/** One dispatched-event outcome inside a module's smoke run. */
export interface SmokeEventResult {
  readonly event: string;
  readonly url: string;
  readonly status: 'pass' | 'fail';
  readonly classification: SmokeClassification;
  /** NetStatusCode on pass (0 = no_error); the code value on http fails. */
  readonly resultCode: number;
  /** Wall clock of the dispatch itself (ms) — the latency signal. */
  readonly latencyMs: number;
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

/**
 * Classify one dispatched GetInfo as a smoke pass/fail. Transport
 * failures (the resolver observed a status-0 curl response during the
 * dispatch window) are distinguished from plain HTTP failures so the
 * report separates "site unreachable" from "site answered, module
 * failed".
 */
function classifyGetInfo(
  url: string,
  dispatch: () => unknown,
  readLua: (code: string) => unknown,
  errorCountBefore: number,
  errorCountAfter: () => number,
  transportFailuresDelta: () => number,
): SmokeEventResult {
  const startedAt = Date.now();
  let result: unknown;
  try {
    result = dispatch();
  } catch (err) {
    return {
      event: 'GetInfo',
      url,
      status: 'fail',
      classification: 'dispatch',
      resultCode: 0,
      latencyMs: Date.now() - startedAt,
      detail: `dispatch threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const latencyMs = Date.now() - startedAt;
  const failure = ((): { detail: string; resultCode: number } | undefined => {
    if (typeof result === 'object' && result !== null && 'kind' in result) {
      const r = result as { kind: string; value?: unknown; reason?: string };
      if (r.kind === 'failed') {
        return { detail: r.reason ?? 'failed (no reason)', resultCode: 0 };
      }
      if (r.kind === 'code' && r.value !== 0) {
        return { detail: `net status ${String(r.value)} (non-zero)`, resultCode: Number(r.value) };
      }
      if (r.kind !== 'code') {
        return { detail: `unexpected dispatch result kind: ${r.kind}`, resultCode: 0 };
      }
      return undefined;
    }
    return { detail: `unexpected dispatch result: ${String(result)}`, resultCode: 0 };
  })();
  if (failure !== undefined) {
    const transport = transportFailuresDelta() > 0;
    return {
      event: 'GetInfo',
      url,
      status: 'fail',
      classification: transport ? 'transport' : 'http',
      resultCode: failure.resultCode,
      latencyMs,
      detail: transport ? `transport failure — ${failure.detail}` : failure.detail,
    };
  }
  if (errorCountAfter() > errorCountBefore) {
    return {
      event: 'GetInfo',
      url,
      status: 'fail',
      classification: 'host-error',
      resultCode: 0,
      latencyMs,
      detail: 'host error-level log record emitted during dispatch',
    };
  }
  const title = readLua('return MANGAINFO.Title');
  const links = readLua('return MANGAINFO.ChapterLinks.Count');
  return {
    event: 'GetInfo',
    url,
    status: 'pass',
    classification: 'pass',
    resultCode: 0,
    latencyMs,
    detail: `title="${String(title)}" chapters=${String(links)}`,
  };
}

/** Per-module run context (suite + rotation runners share this). */
export interface ModuleRunContext {
  readonly resolver: RecordedResponseResolver;
  /** Egress override — the mock cluster re-admits loopback (§5.4). */
  readonly egress?: EgressPolicy;
  /** Override the seed entry URL (suite sites carry their own URLs). */
  readonly urlOverride?: string;
  /**
   * Transport-failure counter probe (suite: PacedResolver's status-0
   * count) — classifies transport vs http failures. Rotation runs omit
   * it (probe absent ⇒ everything non-pass reads as http/other).
   */
  readonly transportFailures?: () => number;
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
    const result = await runModuleGetInfo(seed, luaRoot, {
      resolver: options.resolver,
      ...(options.urlOverride !== undefined ? { urlOverride: options.urlOverride } : {}),
    });
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

/**
 * One module's GetInfo smoke run: real Lua host + shims + contract
 * dispatcher over the caller's resolver. Exported for the heterogeneous
 * suite runner (live-suite.ts); the rotation path wraps it in
 * runSmokeModules. This function does NOT itself check the live gate —
 * the gate is the CLI's --live flag and the suite runner's options.
 */
export async function runModuleGetInfo(
  seed: ReturnType<typeof loadSeedManifest>,
  luaRoot: string,
  ctx: ModuleRunContext,
): Promise<SmokeModuleResult> {
  const startedAt = Date.now();
  const primary = seed.manifest.entries[0];
  const moduleFile = locateModuleFile(luaRoot, seed.manifest.module);
  const url = ctx.urlOverride ?? primary?.url ?? '';
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
          classification: 'setup',
          resultCode: 0,
          latencyMs: 0,
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

  // FMD2's interpreter runs with the lua tree as CWD; some modules
  // resolve sibling assets CWD-relative (e.g. MangaPlus's
  // `debug.getinfo`-derived MangaPlus.proto read in Init). Mirror that
  // for the run and restore afterwards (modules run sequentially).
  const previousCwd = process.cwd();
  process.chdir(luaRoot);
  try {
    return await runModuleGetInfoInner(seed, luaRoot, ctx, url, moduleFile, startedAt);
  } finally {
    process.chdir(previousCwd);
  }
}

async function runModuleGetInfoInner(
  seed: ReturnType<typeof loadSeedManifest>,
  luaRoot: string,
  ctx: ModuleRunContext,
  url: string,
  moduleFile: string,
  startedAt: number,
): Promise<SmokeModuleResult> {

  const logger = createMemoryLogger();
  const host = createLuaHost(logger);
  const abort = new DeadlineAbortHandle(createDeadlineCells());
  const hookOptions = {
    resolver: ctx.resolver,
    abort,
    logger,
    moduleId: moduleFile,
    luaRoot,
    ...(ctx.egress !== undefined ? { egress: ctx.egress } : {}),
  };
  const hook = initShimsHook(hookOptions);
  const transportFailures = ctx.transportFailures ?? (() => 0);
  const transportBefore = transportFailures();
  let event: SmokeEventResult;
  try {
    const descriptors = await loadRealModuleFile(host, luaRoot, moduleFile, hook);
    if (descriptors.length === 0) {
      // The Init error line sits in the host log — surface it so the
      // report is self-explanatory (e.g. a module reading a missing
      // sibling asset through the VM's io layer fails Init quietly).
      const initError = [...logger.records].reverse().find((r) => r.level === 'error');
      throw new Error(
        initError !== undefined
          ? `Init pass produced no module descriptor — last host error: ${initError.message}`
          : 'Init pass produced no module descriptor',
      );
    }
    const descriptor = descriptors[0];
    if (descriptor === undefined) {
      throw new Error('no module descriptor');
    }
    const engine = await host.createEngine();
    let makeHTTP: ((bridge: FacadeBridge) => FacadeSpec) | undefined;
    await engine.loadModule(moduleFile, (inner, bridge) => {
      const installed = installShims(inner, bridge, {
        resolver: ctx.resolver,
        abort,
        logger,
        moduleId: descriptor.id,
        luaRoot,
        ...(ctx.egress !== undefined ? { egress: ctx.egress } : {}),
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
      () => transportFailures() - transportBefore,
    );
    await engine.dispose();
  } catch (err) {
    event = {
      event: 'GetInfo',
      url,
      status: 'fail',
      classification: 'setup',
      resultCode: 0,
      latencyMs: Date.now() - startedAt,
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
