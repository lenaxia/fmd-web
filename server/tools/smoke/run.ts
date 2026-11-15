#!/usr/bin/env node
/**
 * Nightly live smoke CLI (DESIGN.md §13): rotating module sample runner
 * with per-module pass-rate JSON output, plus the heterogeneous
 * ≥10-site suite (§12 Phase-1) writing the committed artifact
 * docs/live-smoke-report.json.
 *
 * NETWORK GATE — nothing hits the EXTERNAL network unless `--live` is
 * passed explicitly. Without it the CLI prints the rotation PLAN only
 * (no engine session). CI never passes --live; this is a manual/nightly
 * tool. The `--mock` suite variant is loopback-only (127.0.0.1 mock
 * cluster, same code path) and does not need --live.
 *
 * Usage:
 *   npx tsx server/tools/smoke/run.ts                     # plan only (offline)
 *   npx tsx server/tools/smoke/run.ts --live              # tonight's sample, live
 *   npx tsx server/tools/smoke/run.ts --live --module AsuraScans
 *   npx tsx server/tools/smoke/run.ts --live --suite      # heterogeneous suite → docs/live-smoke-report.json
 *   npx tsx server/tools/smoke/run.ts --suite --mock \
 *       --blocker-note "worker env cannot reach the seed sites"   # loopback fallback
 *   npx tsx server/tools/smoke/run.ts --live --sample 3 --rotation-index 17 \
 *       --out /tmp/opencode/smoke-report.json
 *
 * Exit codes: 0 = plan printed or report produced (failures are IN the
 * report, the exit code does not gate on live-site health); 2 = usage
 * error.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSeedModules, rotateSample, utcDayNumber, type SeedModuleRef } from './rotation.js';
import { LiveResponseResolver, DEFAULT_LIVE_OPTIONS } from './live-resolver.js';
import { runSmokeModules, type SmokeReport } from './smoke.js';
import { LIVE_SUITE_SITES } from './sites.js';
import { PacedResolver, DEFAULT_MIN_GAP_MS } from './pacing.js';
import { runLiveSuite } from './live-suite.js';
import { mockEgress, MockClusterResolver, startMockCluster } from './mock-cluster.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface SmokeCliArgs {
  readonly live: boolean;
  readonly modules: readonly string[];
  readonly sampleSize: number;
  readonly rotationIndex: number;
  readonly seedDir: string;
  /** Override the seed entry URL for every sampled module (verification use). */
  readonly url?: string;
  readonly out?: string;
  /** Heterogeneous suite (sites.ts) instead of the rotating sample. */
  readonly suite: boolean;
  /** Loopback mock-cluster suite run (no external network). */
  readonly mock: boolean;
  /** Why live was unavailable — mandatory for --suite --mock. */
  readonly blockerNote?: string;
  /** Per-site pacing override (ms); default 1000 = 1 req/s per site. */
  readonly rateMs?: number;
}

export function parseArgs(argv: readonly string[]): SmokeCliArgs {
  let live = false;
  const modules: string[] = [];
  let sampleSize = 5;
  let rotationIndex = utcDayNumber();
  let seedDir = join(ROOT, 'corpus', 'fixtures', 'seed');
  let url: string | undefined;
  let out: string | undefined;
  let suite = false;
  let mock = false;
  let blockerNote: string | undefined;
  let rateMs: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    switch (arg) {
      case '--live':
        live = true;
        break;
      case '--suite':
        suite = true;
        break;
      case '--mock':
        mock = true;
        break;
      case '--blocker-note':
        if (next === undefined) {
          throw new Error('--blocker-note requires a value');
        }
        blockerNote = next;
        i += 1;
        break;
      case '--rate-ms':
        if (next === undefined || Number.isNaN(Number(next)) || Number(next) < 0) {
          throw new Error('--rate-ms requires a non-negative number');
        }
        rateMs = Number(next);
        i += 1;
        break;
      case '--module':
        if (next === undefined) {
          throw new Error('--module requires a value');
        }
        modules.push(...next.split(',').map((s) => s.trim()).filter((s) => s !== ''));
        i += 1;
        break;
      case '--sample':
        if (next === undefined || Number.isNaN(Number(next))) {
          throw new Error('--sample requires a number');
        }
        sampleSize = Number(next);
        i += 1;
        break;
      case '--rotation-index':
        if (next === undefined || Number.isNaN(Number(next))) {
          throw new Error('--rotation-index requires a number');
        }
        rotationIndex = Number(next);
        i += 1;
        break;
      case '--seed-dir':
        if (next === undefined) {
          throw new Error('--seed-dir requires a path');
        }
        seedDir = next;
        i += 1;
        break;
      case '--url':
        if (next === undefined) {
          throw new Error('--url requires a value');
        }
        url = next;
        i += 1;
        break;
      case '--out':
        if (next === undefined) {
          throw new Error('--out requires a path');
        }
        out = next;
        i += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (mock && !suite) {
    throw new Error('--mock requires --suite (the mock cluster simulates the suite sites)');
  }
  if (mock && live) {
    throw new Error('--mock is loopback-only: drop --live for mock runs');
  }
  if (!mock && blockerNote !== undefined) {
    throw new Error('--blocker-note applies to --suite --mock runs only');
  }
  return {
    live,
    modules,
    sampleSize,
    rotationIndex,
    seedDir,
    suite,
    mock,
    ...(url !== undefined ? { url } : {}),
    ...(out !== undefined ? { out } : {}),
    ...(blockerNote !== undefined ? { blockerNote } : {}),
    ...(rateMs !== undefined ? { rateMs } : {}),
  };
}

function resolveSample(args: SmokeCliArgs): ReturnType<typeof rotateSample> {
  const all = listSeedModules(args.seedDir);
  if (args.modules.length > 0) {
    const wanted = new Set(args.modules);
    const picked = all.filter((m) => wanted.has(m.name));
    const unknown = args.modules.filter((n) => !all.some((m) => m.name === n));
    if (unknown.length > 0) {
      throw new Error(`unknown seed module(s): ${unknown.join(', ')}`);
    }
    return picked;
  }
  return rotateSample(all, args.sampleSize, args.rotationIndex);
}

/** Live rotation run with the resolver's temp workspace cleaned up. */
async function runLive(sample: readonly SeedModuleRef[], url?: string): Promise<SmokeReport> {
  const resolver = new LiveResponseResolver(DEFAULT_LIVE_OPTIONS);
  try {
    return await runSmokeModules(sample, {
      live: true,
      resolver,
      ...(url !== undefined ? { urlOverride: url } : {}),
    });
  } finally {
    resolver.dispose();
  }
}

/**
 * Heterogeneous suite run. LIVE: the paced resolver over the real curl
 * resolver (external network, --live gated). MOCK: the same paced
 * resolver over a host-mapped curl resolver pointed at the loopback
 * mock cluster — identical code path, zero external traffic.
 */
async function runSuite(args: SmokeCliArgs): Promise<object> {
  if (args.mock) {
    const cluster = await startMockCluster(args.seedDir, LIVE_SUITE_SITES);
    const live = new LiveResponseResolver(DEFAULT_LIVE_OPTIONS);
    const paced = new PacedResolver(
      new MockClusterResolver(live, cluster.urlMap),
      args.rateMs ?? DEFAULT_MIN_GAP_MS,
    );
    try {
      return await runLiveSuite({
        environment: 'mock-cluster',
        paced,
        seedDir: args.seedDir,
        egress: mockEgress(),
        blockerNote: args.blockerNote ?? '',
      });
    } finally {
      live.dispose();
      cluster.dispose();
    }
  }
  if (!args.live) {
    // SUITE PLAN MODE — never constructs the resolver, no sockets.
    return {
      plan: true,
      note: 'suite plan only — rerun with --live (or --mock for the loopback fallback) to fetch and dispatch (never in CI)',
      suite: 'heterogeneous-v1',
      siteCount: LIVE_SUITE_SITES.length,
      planned: LIVE_SUITE_SITES.map((s) => ({ site: s.name, category: s.category, url: s.url })),
    };
  }
  const live = new LiveResponseResolver(DEFAULT_LIVE_OPTIONS);
  const paced = new PacedResolver(live, args.rateMs ?? DEFAULT_MIN_GAP_MS);
  try {
    return await runLiveSuite({
      live: true,
      environment: 'live',
      paced,
      seedDir: args.seedDir,
    });
  } finally {
    live.dispose();
  }
}

function printReport(report: object, out?: string): void {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.error(`smoke report written: ${out}`);
  }
}

async function main(): Promise<void> {
  let args: SmokeCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`usage error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (args.suite) {
    // Suite runs default the committed artifact path; --out overrides.
    const out = args.out ?? join(ROOT, 'docs', 'live-smoke-report.json');
    printReport(await runSuite(args), out);
    return;
  }
  let sample: ReturnType<typeof rotateSample>;
  try {
    sample = resolveSample(args);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (!args.live) {
    // OFFLINE PLAN MODE — no engine session, no resolver, no network.
    printReport(
      {
        live: false,
        note: 'plan only — rerun with --live to fetch and dispatch (never in CI)',
        rotationIndex: args.rotationIndex,
        sampleSize: args.modules.length > 0 ? sample.length : Math.min(args.sampleSize, sample.length),
        planned: sample.map((m) => m.name),
      },
      args.out,
    );
    return;
  }

  printReport(await runLive(sample, args.url), args.out);
}

await main();
