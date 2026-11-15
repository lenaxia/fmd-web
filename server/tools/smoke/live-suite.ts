/**
 * Heterogeneous live-suite runner (DESIGN §12 Phase-1 + §13.2): runs
 * GetInfo through the real host + §5.4 shims against the fixed ≥10-site
 * heterogeneous list (sites.ts) with per-site 1 req/s pacing and a
 * fixed UA, and assembles the committed report artifact
 * (docs/live-smoke-report.json) — run timestamp, site list, per-module
 * pass/fail + latency + failure classification, D18 findings, and the
 * harness's own request-log invariants.
 *
 * Environments:
 * - `live`         — real network; requires the explicit live gate
 *                    (the CLI's --live flag feeds `live: true` here).
 * - `mock-cluster` — loopback mock servers through the SAME code path
 *                    (real resolver → real pipeline → real modules);
 *                    the network-unavailable fallback. A blockerNote is
 *                    mandatory so a committed mock report can never be
 *                    mistaken for live evidence.
 */

import { loadSeedManifest } from '@fmd/corpus/corpus-loader';
import type { EgressPolicy } from '../../src/engine/shims/http-egress.js';
import { runModuleGetInfo, type SmokeClassification, type SmokeEventResult } from './smoke.js';
import { FMD2_LUA_ROOT } from '../../src/engine/shims/install.js';
import { LIVE_SUITE_SITES, validateSuite, type SiteDef } from './sites.js';
import {
  assertRequestLog,
  DEFAULT_MIN_GAP_MS,
  SMOKE_USER_AGENT,
  hostOf,
  type PacedResolver,
} from './pacing.js';
import { detectD18, type D18Finding } from './d18.js';

export const SUITE_NAME = 'heterogeneous-v1';
export const D18_FLIP_RULE =
  '>=2 modules with d18-hit findings within one week -> enable the zstd decoder and add zstd to Accept-Encoding (docs/runbook.md, D18 flip procedure)';

/** One suite site's outcome (pass/fail/skip trichotomy). */
export interface SuiteModuleResult {
  readonly site: string;
  readonly category: string;
  readonly url: string;
  readonly moduleFile: string;
  readonly moduleId: string;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly classification: SmokeClassification;
  readonly resultCode: number;
  readonly latencyMs: number;
  readonly durationMs: number;
  readonly detail: string;
}

/** The per-site provenance block of the report's site list. */
export interface SuiteSiteEntry {
  readonly name: string;
  readonly category: string;
  readonly url: string;
  readonly moduleId: string;
  readonly moduleFile: string;
  readonly gated: boolean;
  readonly note?: string;
}

/** The committed report artifact's shape (docs/live-smoke-report.json). */
export interface LiveSmokeReport {
  readonly schema: 'live-smoke-report/1';
  readonly generatedAt: string;
  readonly environment: 'live' | 'mock-cluster';
  /** Mandatory on mock-cluster runs (why live was unavailable). */
  readonly blockerNote?: string;
  readonly suite: string;
  readonly siteCount: number;
  readonly sites: readonly SuiteSiteEntry[];
  readonly results: readonly SuiteModuleResult[];
  readonly totals: { readonly pass: number; readonly fail: number; readonly skip: number };
  /** pass / (pass + fail) — expected-skips excluded from the denominator. */
  readonly passRate: number;
  readonly d18: {
    readonly observations: number;
    readonly findings: readonly D18Finding[];
    readonly affectedModules: number;
    readonly flipRule: string;
  };
  readonly requestLog: {
    readonly count: number;
    readonly fixedUa: string;
    readonly minGapMsPerHost: number;
    readonly perHostRequests: Record<string, number>;
    readonly violations: readonly string[];
  };
}

export interface LiveSuiteOptions {
  /** `live: true` is required for environment 'live' (the gate). */
  readonly live?: boolean;
  readonly environment: 'live' | 'mock-cluster';
  readonly paced: PacedResolver;
  readonly seedDir: string;
  readonly luaRoot?: string;
  /** Mock runs re-admit loopback through the §5.4 egress policy. */
  readonly egress?: EgressPolicy;
  readonly blockerNote?: string;
  readonly sites?: readonly SiteDef[];
  readonly minGapMs?: number;
}

/**
 * Run the heterogeneous suite. Gates: a `live` run refuses without
 * `live: true` (same posture as runSmokeModules); a `mock-cluster` run
 * refuses without a blockerNote (a committed mock report must carry the
 * why). Returns the report; the CLI owns file output.
 */
export async function runLiveSuite(options: LiveSuiteOptions): Promise<LiveSmokeReport> {
  const { environment } = options;
  if (environment === 'live' && options.live !== true) {
    throw new Error(
      'live suite is network-gated: pass { live: true } only from the --live CLI path',
    );
  }
  if (environment === 'mock-cluster' && (options.blockerNote ?? '') === '') {
    throw new Error('mock-cluster runs must carry a blockerNote (why live was unavailable)');
  }
  const sites = options.sites ?? LIVE_SUITE_SITES;
  // The ≥10-site heterogeneous contract applies to the SUITE itself;
  // explicit subsets (verification runs, focused probes) only need to
  // be non-empty and duplicate-free.
  const suiteProblems =
    options.sites === undefined
      ? validateSuite(sites)
      : sites.length === 0 || new Set(sites.map((s) => s.name)).size !== sites.length
        ? ['explicit site subset is empty or has duplicate names']
        : [];
  if (suiteProblems.length > 0) {
    throw new Error(`suite definition invalid: ${suiteProblems.join('; ')}`);
  }
  const luaRoot = options.luaRoot ?? FMD2_LUA_ROOT;
  const minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;

  const results: SuiteModuleResult[] = [];
  const siteList: SuiteSiteEntry[] = [];
  for (const site of sites) {
    const seed = loadSeedManifest(`${options.seedDir}/${site.name}`);
    const moduleResult = await runModuleGetInfo(seed, luaRoot, {
      resolver: options.paced,
      ...(options.egress !== undefined ? { egress: options.egress } : {}),
      urlOverride: site.url,
      transportFailures: () => options.paced.transportFailuresByHost.get(hostOf(site.url)) ?? 0,
    });
    const rawEvent = moduleResult.events[0];
    if (rawEvent === undefined) {
      throw new Error(`module ${site.name} produced no event result`);
    }
    const event: SmokeEventResult =
      site.gated === true && rawEvent.status !== 'pass'
        ? {
            ...rawEvent,
            classification: 'skip:account-gated',
            detail: `${rawEvent.detail} (account-gated site, no credentials configured — expected-skip)`,
          }
        : rawEvent;
    const status: 'pass' | 'fail' | 'skip' =
      event.status === 'pass' ? 'pass' : event.classification === 'skip:account-gated' ? 'skip' : 'fail';
    results.push({
      site: site.name,
      category: site.category,
      url: site.url,
      moduleFile: moduleResult.moduleFile,
      moduleId: moduleResult.moduleId,
      status,
      classification: event.classification,
      resultCode: event.resultCode,
      latencyMs: event.latencyMs,
      durationMs: moduleResult.durationMs,
      detail: event.detail,
    });
    siteList.push({
      name: site.name,
      category: site.category,
      url: site.url,
      moduleId: moduleResult.moduleId,
      moduleFile: moduleResult.moduleFile,
      gated: site.gated === true,
      ...(site.note !== undefined ? { note: site.note } : {}),
    });
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const findings: D18Finding[] = [];
  for (const obs of options.paced.d18Observations) {
    const finding = detectD18(obs);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }
  const d18AffectedHosts = new Set(
    findings.filter((f) => f.severity === 'd18-hit').map((f) => hostOf(f.url)),
  );
  const affectedModules = results.filter((r) => d18AffectedHosts.has(hostOf(r.url))).length;
  const perHostRequests: Record<string, number> = {};
  for (const entry of options.paced.requestLog) {
    perHostRequests[entry.host] = (perHostRequests[entry.host] ?? 0) + 1;
  }
  const violations = assertRequestLog(options.paced.requestLog, {
    minGapMs,
    userAgent: SMOKE_USER_AGENT,
  });

  return {
    schema: 'live-smoke-report/1',
    generatedAt: new Date().toISOString(),
    environment,
    ...(environment === 'mock-cluster' ? { blockerNote: options.blockerNote ?? '' } : {}),
    suite: SUITE_NAME,
    siteCount: sites.length,
    sites: siteList,
    results,
    totals: { pass, fail, skip },
    passRate: pass + fail === 0 ? 0 : pass / (pass + fail),
    d18: {
      observations: options.paced.d18Observations.length,
      findings,
      affectedModules,
      flipRule: D18_FLIP_RULE,
    },
    requestLog: {
      count: options.paced.requestLog.length,
      fixedUa: SMOKE_USER_AGENT,
      minGapMsPerHost: minGapMs,
      perHostRequests,
      violations,
    },
  };
}
