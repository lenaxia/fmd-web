#!/usr/bin/env node
/**
 * Nightly live smoke CLI (DESIGN.md §13): rotating module sample runner
 * with per-module pass-rate JSON output.
 *
 * NETWORK GATE — nothing hits the network unless `--live` is passed
 * explicitly. Without it the CLI prints the rotation PLAN only (which
 * modules the next run would sample) and never opens an engine session.
 * CI never passes --live; this is a manual/nightly tool.
 *
 * Usage:
 *   npx tsx server/tools/smoke/run.ts                     # plan only (offline)
 *   npx tsx server/tools/smoke/run.ts --live              # tonight's sample, live
 *   npx tsx server/tools/smoke/run.ts --live --module AsuraScans
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
}

export function parseArgs(argv: readonly string[]): SmokeCliArgs {
  let live = false;
  const modules: string[] = [];
  let sampleSize = 5;
  let rotationIndex = utcDayNumber();
  let seedDir = join(ROOT, 'corpus', 'fixtures', 'seed');
  let url: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    switch (arg) {
      case '--live':
        live = true;
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
  return {
    live,
    modules,
    sampleSize,
    rotationIndex,
    seedDir,
    ...(url !== undefined ? { url } : {}),
    ...(out !== undefined ? { out } : {}),
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

/** Live run with the resolver's temp workspace guaranteed cleaned up. */
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
