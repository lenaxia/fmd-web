import type { SyncService } from '../api/services.js';
import { FmdMetrics, type SyncKind, type SyncOutcome } from './metrics.js';

/**
 * Instrumented sync service (§6 observability): a transparent `SyncService`
 * wrapper that records sync progress into the metrics registry —
 * `fmd_sync_in_progress{kind}` while a sync runs, `fmd_sync_operations_total{kind,outcome}`
 * per completed operation (`unchanged`/`updated` count as `ok`, per-catalog
 * `failed` as `failed`; `skipped` is reserved for disabled batches) and
 * `fmd_sync_progress_ratio{kind}` as the batch completes. Never alters
 * outcomes — every promise result (or rejection) passes through unchanged.
 */
export class InstrumentedSyncService implements SyncService {
  private readonly inner: SyncService;
  readonly metrics: FmdMetrics;

  constructor(inner: SyncService, metrics: FmdMetrics) {
    this.inner = inner;
    this.metrics = metrics;
  }

  async syncModules(): Promise<Awaited<ReturnType<SyncService['syncModules']>>> {
    this.metrics.syncStarted('modules');
    try {
      const outcome = await this.inner.syncModules();
      const ok = outcome.summary.failedFiles === 0;
      this.metrics.syncFinished('modules', ok ? 'ok' : 'failed');
      return outcome;
    } catch (error: unknown) {
      this.metrics.syncFinished('modules', 'failed');
      throw error;
    }
  }

  async syncCatalog(id: string): Promise<Awaited<ReturnType<SyncService['syncCatalog']>>> {
    const kind: SyncKind = 'catalog';
    this.metrics.syncStarted(kind);
    this.metrics.syncProgress(kind, 0, 1);
    try {
      const outcome = await this.inner.syncCatalog(id);
      const mapped: SyncOutcome = outcome.state === 'failed' ? 'failed' : 'ok';
      this.metrics.syncProgress(kind, 1, 1);
      this.metrics.syncFinished(kind, mapped);
      return outcome;
    } catch (error: unknown) {
      this.metrics.syncFinished(kind, 'failed');
      throw error;
    }
  }

  async syncAllCatalogs(): Promise<readonly Awaited<ReturnType<SyncService['syncCatalog']>>[]> {
    this.metrics.syncStarted('catalog');
    try {
      const outcomes = await this.inner.syncAllCatalogs();
      const done = outcomes.filter((o) => o.state !== 'failed').length;
      this.metrics.syncProgress('catalog', done, Math.max(1, outcomes.length));
      const anyFailed = outcomes.some((o) => o.state === 'failed');
      this.metrics.syncFinished('catalog', anyFailed ? 'failed' : 'ok');
      return outcomes;
    } catch (error: unknown) {
      this.metrics.syncFinished('catalog', 'failed');
      throw error;
    }
  }
}
