import { PerformanceObserver, type PerformanceObserverCallback, performance } from 'node:perf_hooks';

/**
 * The metrics registry (DESIGN.md §4/§15 observability): an in-process,
 * zero-dependency Prometheus text-exposition registry rendered by
 * `GET /api/metrics`. Series (all `fmd_`-prefixed):
 *
 * - queue depth per lane + job rows by state (`fmd_queue_depth`,
 *   `fmd_jobs_state`) — gauges, evaluated at scrape from the live queue;
 * - job throughput/failure by state (`fmd_jobs_enqueued_total`,
 *   `fmd_jobs_claimed_total`, `fmd_jobs_terminal_total`,
 *   `fmd_job_failures_total`) — counters, incremented by the
 *   instrumented queue wrapper;
 * - per-module request latency + error counts (`fmd_module_requests_total`,
 *   `fmd_module_request_latency_seconds`) — §15 standing metric;
 * - corpus pass rates (`fmd_corpus_pass_rate`) — §15 ecosystem metric;
 * - engine pool RSS + GC stats (`fmd_engine_pool_rss_bytes`,
 *   `fmd_gc_pause_seconds_total`, `fmd_gc_pause_count_total`) — the
 *   engine-per-worker pool shares the process address space, so RSS is
 *   process-level and GC pauses come from the perf_hooks gc observer;
 * - sync progress (`fmd_sync_operations_total`, `fmd_sync_in_progress`,
 *   `fmd_sync_progress_ratio`, `fmd_sync_last_success_timestamp_seconds`);
 * - expression-failure WARN dedup counters (§5.6 review bound) re-exported
 *   from the structured logger (`fmd_log_expression_warns_total`,
 *   `fmd_log_expression_suppressed_total`).
 *
 * Rendering is deterministic (families sorted by name, series sorted by
 * label values) so tests assert exact blocks of the exposition.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';
export type LabelSet = Record<string, string>;

export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

interface FamilyDecl {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly labelNames: readonly string[];
}

interface HistogramValue {
  readonly buckets: readonly number[];
  counts: number[];
  sum: number;
  count: number;
}

/** Escape a label value (Prometheus exposition rules). */
function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function serializeLabels(labels: LabelSet | undefined): string {
  if (labels === undefined) {
    return '';
  }
  const names = Object.keys(labels).sort();
  if (names.length === 0) {
    return '';
  }
  const pairs = names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`);
  return `{${pairs.join(',')}}`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toPrecision(12).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * The registry. Metric families are declared up front (HELP/TYPE
 * correctness) and values stored flat per label-set; undeclared series
 * are refused so the exposition stays an auditable contract.
 */
export class MetricsRegistry {
  private readonly decls = new Map<string, FamilyDecl>();
  private readonly values = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramValue>();
  private readonly gaugeFns = new Map<string, () => number>();
  private readonly scrapeHooks: (() => void)[] = [];
  private gcObserver: PerformanceObserver | undefined;
  private readonly gcCounts = new Map<string, number>();
  private readonly gcDurations = new Map<string, number>();

  /** Declare one family. Second declaration with the same name throws. */
  declare(name: string, type: MetricType, help: string, labelNames: readonly string[]): this {
    const existing = this.decls.get(name);
    if (existing !== undefined) {
      throw new Error(`metric family already declared: ${name}`);
    }
    this.decls.set(name, { name, type, help, labelNames });
    return this;
  }

  declareAll(decls: readonly FamilyDecl[]): this {
    for (const decl of decls) {
      this.declare(decl.name, decl.type, decl.help, decl.labelNames);
    }
    return this;
  }

  /** Register a scrape-time hook (e.g. queue-depth snapshot). */
  onScrape(hook: () => void): this {
    this.scrapeHooks.push(hook);
    return this;
  }

  counter(name: string, labels: LabelSet | undefined, delta = 1): void {
    this.assertDeclared(name, 'counter');
    const key = `${name}${serializeLabels(labels)}`;
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  setGauge(name: string, labels: LabelSet | undefined, value: number): void {
    this.assertDeclared(name, 'gauge');
    this.values.set(`${name}${serializeLabels(labels)}`, value);
  }

  /**
   * Scrape-evaluated value (live memory, queue depth, dedup counters).
   * Accepts gauge AND counter families — the fn returns the current
   * cumulative value for counters (monotonicity is the recorder's job).
   */
  setGaugeFn(name: string, labels: LabelSet | undefined, fn: () => number): void {
    const decl = this.decls.get(name);
    if (decl === undefined || (decl.type !== 'gauge' && decl.type !== 'counter')) {
      throw new Error(`metric ${name} must be a gauge or counter to bind a scrape fn`);
    }
    this.gaugeFns.set(`${name}${serializeLabels(labels)}`, fn);
  }

  observeHistogram(name: string, labels: LabelSet | undefined, seconds: number): void {
    this.assertDeclared(name, 'histogram');
    const key = `${name}${serializeLabels(labels)}`;
    let hist = this.histograms.get(key);
    if (hist === undefined) {
      hist = {
        buckets: LATENCY_BUCKETS_SECONDS,
        counts: new Array<number>(LATENCY_BUCKETS_SECONDS.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, hist);
    }
    for (let i = 0; i < hist.buckets.length; i += 1) {
      if (seconds <= (hist.buckets[i] as number)) {
        hist.counts[i] = (hist.counts[i] as number) + 1;
      }
    }
    hist.sum += seconds;
    hist.count += 1;
  }

  /** Start the perf_hooks GC observer (idempotent; unref'd). */
  observeGc(): this {
    if (this.gcObserver !== undefined) {
      return this;
    }
    const kinds: Record<number, string> = { 1: 'minor', 2: 'major', 3: 'incremental', 4: 'weakcb' };
    const callback: PerformanceObserverCallback = (list): void => {
      for (const entry of list.getEntries()) {
        const detail = (entry as { detail?: { kind?: number } }).detail;
        const kindLabel = kinds[detail?.kind ?? 0] ?? `kind_${String(detail?.kind ?? 0)}`;
        this.gcCounts.set(kindLabel, (this.gcCounts.get(kindLabel) ?? 0) + 1);
        this.gcDurations.set(
          kindLabel,
          (this.gcDurations.get(kindLabel) ?? 0) + entry.duration / 1000,
        );
      }
    };
    this.gcObserver = new PerformanceObserver(callback);
    this.gcObserver.observe({ entryTypes: ['gc'] });
    // Keep the observer from holding the event loop open.
    (this.gcObserver as unknown as { unref?: () => void }).unref?.();
    return this;
  }

  /** Render the Prometheus text exposition (version 0.0.4). */
  render(): string {
    for (const hook of this.scrapeHooks) {
      hook();
    }
    const lines: string[] = [];
    const names = [...this.decls.keys()].sort();
    for (const name of names) {
      const decl = this.decls.get(name) as FamilyDecl;
      lines.push(`# HELP ${name} ${decl.help}`);
      lines.push(`# TYPE ${name} ${decl.type}`);
      if (decl.type === 'histogram') {
        lines.push(...this.renderHistogram(name));
        continue;
      }
      const series: { labels: string; key: string; value: number }[] = [];
      for (const [key, value] of this.values.entries()) {
        if (key === name || key.startsWith(`${name}{`)) {
          series.push({ labels: key.slice(name.length), key, value });
        }
      }
      for (const [key, fn] of this.gaugeFns.entries()) {
        if (key === name || key.startsWith(`${name}{`)) {
          series.push({ labels: key.slice(name.length), key, value: fn() });
        }
      }
      series.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const entry of series) {
        lines.push(`${name}${entry.labels} ${formatNumber(entry.value)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private renderHistogram(name: string): string[] {
    const decl = this.decls.get(name) as FamilyDecl;
    const entries = [...this.histograms.entries()]
      .filter(([key]) => key === name || key.startsWith(`${name}{`))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const lines: string[] = [];
    for (const [key, hist] of entries) {
      const labels = key.slice(name.length);
      const inner = decl.labelNames.length === 0
        ? ''
        : labels.slice(1, -1); // strip braces; bucket lines add le=...
      const withLe = (le: string): string => {
        if (inner === '') {
          return `{le="${le}"}`;
        }
        return `{${inner},le="${le}"}`;
      };
      for (let i = 0; i < hist.buckets.length; i += 1) {
        // Each stored bucket holds the count of observations ≤ its bound
        // (Prometheus cumulative-≤ semantics) — emit as-is.
        lines.push(`${name}_bucket${withLe(String(hist.buckets[i]))} ${formatNumber(hist.counts[i] as number)}`);
      }
      lines.push(`${name}_bucket${withLe('+Inf')} ${formatNumber(hist.count)}`);
      lines.push(`${name}_sum${labels} ${formatNumber(hist.sum)}`);
      lines.push(`${name}_count${labels} ${formatNumber(hist.count)}`);
    }
    return lines;
  }

  private assertDeclared(name: string, type: MetricType): void {
    const decl = this.decls.get(name);
    if (decl === undefined) {
      throw new Error(`undeclared metric family: ${name}`);
    }
    if (decl.type !== type) {
      throw new Error(`metric ${name} is a ${decl.type}, not a ${type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Domain families + the façade the rest of the server uses
// ---------------------------------------------------------------------------

export const SYNC_KINDS = ['modules', 'catalog'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];
export type SyncOutcome = 'ok' | 'failed' | 'skipped';

/** The §4/§15 family set, declared once per registry via {@link fmdMetrics}. */
export function declareFmdFamilies(registry: MetricsRegistry): MetricsRegistry {
  registry.declareAll([
    { name: 'fmd_queue_depth', type: 'gauge', help: 'Queued+retry job rows per lane (§4).', labelNames: ['lane'] },
    { name: 'fmd_jobs_state', type: 'gauge', help: 'Job rows by lane and state.', labelNames: ['lane', 'state'] },
    { name: 'fmd_jobs_enqueued_total', type: 'counter', help: 'Jobs enqueued per lane.', labelNames: ['lane'] },
    { name: 'fmd_jobs_claimed_total', type: 'counter', help: 'Job claims per lane.', labelNames: ['lane'] },
    { name: 'fmd_jobs_terminal_total', type: 'counter', help: 'Jobs reaching a terminal state, by lane and state.', labelNames: ['lane', 'state'] },
    { name: 'fmd_job_failures_total', type: 'counter', help: 'Failed jobs by failure kind (§7.1).', labelNames: ['lane', 'kind'] },
    { name: 'fmd_module_requests_total', type: 'counter', help: 'Module-engine requests by module and outcome (§15).', labelNames: ['module', 'outcome'] },
    { name: 'fmd_module_request_latency_seconds', type: 'histogram', help: 'Module-engine request latency (§15).', labelNames: ['module'] },
    { name: 'fmd_corpus_pass_rate', type: 'gauge', help: 'Corpus pass rate per module (§15, 0..1).', labelNames: ['module'] },
    { name: 'fmd_engine_pool_rss_bytes', type: 'gauge', help: 'Engine pool (process) resident set size (§5.12).', labelNames: [] },
    { name: 'fmd_process_heap_used_bytes', type: 'gauge', help: 'V8 heap used bytes.', labelNames: [] },
    { name: 'fmd_process_external_bytes', type: 'gauge', help: 'External (Buffer/typed-array) memory bytes.', labelNames: [] },
    { name: 'fmd_gc_pause_count_total', type: 'counter', help: 'GC pause events by kind.', labelNames: ['kind'] },
    { name: 'fmd_gc_pause_seconds_total', type: 'counter', help: 'Total GC pause seconds by kind.', labelNames: ['kind'] },
    { name: 'fmd_sync_operations_total', type: 'counter', help: 'Sync operations by kind and outcome (§6).', labelNames: ['kind', 'outcome'] },
    { name: 'fmd_sync_in_progress', type: 'gauge', help: 'Sync operation running (1) or idle (0), by kind.', labelNames: ['kind'] },
    { name: 'fmd_sync_progress_ratio', type: 'gauge', help: 'Sync progress 0..1 by kind (latest observed).', labelNames: ['kind'] },
    { name: 'fmd_sync_last_success_timestamp_seconds', type: 'gauge', help: 'Last successful sync per kind (unix seconds).', labelNames: ['kind'] },
    { name: 'fmd_log_expression_warns_total', type: 'counter', help: 'Distinct (module, expression-template) WARNs this run (dedup bound, §5.6).', labelNames: [] },
    { name: 'fmd_log_expression_suppressed_total', type: 'counter', help: 'Repeat expression failures suppressed by the deduper this run.', labelNames: [] },
  ]);
  return registry;
}

export interface CorpusPassRateEntry {
  readonly module: string;
  /** 0..1 (§15). */
  readonly rate: number;
}

/**
 * The domain façade: typed recorders for the §4/§15 series, on top of a
 * declared registry. One instance per process (the runtime assembly
 * builds it; tests build their own).
 */
export class FmdMetrics {
  readonly registry: MetricsRegistry;
  private syncStartedAt = new Map<string, number>();

  constructor(
    registry: MetricsRegistry = declareFmdFamilies(new MetricsRegistry()),
  ) {
    this.registry = registry;
  }

  /** Bind the run-level dedup counters (rendered live at scrape). */
  bindExpressionDedup(stats: () => { warned: number; suppressed: number }): this {
    this.registry.setGaugeFn('fmd_log_expression_warns_total', undefined, () => stats().warned);
    this.registry.setGaugeFn('fmd_log_expression_suppressed_total', undefined, () => stats().suppressed);
    return this;
  }

  /** Bind live process RSS/heap + start the GC observer. */
  bindProcessMemory(): this {
    this.registry.observeGc();
    this.registry.setGaugeFn('fmd_engine_pool_rss_bytes', undefined, () => process.memoryUsage().rss);
    this.registry.setGaugeFn('fmd_process_heap_used_bytes', undefined, () => process.memoryUsage().heapUsed);
    this.registry.setGaugeFn('fmd_process_external_bytes', undefined, () => process.memoryUsage().external);
    return this;
  }

  // ── jobs (§4) ─────────────────────────────────────────────────────
  recordJobEnqueued(lane: string): void {
    this.registry.counter('fmd_jobs_enqueued_total', { lane });
  }

  recordJobClaimed(lane: string): void {
    this.registry.counter('fmd_jobs_claimed_total', { lane });
  }

  recordJobTerminal(lane: string, state: string, failureKind?: string): void {
    this.registry.counter('fmd_jobs_terminal_total', { lane, state });
    if (state === 'failed' && failureKind !== undefined) {
      this.registry.counter('fmd_job_failures_total', { lane, kind: failureKind });
    }
  }

  /** Scrape hook body: queue depth per lane + rows per state (§4). */
  snapshotQueueStates(
    countsByLane: Readonly<Record<string, Record<string, number>>>,
  ): void {
    for (const [lane, counts] of Object.entries(countsByLane)) {
      const depth = (counts['queued'] ?? 0) + (counts['retry'] ?? 0);
      this.registry.setGauge('fmd_queue_depth', { lane }, depth);
      for (const [state, n] of Object.entries(counts)) {
        this.registry.setGauge('fmd_jobs_state', { lane, state }, n);
      }
    }
  }

  // ── module requests (§15) ─────────────────────────────────────────
  observeModuleRequest(moduleId: string, durationMs: number, outcome: 'ok' | 'error'): void {
    this.registry.counter('fmd_module_requests_total', { module: moduleId, outcome });
    this.registry.observeHistogram('fmd_module_request_latency_seconds', { module: moduleId }, durationMs / 1000);
  }

  // ── corpus pass rates (§15) ───────────────────────────────────────
  setCorpusPassRates(entries: readonly CorpusPassRateEntry[]): void {
    for (const entry of entries) {
      this.registry.setGauge('fmd_corpus_pass_rate', { module: entry.module }, entry.rate);
    }
  }

  // ── sync progress (§6) ────────────────────────────────────────────
  syncStarted(kind: SyncKind): void {
    this.syncStartedAt.set(kind, performance.now());
    this.registry.setGauge('fmd_sync_in_progress', { kind }, 1);
  }

  syncProgress(kind: SyncKind, done: number, total: number): void {
    const ratio = total <= 0 ? 1 : Math.min(1, Math.max(0, done / total));
    this.registry.setGauge('fmd_sync_progress_ratio', { kind }, ratio);
  }

  syncFinished(kind: SyncKind, outcome: SyncOutcome, atEpochMs: number = Date.now()): void {
    this.registry.counter('fmd_sync_operations_total', { kind, outcome });
    this.registry.setGauge('fmd_sync_in_progress', { kind }, 0);
    if (outcome === 'ok') {
      this.registry.setGauge(
        'fmd_sync_last_success_timestamp_seconds',
        { kind },
        Math.floor(atEpochMs / 1000),
      );
      this.registry.setGauge('fmd_sync_progress_ratio', { kind }, 1);
    }
    this.syncStartedAt.delete(kind);
  }
}
