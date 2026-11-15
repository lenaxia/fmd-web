import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadinessStatus } from '@fmd/contract';

/**
 * D20 first-run bootstrap (DESIGN.md D20): with an EMPTY data dir the
 * server auto-triggers module sync + catalog sync at boot, before it
 * reports ready. The stages are surfaced three ways:
 *
 * 1. log lines (`fmd: bootstrap: …`) — compose log assertions;
 * 2. `/readyz` 503 + a human `reason` while running (wait-on gates on
 *    the flip to 200);
 * 3. the SPA bootstrap banner, which polls /readyz and shows `reason`.
 *
 * Stage order: modules (lua tree sync) → registry (Init sweep) →
 * catalogs (7z fetch + atomic install). Every stage is SKIPPED when its
 * artifact is already installed, so restarts over a populated data dir
 * (or a partially completed bootstrap) resume instead of re-syncing.
 *
 * Explicit opt-out (D20 disable switch): `FMD_BOOTSTRAP_DISABLE=1`
 * (wired as `BootstrapDeps.disabled`) skips the ENTIRE first-run sync —
 * `run()` short-circuits to `done` without touching module sync, the
 * registry sweep or the catalog syncs; readiness reports ready and the
 * operator owns provisioning (sync via POST /api/sync/modules +
 * /api/sync/catalog/… afterwards). The runtime pairs the flag with
 * dropping the lua-tree readiness check, so /readyz is green on an
 * empty data dir.
 */

export interface BootstrapDeps {
  /** Data dir (receipt/tree existence = the empty-dir test). */
  readonly dataDir: string;
  /** Module sync (fetch → stage → validate → atomic swap). */
  readonly syncModules: () => Promise<{ sha: string; report: { modules: number } }>;
  /** Registry boot (Init sweep, SHA-gated). */
  readonly bootRegistry: () => Promise<{ source: string; modules: number }>;
  /** Catalog sync for one id (fetch 7z → extract → install). */
  readonly syncCatalog: (id: string) => Promise<{ state: string; error?: string }>;
  /** Catalog ids the bootstrap installs (FMD_BOOTSTRAP_CATALOGS). */
  readonly catalogIds: readonly string[];
  /**
   * §6.1 update check (commits API) before the per-id blob syncs —
   * the real pipeline's ONE-call check; the bootstrap asserts it ran.
   */
  readonly checkCatalogUpdates: () => Promise<{ changed: boolean; headSha: string }>;
  /** Log sink (the entry point prefixes `fmd: `). */
  readonly log: (message: string) => void;
  /** Cancelled flag check between stages (SIGTERM drain). */
  readonly isCancelled?: () => boolean;
  /**
   * D20 disable switch (`FMD_BOOTSTRAP_DISABLE=1`, wired from
   * RuntimeConfig): `run()` short-circuits to `done` — module sync,
   * registry sweep and catalog syncs never fire (zero upstream
   * traffic, zero enqueued work) and readiness reports ready. The
   * operator provisions the data dir (or syncs via the API) afterwards.
   */
  readonly disabled?: boolean;
  /**
   * Demo/e2e affordance: minimum wall time per stage (ms, default 0).
   * Real module/catalog syncs take minutes; local fixture syncs finish
   * in milliseconds, which would leave the D20 progress banner and the
   * compose bootstrap logs unobservable. scripts/e2e.sh sets this so
   * the progress surfaces are exercised; production leaves it 0.
   */
  readonly stageDelayMs?: number;
}

type Stage = 'idle' | 'modules' | 'registry' | 'catalogs' | 'done' | 'failed' | 'cancelled';

export class BootstrapRunner {
  private stage: Stage = 'idle';
  private failure: string | undefined;

  constructor(private readonly deps: BootstrapDeps) {}

  /** The /readyz probe input while bootstrap runs. */
  readiness(): ReadinessStatus {
    switch (this.stage) {
      case 'idle':
      case 'modules':
      case 'registry':
      case 'catalogs':
        return { ready: false, reason: `bootstrap: ${this.stage === 'idle' ? 'starting' : this.stage}…` };
      case 'failed':
        return { ready: false, reason: `bootstrap failed: ${this.failure ?? 'unknown error'}` };
      case 'cancelled':
        return { ready: false, reason: 'bootstrap cancelled (shutdown)' };
      case 'done':
        return { ready: true };
    }
  }

  get isDone(): boolean {
    return this.stage === 'done';
  }

  /** Run all stages. Never throws — failures flip readiness to failed. */
  async run(): Promise<void> {
    if (this.deps.disabled === true) {
      // D20 disable switch (FMD_BOOTSTRAP_DISABLE=1): the ENTIRE
      // first-run sync is skipped — no module sync, no registry sweep,
      // no catalog sync (zero upstream traffic, zero enqueued work).
      this.stage = 'done';
      this.deps.log(
        'bootstrap: disabled (FMD_BOOTSTRAP_DISABLE=1) — first-run sync skipped; operator owns provisioning',
      );
      return;
    }
    try {
      this.enter('modules');
      await this.pace();
      if (this.skippedModuleSync()) {
        this.deps.log('bootstrap: lua tree already installed — module sync skipped');
      } else {
        this.deps.log('bootstrap: empty data dir — running module sync (D20)');
        const result = await this.deps.syncModules();
        this.deps.log(
          `bootstrap: module sync installed sha ${result.sha.slice(0, 10)} (${String(result.report.modules)} modules)`,
        );
      }
      this.checkCancelled();

      this.enter('registry');
      await this.pace();
      const boot = await this.deps.bootRegistry();
      this.deps.log(
        `bootstrap: registry ready (${boot.source} sweep, ${String(boot.modules)} modules)`,
      );
      this.checkCancelled();

      this.enter('catalogs');
      await this.pace();
      // Only ids without an install receipt are synced — and the §6.1
      // update check fires once, before the first blob sync (a fully
      // populated data dir makes zero upstream traffic).
      const toSync: string[] = [];
      for (const id of this.deps.catalogIds) {
        const receipt = join(this.deps.dataDir, 'catalogs', `${id}.meta.json`);
        if (existsSync(receipt)) {
          this.deps.log(`bootstrap: catalog ${id} already installed — sync skipped`);
          continue;
        }
        toSync.push(id);
      }
      if (toSync.length > 0) {
        const check = await this.deps.checkCatalogUpdates();
        this.deps.log(
          `bootstrap: catalog update check — head ${check.headSha.slice(0, 10)} (${check.changed ? 'changed' : 'unchanged'})`,
        );
      }
      for (const id of toSync) {
        this.deps.log(`bootstrap: syncing catalog ${id}`);
        const result = await this.deps.syncCatalog(id);
        if (result.state === 'failed') {
          throw new Error(`catalog ${id} failed to install: ${result.error ?? 'unknown error'}`);
        }
        this.deps.log(`bootstrap: catalog ${id} ${result.state}`);
      }
      this.stage = 'done';
      this.deps.log(`bootstrap: done (${String(this.deps.catalogIds.length)} catalog(s) configured)`);
    } catch (error: unknown) {
      if (this.stage === 'cancelled') {
        return;
      }
      this.failure = error instanceof Error ? error.message : String(error);
      this.stage = 'failed';
      this.deps.log(`bootstrap: FAILED — ${this.failure}`);
    }
  }

  /** SIGTERM during bootstrap: mark cancelled; stages stop between steps. */
  cancel(): void {
    if (this.stage !== 'done' && this.stage !== 'failed') {
      this.stage = 'cancelled';
      this.deps.log('bootstrap: cancelled by shutdown');
    }
  }

  private enter(stage: Stage): void {
    if (this.stage === 'cancelled') {
      this.deps.log('bootstrap: cancelled by shutdown');
      throw new Error('shutdown requested');
    }
    this.stage = stage;
    this.deps.log(`bootstrap: ${stage}…`);
  }

  /** The stage-delay affordance (cancellation-aware sleep). */
  private async pace(): Promise<void> {
    const delayMs = this.deps.stageDelayMs ?? 0;
    if (delayMs <= 0) {
      return;
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, delayMs);
    });
    this.checkCancelled();
  }

  private checkCancelled(): void {
    if (this.deps.isCancelled?.() === true) {
      this.stage = 'cancelled';
      this.deps.log('bootstrap: cancelled by shutdown');
      throw new Error('shutdown requested');
    }
  }

  private skippedModuleSync(): boolean {
    return (
      existsSync(join(this.deps.dataDir, 'lua', 'modules')) &&
      existsSync(join(this.deps.dataDir, 'sync-state.json'))
    );
  }
}
