#!/usr/bin/env node
/**
 * Weekly site-liveness harness: for every enabled site, pick a random
 * series, download one chapter through the REAL pipeline (in-process
 * server: /api/info → /api/jobs/download → terminal), discard the
 * artifacts (temp data dir), and fold the outcome into
 * server/tools/sitecheck/liveness.json.
 *
 * Try policy: up to --tries (default 3) random series per site; a site
 * whose week has zero successes is WARNED; --weeks-to-fail (default 3)
 * consecutive warn weeks mark it FAILED (a flag only — nothing gates on
 * it; a later ok week self-heals).
 *
 * NETWORK GATE (smoke-tool convention): without --live the CLI prints
 * the plan only — no server, no sockets. CI passes --live.
 *
 * Usage:
 *   node_modules/.bin/tsx server/tools/sitecheck/run.ts                 # plan
 *   node_modules/.bin/tsx server/tools/sitecheck/run.ts --live          # full run
 *   node_modules/.bin/tsx server/tools/sitecheck/run.ts --live --site FanFox
 *   node_modules/.bin/tsx server/tools/sitecheck/run.ts --live --limit 5
 *
 * Exit codes: 0 = plan or report written (site health lives IN the
 * state file, the exit code does not gate); 2 = usage error.
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRuntimeConfig, buildRuntime } from '../../src/runtime/assembly.js';
import { respondAsync } from '../../src/main.js';
import { attachWebSocketHub } from '../../src/api/ws/attach.js';
import { createLuaHostFactory } from '../../src/engine/lua/host.js';
import { DeadlineAbortHandle, createDeadlineCells } from '../../src/engine/lua/abort.js';
import { createMemoryLogger } from '../../src/engine/lua/logger.js';
import { initShimsHook, installShims, loadRealModuleFile } from '../../src/engine/shims/install.js';
import { RecordedResponseResolver } from '../../src/engine/shims/http-shim.js';
import { LoopbackHttpTransport } from '../../src/engine/shims/http-transport.js';
import {
  DEFAULT_MAX_TRIES,
  DEFAULT_WEEKS_TO_FAILED,
  mergeWeek,
  weekOutcome,
  type LivenessEntry,
  type LivenessState,
  type SeriesAttempt,
} from './state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_STATE_PATH = join(ROOT, 'server', 'tools', 'sitecheck', 'liveness.json');

function dirname(p: string): string {
  return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
}

// ── seeded RNG (reproducible runs; --seed prints in the report) ────────
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ── CLI ────────────────────────────────────────────────────────────────
export interface SitecheckArgs {
  readonly live: boolean;
  readonly sites: readonly string[];
  readonly limit: number;
  readonly tries: number;
  readonly seed: number;
  readonly includeKnownBroken: boolean;
  readonly statePath: string;
  readonly chapterTimeoutMs: number;
  readonly budgetMs: number;
}

export function parseArgs(argv: readonly string[]): SitecheckArgs | { error: string } {
  const a: { -readonly [K in keyof SitecheckArgs]: SitecheckArgs[K] } = {
    live: false,
    sites: [],
    limit: Number.MAX_SAFE_INTEGER,
    tries: DEFAULT_MAX_TRIES,
    seed: (Date.now() ^ (process.pid << 8)) >>> 0,
    includeKnownBroken: false,
    statePath: DEFAULT_STATE_PATH,
    chapterTimeoutMs: 300_000,
    budgetMs: 300 * 60_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return v;
    };
    try {
      if (arg === '--live') a.live = true;
      else if (arg === '--site') a.sites = [...a.sites, next()];
      else if (arg === '--limit') a.limit = Number.parseInt(next(), 10);
      else if (arg === '--tries') a.tries = Number.parseInt(next(), 10);
      else if (arg === '--seed') a.seed = Number.parseInt(next(), 10) >>> 0;
      else if (arg === '--include-known-broken') a.includeKnownBroken = true;
      else if (arg === '--state') a.statePath = next();
      else if (arg === '--chapter-timeout-ms') a.chapterTimeoutMs = Number.parseInt(next(), 10);
      else if (arg === '--budget-minutes') a.budgetMs = Number.parseInt(next(), 10) * 60_000;
      else return { error: `unknown argument: ${arg}` };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return a;
}

interface SiteRow {
  id: string;
  name: string;
  file: string;
  enabled: boolean;
  knownBroken: readonly string[];
}

// ── the live runner ────────────────────────────────────────────────────
interface RunnerDeps {
  readonly port: number;
  readonly base: string;
  readonly dataDir: string;
  readonly luaRoot: string;
}

async function bootServer(log: (m: string) => void): Promise<RunnerDeps> {
  const dataDir = mkdtempSync(join(tmpdir(), 'sitecheck-'));
  const port = 21_000 + Math.floor(Math.random() * 20_000);
  process.env['FMD_WEB_DATA_DIR'] = dataDir;
  process.env['PORT'] = String(port);
  process.env['FMD_HTTP_ALLOW_HOSTS'] = '*';
  delete process.env['FMD_STATIC_DIR'];
  const config = loadRuntimeConfig();
  const runtime = await buildRuntime({ config, log, version: 'sitecheck' });
  const server = createServer((req, res): void => {
    void respondAsync(runtime.app, req, res);
  });
  attachWebSocketHub(server, runtime.wsHub, { authenticate: (): boolean => true });
  await new Promise<void>((resolve): void => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${String(port)}`;
  // D20 bootstrap driver (runtime-entry parity): sync modules+catalogs
  // into the temp dir, with the same small retry ladder.
  const boot = (async (): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runtime.bootstrap.run();
      if (runtime.bootstrap.isDone) {
        log('bootstrap complete');
        return;
      }
      await new Promise((r): void => {
        setTimeout(r, 1500);
      });
    }
    log('bootstrap gave up');
  })();
  for (let i = 0; i < 300; i += 1) {
    const r = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) }).catch((): undefined => undefined);
    if (r?.ok) {
      await boot.catch((): void => undefined);
      log(`server ready on ${base} (temp data ${dataDir})`);
      return { port, base, dataDir, luaRoot: join(dataDir, 'lua') };
    }
    await new Promise((r2): void => {
      setTimeout(r2, 1000);
    });
  }
  throw new Error('server failed to become ready within 300s');
}

/** Directory walk: the module's own GetNameAndLink, page 1. */
async function listSeries(
  deps: RunnerDeps,
  site: SiteRow,
): Promise<{ names: string[]; links: string[] } | { error: string }> {
  const inner = new LoopbackHttpTransport({ allowedHosts: ['*'] });
  const logger = createMemoryLogger();
  const host = createLuaHostFactory().createHost(logger);
  try {
    const abort = new DeadlineAbortHandle(createDeadlineCells());
    const resolver = new RecordedResponseResolver([]);
    const hook = initShimsHook({ resolver, abort, logger, moduleId: site.file, luaRoot: deps.luaRoot });
    const descriptors = await loadRealModuleFile(host, deps.luaRoot, `modules/${site.file}`, hook);
    const descriptor = descriptors[0];
    if (descriptor === undefined) return { error: 'module produced no descriptor' };
    const engine = await host.createEngine();
    let installed: ReturnType<typeof installShims> | undefined;
    await engine.loadModule(`modules/${site.file}`, (a, b): void => {
      installed = installShims(a, b, { resolver, abort, logger, moduleId: descriptor.id, luaRoot: deps.luaRoot, transport: inner });
    });
    if (installed === undefined) return { error: 'shim install did not run' };
    const dispatcher = host.createDispatcher(engine, abort, undefined, { makeHTTP: installed.makeHTTP });
    const result = dispatcher.dispatch(descriptor, 'GetNameAndLink', { url: '1' });
    if (result.kind !== 'code' || result.value !== 0) {
      return { error: `GetNameAndLink failed: ${JSON.stringify(result).slice(0, 80)}` };
    }
    const count = Number(engine.doStringSync('return LINKS.Count'));
    const links: string[] = [];
    const names: string[] = [];
    for (let i = 0; i < count; i += 1) {
      links.push(String(engine.doStringSync(`return LINKS[${String(i)}]`)));
      names.push(String(engine.doStringSync(`return NAMES[${String(i)}]`)));
    }
    return { names, links };
  } finally {
    inner.dispose();
    await host.dispose().catch((): void => undefined);
  }
}

async function apiJson<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  });
  return (await r.json()) as T;
}

/** One series attempt: info → random chapter → download → terminal. */
async function trySeries(
  deps: RunnerDeps,
  site: SiteRow,
  link: string,
  rng: () => number,
  chapterTimeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const info = await apiJson<Record<string, unknown>>(deps.base, '/api/info', {
      method: 'POST',
      body: JSON.stringify({ moduleId: site.id, url: link }),
    });
    const chapterLinks = (info['chapterLinks'] ?? []) as string[];
    if (chapterLinks.length === 0) return { ok: false, error: 'series has no chapters' };
    const idx = Math.floor(rng() * Math.min(chapterLinks.length, 100));
    const chapterLink = chapterLinks[idx] as string;
    const chapterNames = (info['chapterNames'] ?? []) as string[];
    const created = await apiJson<{ job?: { id?: string } }>(deps.base, '/api/jobs/download', {
      method: 'POST',
      body: JSON.stringify({
        moduleId: site.id,
        mangaUrl: link,
        chapterLink,
        ...(chapterNames[idx] !== undefined ? { chapterName: chapterNames[idx] } : {}),
      }),
    });
    const jobId = created.job?.id;
    if (jobId === undefined) return { ok: false, error: 'job create failed' };
    const deadline = Date.now() + chapterTimeoutMs;
    for (;;) {
      if (Date.now() > deadline) {
        await apiJson(deps.base, `/api/jobs/${jobId}/cancel`, { method: 'POST', body: '{}' }).catch((): unknown => undefined);
        return { ok: false, error: 'chapter timeout' };
      }
      const j = await apiJson<{ job?: { state?: string; error?: string } }>(deps.base, `/api/jobs/${jobId}`);
      const state = j.job?.state;
      if (state === 'done') return { ok: true };
      if (state === 'failed') return { ok: false, error: (j.job?.error ?? 'download failed').slice(0, 120) };
      await new Promise((r): void => {
        setTimeout(r, 1500);
      });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) };
  }
}

export interface SitecheckReport {
  readonly ranAt: string;
  readonly seed: number;
  readonly tried: number;
  readonly skipped: number;
  readonly notRun: number;
  readonly ok: number;
  readonly warned: number;
  readonly failed: number;
  readonly sites: ReadonlyArray<{
    site: string;
    outcome: string;
    attempts: number;
    series?: string;
    error?: string;
  }>;
}

export async function runSitecheck(
  args: SitecheckArgs,
  log: (m: string) => void,
): Promise<{ state: LivenessState; report: SitecheckReport }> {
  const now = new Date().toISOString();
  const rng = makeRng(args.seed);
  const prev: LivenessState = existsSync(args.statePath)
    ? (JSON.parse(readFileSync(args.statePath, 'utf8')) as LivenessState)
    : { updatedAt: now, entries: {} };
  const deps = await bootServer(log);
  const reportSites: {
    site: string;
    outcome: string;
    attempts: number;
    series?: string;
    error?: string;
  }[] = [];
  let entries: Record<string, LivenessEntry> = { ...prev.entries };
  const rows = (await apiJson<{ modules?: SiteRow[] }>(deps.base, '/api/modules')).modules ?? [];
  let candidates = rows.filter((r): boolean => r.enabled);
  if (!args.includeKnownBroken) candidates = candidates.filter((r): boolean => (r.knownBroken ?? []).length === 0);
  if (args.sites.length > 0) {
    const want = new Set(args.sites);
    candidates = candidates.filter((r): boolean => want.has(r.name) || want.has(r.id));
  }
  if (candidates.length > args.limit) candidates = candidates.slice(0, args.limit);
  // deterministic shuffle so a budget cap cuts a random-ish subset
  candidates = candidates
    .map((c): { r: number; c: SiteRow } => ({ r: rng(), c }))
    .sort((x, y): number => x.r - y.r)
    .map((x): SiteRow => x.c);

  const startMs = Date.now();
  let ok = 0;
  let warned = 0;
  let failed = 0;
  let skipped = 0;
  let notRun = 0;
  let tried = 0;

  try {
    for (const site of candidates) {
      if (Date.now() - startMs > args.budgetMs) {
        notRun += 1;
        reportSites.push({ site: site.name, outcome: 'not-run', attempts: 0 });
        continue;
      }
      const listing = await listSeries(deps, site);
      if ('error' in listing) {
        skipped += 1;
        entries = mergeWeek(entries, site.id, { outcome: 'skipped', attempts: 0 }, now, DEFAULT_WEEKS_TO_FAILED);
        reportSites.push({ site: site.name, outcome: 'skipped', attempts: 0, error: listing.error });
        log(`${site.name}: skipped (${listing.error})`);
        continue;
      }
      const pairs = listing.links
        .map((l, i): { link: string; name: string } => ({ link: l, name: listing.names[i] ?? '' }))
        .filter((p): boolean => p.link !== '');
      if (pairs.length === 0) {
        skipped += 1;
        entries = mergeWeek(entries, site.id, { outcome: 'skipped', attempts: 0 }, now, DEFAULT_WEEKS_TO_FAILED);
        reportSites.push({ site: site.name, outcome: 'skipped', attempts: 0, error: 'empty directory' });
        continue;
      }
      tried += 1;
      const attempts: SeriesAttempt[] = [];
      const usedIdx = new Set<number>();
      for (let t = 0; t < args.tries && attempts.length < args.tries; t += 1) {
        let idx = Math.floor(rng() * pairs.length);
        for (let guard = 0; guard < pairs.length && usedIdx.has(idx); guard += 1) {
          idx = (idx + 1) % pairs.length;
        }
        usedIdx.add(idx);
        const series = pairs[idx] as { link: string; name: string };
        const r = await trySeries(deps, site, series.link, rng, args.chapterTimeoutMs);
        attempts.push({ series: series.name !== '' ? series.name : series.link, ok: r.ok, ...(r.ok ? {} : { error: (r as { error: string }).error }) });
        if (r.ok) break;
      }
      const week = weekOutcome(attempts, args.tries);
      entries = mergeWeek(entries, site.id, week, now, DEFAULT_WEEKS_TO_FAILED);
      const status = entries[site.id]?.status ?? 'ok';
      if (week.outcome === 'ok') ok += 1;
      else if (status === 'failed') failed += 1;
      else warned += 1;
      reportSites.push({
        site: site.name,
        outcome: week.outcome,
        attempts: week.attempts,
        ...(week.outcome === 'ok' ? { series: week.successfulSeries } : { error: week.lastError }),
      });
      log(`${site.name}: ${week.outcome}${week.outcome === 'ok' ? ` (${week.successfulSeries})` : ` — ${week.lastError}`}`);
    }
  } finally {
    // discard: the temp data dir held every download
    rmSync(deps.dataDir, { recursive: true, force: true });
  }

  const report: SitecheckReport = {
    ranAt: now,
    seed: args.seed,
    tried,
    skipped,
    notRun,
    ok,
    warned,
    failed,
    sites: reportSites,
  };
  return { state: { updatedAt: now, entries }, report };
}

// ── CLI main ───────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`sitecheck: ${parsed.error}`);
    return 2;
  }
  const log = (m: string): void => {
    console.log(`sitecheck: ${m}`);
  };
  if (!parsed.live) {
    console.log('sitecheck: PLAN (offline — pass --live to execute; CI passes --live)');
    console.log(`  tries/site:    ${String(parsed.tries)}`);
    console.log(`  state file:   ${parsed.statePath}`);
    console.log(`  sites:        ${parsed.sites.length > 0 ? parsed.sites.join(', ') : 'all enabled (known-broken excluded)'}`);
    return 0;
  }
  const { state, report } = await runSitecheck(parsed, log);
  writeFileSync(parsed.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  writeFileSync(
    parsed.statePath.replace(/\.json$/, '.report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  log(`state written: ${parsed.statePath}`);
  log(`ok ${String(report.ok)} | warn ${String(report.warned)} | failed ${String(report.failed)} | skipped ${String(report.skipped)} | not-run ${String(report.notRun)}`);
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  const code = await main();
  // The in-process server (listener + engine + workers) holds the event
  // loop open past the work — exit explicitly so CI steps complete.
  process.exit(code);
}
