import { join } from 'node:path';
import type {
  JobActionTypeT,
  JobBulkActionRequestT,
  JobBulkActionResponseT,
  JobState,
  JobT,
  LaneId,
} from '@fmd/contract';
import { ApiError } from '../api/errors.js';
import type {
  JobCreateInput,
  JobRecord,
  JobService,
  JobsListOptions,
  JobsPage,
} from '../api/services.js';
import { IdempotencyConflictError, isTerminalJobState, type JobTransitionDetail } from '../jobs/queue/index.js';
import type { DownloadChapterJob } from '../jobs/queue/payloads.js';
import {
  LaneRunner,
  type JobQueue,
  type LaneHandler,
  type LaneHandlerOutcome,
  type LaneRunnerLaneOptions,
  type QueueJob,
} from '../jobs/queue/queue.js';
import { DownloadChapterRunner } from '../jobs/download/download-runner.js';
import { ConcurrentImageWorkerPool } from '../jobs/download/image-worker-pool.js';
import { PerHostSiteLimiter } from '../jobs/download/site-limiter.js';
import type { HostPacerPort } from '../jobs/host-pacing.js';
import { indexFileName } from '../jobs/download/filenames.js';
import { readMarkers, writeMarkers } from '../jobs/download/marker-store.js';
import { createPacker } from '../jobs/packers/index.js';
import {
  applyOutputRenameOptions,
  DEFAULT_CHAPTER_NAME_TEMPLATE,
  formatChapterNumbering,
  resolveChapterFileName,
  sanitizeFileName,
  truncateKeepTail,
  urlSegment,
} from '../jobs/library/filenames.js';
import { SqliteLibraryStore } from '../jobs/library/store.js';
import type { OutputDefaultsT, PerformanceSettingsT } from '../api/schemas.js';
import type { FileNamePolicyMode, ChapterDownloadedData } from '@fmd/contract';
import type { WsHub } from '../api/ws/hub.js';
import type {
  EngineDownloadOptions,
  ModuleDownloadHooks,
} from '../engine/facade.js';

/**
 * The production download path (DESIGN §4/§7.1): the §10 JobService port
 * drops onto the SQLite queue (download lane), a LaneRunner slot runs
 * the chapter through the REAL pipeline — engine hooks (GetPageNumber /
 * GetImageURL) → 'W'/'D' markers persisted in the work dir → image
 * downloads → ZIP pack → atomic library finalize — and every queue
 * mutation is published as a `/ws` job snapshot (D19 clients see
 * queued → running → retry → done/failed/cancelled live).
 *
 * Idempotency (§10): identical-key replay returns the ORIGINAL job
 * while it is live (queued/running/retry); a TERMINAL row is
 * superseded by a chained re-enqueue (`<key>#<n>`, first free slot) —
 * FMD2's re-download semantic: enqueueing a cancelled/failed chapter
 * again starts a fresh job that resumes from the persisted markers.
 */

/** Map one queue row onto the §10/WS `Job` wire shape. */
export function toJobWire(job: QueueJob, idempotencyKey?: string): JobT {
  const payload: Record<string, unknown> = { ...job.payload };
  return {
    id: job.id,
    type: 'download',
    moduleId: typeof payload['moduleId'] === 'string' ? payload['moduleId'] : '',
    payload,
    state: job.state,
    priority: job.priority,
    ...(job.progress !== undefined ? { progress: { ...job.progress } } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(job.paused ? { paused: true } : {}),
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

function toJobRecord(job: QueueJob, idempotencyKey?: string): JobRecord {
  const wire = toJobWire(job, idempotencyKey);
  return {
    id: wire.id,
    type: 'download',
    moduleId: wire.moduleId,
    payload: wire.payload,
    state: wire.state,
    priority: wire.priority,
    ...(wire.progress !== undefined ? { progress: wire.progress } : {}),
    ...(wire.error !== undefined ? { error: wire.error } : {}),
    ...(wire.idempotencyKey !== undefined ? { idempotencyKey: wire.idempotencyKey } : {}),
    ...(wire.paused !== undefined ? { paused: wire.paused } : {}),
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
  };
}

/**
 * JobQueue decorator: every mutation that changes observable job state
 * (transition, cancel, progress) publishes the fresh row snapshot to
 * the §10 WS hub. The LaneRunner owns transitions through this wrapper,
 * so live clients see `running` on claim and the terminal state the
 * same instant the row flips.
 */
export class PublishingJobQueue implements JobQueue {
  constructor(
    private readonly inner: JobQueue,
    private readonly publish: (job: QueueJob) => void,
  ) {}

  enqueue(
    payload: Parameters<JobQueue['enqueue']>[0],
    opts?: Parameters<JobQueue['enqueue']>[1],
  ): ReturnType<JobQueue['enqueue']> {
    const result = this.inner.enqueue(payload, opts);
    this.publish(result.job);
    return result;
  }

  claim(lane: LaneId, opts?: { workerId?: string }): QueueJob | undefined {
    const job = this.inner.claim(lane, opts);
    if (job !== undefined) {
      this.publish(this.snapshot(job.id));
    }
    return job;
  }

  transition(jobId: string, to: JobState, detail?: JobTransitionDetail): QueueJob {
    const job = this.inner.transition(jobId, to, detail);
    this.publish(job);
    return job;
  }

  cancel(jobId: string): QueueJob {
    const job = this.inner.cancel(jobId);
    this.publish(job);
    return job;
  }

  resume(jobId: string): QueueJob {
    const job = this.inner.resume(jobId);
    this.publish(job);
    return job;
  }

  hold(jobId: string): QueueJob {
    const job = this.inner.hold(jobId);
    this.publish(job);
    return job;
  }

  /**
   * Delete the row. NOT published: the D19 WS protocol carries job
   * snapshots only (no deletion frame), so re-broadcasting the
   * pre-delete snapshot would resurrect a ghost in live caches —
   * deleting clients refetch the list instead.
   */
  remove(jobId: string): QueueJob {
    return this.inner.remove(jobId);
  }

  byIdempotencyKey(key: string): QueueJob | undefined {
    return this.inner.byIdempotencyKey(key);
  }

  updateProgress(jobId: string, progress: { readonly [key: string]: string | number | boolean | null }): void {
    this.inner.updateProgress(jobId, progress);
    // progress is COALESCED in-memory (§4 ≤1 durable flush/sec/job) — the
    // persisted row may lag; publish the LIVE snapshot instead.
    const row = this.inner.get(jobId);
    if (row === undefined) {
      throw new Error(`publish: job ${jobId} vanished`);
    }
    const live = this.inner.progressOf(jobId);
    this.publish(live !== undefined ? { ...row, progress: live } : row);
  }

  progressOf(jobId: string): ReturnType<JobQueue['progressOf']> {
    return this.inner.progressOf(jobId);
  }

  get(jobId: string): QueueJob | undefined {
    return this.inner.get(jobId);
  }

  list(opts?: { state?: JobState; lane?: LaneId; limit?: number }): QueueJob[] {
    return this.inner.list(opts);
  }

  counts(lane?: LaneId): Record<JobState, number> {
    return this.inner.counts(lane);
  }

  pruneRetention(now?: number): number {
    return this.inner.pruneRetention(now);
  }

  recoverOrphans(now?: number): number {
    return this.inner.recoverOrphans(now);
  }

  staleRunningJobs(olderThanMs: number, now?: number): QueueJob[] {
    return this.inner.staleRunningJobs(olderThanMs, now);
  }

  close(): void {
    this.inner.close();
  }

  private snapshot(jobId: string): QueueJob {
    const job = this.inner.get(jobId);
    if (job === undefined) {
      throw new Error(`publish: job ${jobId} vanished`);
    }
    return job;
  }
}

/** The §10 JobService port over the SQLite download lane. */
export class RuntimeJobService implements JobService {
  constructor(
    private readonly queue: JobQueue,
    /** In-flight cancellation for RUNNING rows (the lane's registry). */
    private readonly cancelRunning: (jobId: string) => boolean,
    /**
     * Downloads-parity delete(+data) seam: removes the finalized
     * artifact (library file + `library_files` row) recorded at
     * `progress.libraryPath` by a finished job. Returns whether an
     * artifact existed and was removed.
     */
    private readonly deleteArtifact: (path: string) => boolean = (): boolean => false,
  ) {}

  createDownload(input: JobCreateInput, idempotencyKey?: string): { job: JobRecord; replayed: boolean } {
    const payload = {
      type: 'download',
      moduleId: input.moduleId,
      mangaUrl: input.mangaUrl,
      ...(input.mangaTitle !== undefined ? { mangaTitle: input.mangaTitle } : {}),
      chapterLink: input.chapterLink,
      ...(input.chapterName !== undefined ? { chapterName: input.chapterName } : {}),
      ...(input.chapterPosition !== undefined ? { chapterPosition: input.chapterPosition } : {}),
      ...(input.saveTo !== undefined ? { saveTo: input.saveTo } : {}),
    } as const;
    try {
      const result = this.queue.enqueue(payload, {
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(input.paused === true ? { paused: true } : {}),
      });
      if (!result.replayed) {
        return { job: toJobRecord(result.job, idempotencyKey), replayed: false };
      }
      // §10 replay — live rows return the original; a TERMINAL original
      // is superseded by a chained fresh attempt (re-download semantic).
      if (!isTerminalJobState(result.job.state)) {
        return { job: toJobRecord(result.job, idempotencyKey), replayed: true };
      }
      const chained = this.enqueueChained(payload, idempotencyKey);
      return {
        job: toJobRecord(chained.job, chained.key ?? idempotencyKey),
        replayed: chained.replayed,
      };
    } catch (error: unknown) {
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(409, 'conflict', error.message);
      }
      throw error;
    }
  }

  /** First free `<key>#<n>` slot (probe; bounded) → fresh queued row. */
  private enqueueChained(
    payload: DownloadChapterJob,
    baseKey: string | undefined,
  ): { job: QueueJob; key?: string; replayed: boolean } {
    if (baseKey === undefined) {
      const result = this.queue.enqueue(payload);
      return { job: result.job, replayed: false };
    }
    for (let n = 1; n <= 64; n += 1) {
      const chainKey = `${baseKey}#${String(n)}`;
      const existing = this.queue.byIdempotencyKey(chainKey);
      if (existing !== undefined) {
        // a LIVE chained row is the re-download in flight — replay it
        // (double-submit protection extends across the chain)
        if (!isTerminalJobState(existing.state)) {
          return { job: existing, key: chainKey, replayed: true };
        }
        continue; // superseded terminal attempt — probe the next slot
      }
      const result = this.queue.enqueue(payload, { idempotencyKey: chainKey });
      if (!result.replayed) {
        return { job: result.job, key: chainKey, replayed: false };
      }
      // Lost a race for this slot — probe the next one.
    }
    throw new ApiError(409, 'conflict', `idempotency key chain exhausted for ${JSON.stringify(baseKey)}`);
  }

  get(id: string): JobRecord | undefined {
    const job = this.queue.get(id);
    return job === undefined || job.lane !== 'download' ? undefined : toJobRecord(job);
  }

  list(opts: JobsListOptions): JobsPage {
    let boundaryId = Number.MAX_SAFE_INTEGER;
    if (opts.cursor !== undefined) {
      const raw = Number.parseInt(Buffer.from(opts.cursor, 'base64url').toString('utf8'), 10);
      if (!Number.isInteger(raw) || raw < 0) {
        throw new ApiError(400, 'bad_request', 'invalid jobs cursor');
      }
      boundaryId = raw;
    }
    // Downloads-parity filters (web multi-select / search / date-added
    // window): applied in-memory over the lane rows — the job table is
    // retention-bounded, so a JS filter pass is the honest scope.
    const needle = opts.q !== undefined && opts.q !== '' ? opts.q.toLowerCase() : undefined;
    const fromMs =
      opts.addedFrom !== undefined ? Date.parse(`${opts.addedFrom}T00:00:00.000Z`) : undefined;
    const toMs =
      opts.addedTo !== undefined ? Date.parse(`${opts.addedTo}T23:59:59.999Z`) : undefined;
    // R5 arrival: last-transition (updatedAt ms) floor — with
    // state=done the "finished since" set for the away summary.
    const sinceMs = opts.since !== undefined ? Date.parse(opts.since) : undefined;
    const all = this.queue
      .list({ ...(opts.state !== undefined ? { state: opts.state } : {}), lane: 'download' })
      .filter((job): boolean => Number(job.id) < boundaryId)
      .filter((job): boolean => opts.states === undefined || opts.states.includes(job.state))
      .filter((job): boolean => {
        if (needle === undefined) {
          return true;
        }
        const payload = job.payload as Record<string, unknown>;
        const title = typeof payload['mangaTitle'] === 'string' ? payload['mangaTitle'] : '';
        const chapter = typeof payload['chapterName'] === 'string' ? payload['chapterName'] : '';
        return title.toLowerCase().includes(needle) || chapter.toLowerCase().includes(needle);
      })
      .filter((job): boolean => {
        if (fromMs === undefined && toMs === undefined) {
          return true;
        }
        if (Number.isNaN(job.createdAt)) {
          return false;
        }
        return (fromMs === undefined || job.createdAt >= fromMs) && (toMs === undefined || job.createdAt <= toMs);
      })
      .filter((job): boolean => sinceMs === undefined || job.updatedAt >= sinceMs)
      .sort((a, b): number => Number(b.id) - Number(a.id));
    const page = all.slice(0, opts.limit);
    const last = page.at(-1);
    if (page.length < all.length && last !== undefined) {
      return {
        jobs: page.map((job): JobRecord => toJobRecord(job)),
        nextCursor: Buffer.from(String(last.id), 'utf8').toString('base64url'),
      };
    }
    return { jobs: page.map((job): JobRecord => toJobRecord(job)) };
  }

  cancel(id: string): JobRecord {
    const job = this.queue.get(id);
    if (job === undefined || job.lane !== 'download') {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    if (isTerminalJobState(job.state)) {
      throw new ApiError(409, 'conflict', `job ${id} is ${job.state} — nothing to cancel`);
    }
    if (job.state === 'running') {
      this.cancelRunning(id);
    }
    return toJobRecord(this.queue.cancel(id));
  }

  /** cbAddAsStopped parity: lift the hold on a live row (queued+paused → claimable). */
  resume(id: string): JobRecord {
    const job = this.queue.get(id);
    if (job === undefined || job.lane !== 'download') {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    if (isTerminalJobState(job.state)) {
      throw new ApiError(409, 'conflict', `job ${id} is ${job.state} — nothing to resume`);
    }
    return toJobRecord(this.queue.resume(id));
  }

  // ── downloads-tab task actions (FMD2 pmDownload parity, web-adapted) ──
  // State matrix (rows = §7.1 state × hold; ★ = the FMD2 origin menu):
  //
  //   state      | pause★   | resume★  | retry | redownload★ | disable★ | enable★
  //   queued     | hold     | lift/-op | 409   | 409         | hold     | lift/-op
  //   queued+held| -op      | lift     | 409   | 409         | -op      | lift
  //   running    | cancel   | 409      | 409   | 409         | 409      | 409
  //   retry      | cancel   | 409      | 409   | 409         | 409      | 409
  //   done       | 409      | 409      | 409   | re-enqueue  | 409      | 409
  //   failed     | 409      | 409      | re-enqueue | 409    | 409      | 409
  //   cancelled  | 409      | re-enqueue | 409 | 409         | 409      | 409
  //
  // (`-op` = idempotent no-op returning the row.) pause on a live row is
  // the FMD2 STOP analog (markers persist — resume re-enqueues and skips
  // already-downloaded images); disable/enable are the DISABLED analog
  // for scheduled-but-not-running rows. re-enqueue = fresh chained
  // attempt under `<key>#<n>` (createDownload's re-download semantic).

  /** The download-lane row for `id`, or undefined (404 mapping input). */
  private downloadRow(id: string): QueueJob | undefined {
    const job = this.queue.get(id);
    return job !== undefined && job.lane === 'download' ? job : undefined;
  }

  /** Typed 409 envelope for an action the row's state does not admit. */
  private illegalAction(id: string, action: JobActionTypeT, job: QueueJob): ApiError {
    return new ApiError(
      409,
      'conflict',
      `cannot ${action} job ${id} in state ${job.state}${job.paused ? ' (held)' : ''}`,
      { job: { id, state: job.state, paused: job.paused }, action },
    );
  }

  /** Fresh chained attempt for a terminal row (resumes from markers).
   * A LIVE chained row replays (no duplicate) — `replayed: true`. */
  private reenqueue(job: QueueJob): { job: JobRecord; replayed: boolean } {
    const chained = this.enqueueChained(
      job.payload.type === 'download'
        ? job.payload
        : { type: 'download', moduleId: '', mangaUrl: '', chapterLink: '' },
      job.idempotencyKey,
    );
    return {
      job: toJobRecord(chained.job, chained.key ?? job.idempotencyKey),
      replayed: chained.replayed,
    };
  }

  action(id: string, type: JobActionTypeT): JobRecord {
    const job = this.downloadRow(id);
    if (job === undefined) {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    switch (type) {
      case 'pause':
      case 'disable': {
        if (job.state === 'queued') {
          return job.paused ? toJobRecord(job) : toJobRecord(this.queue.hold(id));
        }
        if (type === 'pause' && (job.state === 'running' || job.state === 'retry')) {
          if (job.state === 'running') {
            this.cancelRunning(id);
          }
          return toJobRecord(this.queue.cancel(id));
        }
        break;
      }
      case 'resume':
      case 'enable': {
        if (job.state === 'queued') {
          return job.paused ? toJobRecord(this.queue.resume(id)) : toJobRecord(job);
        }
        if (type === 'resume' && job.state === 'cancelled') {
          return this.reenqueue(job).job;
        }
        break;
      }
      case 'retry': {
        if (job.state === 'failed') {
          return this.reenqueue(job).job;
        }
        break;
      }
      case 'redownload': {
        if (job.state === 'done') {
          return this.reenqueue(job).job;
        }
        break;
      }
    }
    throw this.illegalAction(id, type, job);
  }

  /** Delete the row (any state); `data: true` also removes the artifact. */
  remove(id: string, opts: { readonly data?: boolean } = {}): { job: JobRecord; dataDeleted: boolean } {
    const job = this.downloadRow(id);
    if (job === undefined) {
      throw new ApiError(404, 'not_found', `unknown job: ${id}`);
    }
    if (job.state === 'running') {
      this.cancelRunning(id);
    }
    let dataDeleted = false;
    if (opts.data === true) {
      const live = this.queue.progressOf(id) ?? job.progress;
      const path =
        live !== undefined && typeof live['libraryPath'] === 'string' ? (live['libraryPath'] as string) : '';
      if (path !== '') {
        dataDeleted = this.deleteArtifact(path);
      }
    }
    return { job: toJobRecord(this.queue.remove(id)), dataDeleted };
  }

  /**
   * Toolbar bulk ops (FMD2 tsDownload toolbar, frmMain.lfm:291-339):
   * pause all (Stop All) / resume all (Resume All) over scope `all`;
   * delete over scope `completed` (Delete completed — FMD2
   * RemoveAllFinishedTasks removes STATUS_FINISH rows only). Idempotent:
   * a settled queue reports `affected: 0`.
   */
  bulkAction(request: JobBulkActionRequestT): JobBulkActionResponseT {
    const { action, scope } = request;
    if ((action === 'pause' || action === 'resume') && scope !== 'all') {
      throw new ApiError(400, 'bad_request', `scope "${scope}" does not apply to bulk ${action} — use "all"`);
    }
    if (action === 'delete' && scope !== 'completed') {
      throw new ApiError(400, 'bad_request', `scope "${scope}" does not apply to bulk delete — use "completed"`);
    }
    const rows = this.queue.list({ lane: 'download' });
    const touched: JobRecord[] = [];
    for (const job of rows) {
      try {
        if (action === 'pause') {
          if (job.state === 'queued' && !job.paused) {
            touched.push(toJobRecord(this.queue.hold(job.id)));
          } else if (job.state === 'running' || job.state === 'retry') {
            if (job.state === 'running') {
              this.cancelRunning(job.id);
            }
            touched.push(toJobRecord(this.queue.cancel(job.id)));
          }
        } else if (action === 'resume') {
          if (job.state === 'queued' && job.paused) {
            touched.push(toJobRecord(this.queue.resume(job.id)));
          } else if (job.state === 'cancelled') {
            // Chain-aware: a LIVE chained row replays — only FRESH
            // re-enqueues count (a settled queue reports affected: 0).
            const resumed = this.reenqueue(job);
            if (!resumed.replayed) {
              touched.push(resumed.job);
            }
          }
        } else if (job.state === 'done') {
          this.remove(job.id);
          touched.push(toJobRecord(job));
        }
      } catch {
        // Best-effort bulk: a row that raced away (retention prune,
        // concurrent delete) is skipped, not fatal — the count stays
        // truthful for what THIS pass touched.
      }
    }
    return { action, scope, affected: touched.length, jobs: touched };
  }
}

/** Live chapter runs by queue job id — the cancel endpoint's reach-in. */
export class ActiveDownloadRegistry {
  private readonly runs = new Map<string, () => void>();

  register(jobId: string, cancel: () => void): void {
    this.runs.set(jobId, cancel);
  }

  unregister(jobId: string): void {
    this.runs.delete(jobId);
  }

  /** Returns false when no live run holds the id (queued row: nothing to abort). */
  cancel(jobId: string): boolean {
    const cancel = this.runs.get(jobId);
    if (cancel === undefined) {
      return false;
    }
    cancel();
    return true;
  }

  get size(): number {
    return this.runs.size;
  }
}

export interface DownloadLaneDeps {
  readonly queue: JobQueue;
  readonly wsHub: WsHub;
  readonly library: SqliteLibraryStore;
  /** `<dataDir>` — downloads work dirs + the library root live under it. */
  readonly dataDir: string;
  readonly engine: EngineDownloadOptions;
  /**
   * ENGINE SUBSTRATE SEAM (engine-boundary story): the §7.1 download-event
   * hooks factory. Defaults to the wasmoon-backed EngineDownloadHooks; the
   * assembly injects the ModuleRuntime substrate's factory (the
   * stub-substrate boot proof substitutes scripted hooks here).
   */
  readonly createHooks?: (
    moduleId: string,
    options: EngineDownloadOptions,
  ) => Promise<ModuleDownloadHooks>;
  readonly active: ActiveDownloadRegistry;
  readonly log: (message: string) => void;
  /** Per-image retry budget (default 2 — FMD2 RetryCount analog). */
  readonly imageRetryBudget?: number;
  /**
   * Output defaults read seam (PUT /api/settings/output): consulted
   * per-job at pack/finalize time so a settings change applies to NEW
   * jobs only. Defaults to zip + no rename template.
   */
  readonly outputDefaults?: () => OutputDefaultsT;
  /**
   * [parity-sweep] M10: Performance knobs read per-job (PUT
   * /api/settings/performance): retryCount = the per-image budget,
   * threadsPerChapter = the image-worker width. Absent = the
   * pre-settings truth (2 / 1).
   */
  readonly performance?: () => PerformanceSettingsT;
  /**
   * [parity-sweep] M4: filename-policy mode provider — the ASSEMBLY
   * composes the precedence (env > setting > parity default) and hands
   * the lane a resolved mode; undefined keeps env resolution inside
   * the contract's applyFileNamePolicy.
   */
  readonly fileNamePolicy?: () => FileNamePolicyMode | undefined;
  /** [parity-sweep] M10: download-lane slot count (applies at start). */
  readonly parallelChapters?: number;
  /**
   * [pipe-health] Per-host pacing (DESIGN-NORTHSTAR §2 PIPE): awaited
   * before a claimed job's first module hop — concurrent jobs whose
   * modules share a RootURL host are spaced (no bursts that trip
   * anti-bot) while different hosts proceed in parallel. Absent =
   * unpaced (hermetic tests; the pacing unit tests pin the spacing).
   */
  readonly pacer?: HostPacerPort;
  /**
   * Outbound-webhook seam (D1 §3 pipeline: scheduler → download →
   * library → webhook): invoked ONCE per finalized chapter with the
   * `chapter.downloaded` payload (individual — never coalesced). The
   * notifier's emit is fire-and-forget and never throws by contract;
   * the lane guards the call anyway (a notification must never take
   * the download path down). Absent = no webhook wired (hermetic
   * lane tests).
   */
  readonly onChapterDownloaded?: (data: ChapterDownloadedData) => void;
}

/** Deterministic work-dir segment for a URL's tail (path-safe) — the
 * shared derivation now lives in jobs/library/filenames.ts (urlSegment). */

const DOWNLOAD_STAGE = 'download';

/**
 * Downloads parity: sliding-window transfer-rate meter (FMD2 shows the
 * HTTP rate while a task is in DOWNLOAD). Cumulative byte ticks over
 * the last ~5s window → bytes/second; before two samples (or once the
 * window goes quiet) the rate is undefined and the progress payload
 * simply omits it.
 */
export class TransferRateMeter {
  private static readonly WINDOW_MS = 5000;

  private readonly samples: { at: number; totalBytes: number }[] = [];
  private totalBytes = 0;

  add(byteLength: number, now = Date.now()): void {
    this.totalBytes += byteLength;
    this.samples.push({ at: now, totalBytes: this.totalBytes });
    const cutoff = now - TransferRateMeter.WINDOW_MS;
    while (this.samples.length > 2 && (this.samples[0]?.at ?? now) < cutoff) {
      this.samples.shift();
    }
  }

  /** Windowed bytes/second (undefined until two samples / after quiet). */
  bytesPerSecond(now = Date.now()): number | undefined {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined || this.samples.length < 2) {
      return undefined;
    }
    if (now - last.at > TransferRateMeter.WINDOW_MS) {
      return undefined; // window went quiet — no honest current rate
    }
    const elapsedSeconds = (last.at - first.at) / 1000;
    if (elapsedSeconds <= 0) {
      return undefined;
    }
    return Math.round((last.totalBytes - first.totalBytes) / elapsedSeconds);
  }
}

/**
 * The `download` lane: one slot runs one chapter end-to-end (claim →
 * download → pack → finalize → done). `concurrency: 1` — FMD2 serializes
 * a chapter's images; several chapters queue FIFO behind each other.
 */
export function downloadLane(deps: DownloadLaneDeps): LaneRunnerLaneOptions {
  const handler: LaneHandler = async (job, ctx): Promise<LaneHandlerOutcome> => {
    const payload = job.payload;
    if (payload.type !== 'download') {
      return { type: 'failed', kind: 'worker_stalled', error: `non-download payload on the download lane: ${payload.type}` };
    }
    const mangaSegment = urlSegment(payload.mangaTitle ?? payload.mangaUrl, 'manga');
    const chapterSegment = urlSegment(payload.chapterLink, 'chapter');
    const moduleSegment = sanitizeFileName(payload.moduleId);
    const workDir = join(deps.dataDir, 'downloads', moduleSegment, mangaSegment, chapterSegment);
    deps.log(`job ${job.id}: downloading ${payload.chapterLink} (work dir ${workDir})`);

    ctx.setProgress({ stage: 'prepare', done: 0, total: 0 });

    let hooks: ModuleDownloadHooks | undefined;
    let runner: DownloadChapterRunner | undefined;
    try {
      // Terminal-before-start race (cancel landed between claim and here).
      const current = deps.queue.get(job.id);
      if (current !== undefined && current.state === 'cancelled') {
        return { type: 'failed', kind: 'net', error: 'cancelled before start' };
      }

      // [pipe-health] Per-host pacing (DESIGN-NORTHSTAR §2 PIPE): the
      // claimed job's FIRST module hop waits for its host's bucket —
      // concurrent download jobs (and favorites checks, which share the
      // ONE pacer) whose modules resolve to the same RootURL host are
      // spaced ≥ intervalMs apart, never a synchronized burst, while
      // DIFFERENT hosts proceed in parallel. Acquired once per job
      // attempt (ahead of the module session), not per image: the
      // §7.1 image-level cadence is the runner's own retry/threads
      // business. Awaiting before any engine state is built keeps the
      // wait cancellable-cheap (cancel lands on the claim race above
      // or through the active registry below, and the pacer's FIFO
      // hands the token to the next waiter — the slot is never lost).
      if (deps.pacer !== undefined) {
        await deps.pacer.acquire(payload.moduleId);
      }

      // Default = the wasmoon-backed hooks, loaded lazily through the
      // production door (keeps the lane's static graph wasmoon-free for
      // substituted substrates; the assembly always injects createHooks).
      const createHooks =
        deps.createHooks ??
        (async (moduleId: string, options: EngineDownloadOptions): Promise<ModuleDownloadHooks> =>
          (await import('../engine/index.js')).EngineDownloadHooks.create(moduleId, options));
      hooks = await createHooks(payload.moduleId, deps.engine);
      const limiter = new PerHostSiteLimiter();
      const resumeMarkers = readMarkers(workDir);
      // Downloads parity: FMD2 shows the HTTP transfer rate while a
      // task is in DOWNLOAD — the meter feeds the WS progress payload.
      const rateMeter = new TransferRateMeter();
      runner = new DownloadChapterRunner(
        { module: hooks, pool: new ConcurrentImageWorkerPool(), limiter },
        {
          moduleId: payload.moduleId,
          mangaUrl: payload.mangaUrl,
          chapterLink: payload.chapterLink,
          ...(payload.chapterName !== undefined ? { chapterName: payload.chapterName } : {}),
          workDir,
          // [parity-sweep] M10: threads-per-chapter (FMD2
          // MaxThreadPerTaskLimit) + retry count, read per-job.
          maxThreadPerTaskLimit: deps.performance?.().threadsPerChapter ?? 1,
          ...(resumeMarkers !== undefined ? { resumeMarkers } : {}),
          imageRetryBudget: deps.performance?.().retryCount ?? deps.imageRetryBudget ?? 2,
          persistMarkers: (pageLinks): void => {
            writeMarkers(workDir, pageLinks);
            const done = pageLinks.filter((marker): boolean => marker === 'D').length;
            const rate = rateMeter.bytesPerSecond();
            ctx.setProgress({
              stage: DOWNLOAD_STAGE,
              done,
              total: pageLinks.length,
              ...(rate !== undefined ? { rate } : {}),
            });
          },
          onImageSaved: (_workId, byteLength): void => {
            rateMeter.add(byteLength);
          },
        },
      );
      deps.active.register(job.id, (): void => runner?.cancel('cancelled by user'));
      const result = await runner.run();
      deps.active.unregister(job.id);
      runner = undefined;

      if (result.state === 'cancelled') {
        deps.log(`job ${job.id}: cancelled (${result.done}/${result.total} images, markers persisted)`);
        // The row is already `cancelled` (the endpoint transitioned it);
        // this outcome is the benign no-op path.
        return { type: 'failed', kind: 'net', error: result.reason ?? 'cancelled' };
      }
      if (result.state === 'failed') {
        const detail = result.failures
          .slice(0, 3)
          .map((failure): string => `#${String(failure.workId)}: ${failure.reason}`)
          .join('; ');
        if (result.failures.length > 0) {
          // §7.1 running → retry: the next attempt resumes from the
          // persisted markers (files on disk are the truth).
          return {
            type: 'retry',
            error: `${String(result.failures.length)} image(s) failed — ${detail}`,
          };
        }
        return { type: 'failed', kind: 'net', error: result.reason ?? 'chapter download failed' };
      }

      // ── pack (§7.3): savedFiles in WorkId order → archive in the work dir ──
      // Format comes from the output defaults (FMD2 Save-to parity,
      // PUT /api/settings/output): the §7.3 packer set zip/cbz/pdf/epub,
      // read per-job so a settings change applies to NEW jobs only.
      // The seam-absent fallback carries the FROZEN scan-target
      // defaults (D1 §2 EXIT): cbz + '%NUMBERING% %CHAPTER%'.
      // Downloads parity: the progress stage carries the FMD2 status
      // palette names — COMPRESS for the zip/cbz packers, CONVERT for
      // pdf/epub (uBaseUnit task states).
      const output: OutputDefaultsT =
        deps.outputDefaults?.() ?? {
          format: 'cbz',
          chapterNameTemplate: DEFAULT_CHAPTER_NAME_TEMPLATE,
          unicodeReplacement: false,
          unicodeReplacementChar: '_',
          digitPadding: 0,
          removeMangaName: false,
        };
      const packStage: 'compress' | 'convert' =
        output.format === 'pdf' || output.format === 'epub' ? 'convert' : 'compress';
      ctx.setProgress({ stage: packStage, done: result.done, total: result.total });
      // [parity-sweep] M6/M8: digitPadding (FMD2 lfm:4026) sets the
      // minimum page-number width inside the archive entry names.
      const pages = result.savedFiles
        .map((filePath, workId): { workId: number; filePath: string; fileName: string } | undefined => {
          if (filePath === '') {
            return undefined;
          }
          const dot = filePath.lastIndexOf('.');
          const ext = dot === -1 ? 'jpg' : filePath.slice(dot + 1);
          return {
            workId,
            filePath,
            fileName: `${indexFileName(workId, output.digitPadding)}.${ext}`,
          };
        })
        .filter((page): page is { workId: number; filePath: string; fileName: string } => page !== undefined);

      // ── filename + folder BEFORE the pack (D1 §2 EXIT): ComicInfo
      // Series must equal the FINAL series folder, so the effective
      // folder resolves before the archive is built and rides the pack
      // as metadata — the archive and its eventual library path can
      // never disagree about the series.
      // [library-layout] the module is NOT a path segment: the default
      // target is `<libraryRoot>/<effective manga folder>/<file>` where
      // the effective folder is the clean sanitized title, or the
      // suffixed `<manga> [<module>]` duplicate form when a DIFFERENT
      // module already claims the title (computed once, persisted on
      // the favorite/ledger — never recomputed). saveTo (edSaveTo)
      // still REPLACES the computed prefix entirely, and no effective
      // folder is derived for an overridden download.
      // Filename: the FMD2 custom-rename template when the output
      // defaults carry one (edOptionMangaCustomRename parity — the
      // FROZEN default is '%NUMBERING% %CHAPTER%', D1 §7; '' keeps the
      // chapter-name fallback — the previous behavior). `<numbering>`
      // is the payload's 1-based list ordinal zero-padded FMD2-style
      // (uSilentThread.pas:338) — NEVER a number parsed from the
      // chapter title (D1 §5).
      const chapterLabel: string = payload.chapterName ?? chapterSegment;
      const websiteLabel: string =
        deps.engine.modules().find((m): boolean => m.id === payload.moduleId)?.name ?? '';
      const rawFileName: string =
        output.chapterNameTemplate !== ''
          ? resolveChapterFileName({
              template: output.chapterNameTemplate,
              chapterName: chapterLabel,
              website: websiteLabel,
              manga: payload.mangaTitle ?? mangaSegment,
              numbering: formatChapterNumbering(payload.chapterPosition, output.digitPadding),
              // [parity-sweep] M4: assembly-resolved policy mode
              // (env > setting > parity default).
              ...(deps.fileNamePolicy !== undefined && deps.fileNamePolicy() !== undefined
                ? { mode: deps.fileNamePolicy() }
                : {}),
            })
          : sanitizeFileName(chapterLabel) === ''
            ? chapterSegment
            : sanitizeFileName(chapterLabel);
      const fileName = truncateKeepTail(
        applyOutputRenameOptions(rawFileName, output, payload.mangaTitle ?? mangaSegment),
        120,
            );
      // [library-layout] rule 2: the effective folder (clean, or the
      // suffixed duplicate form when a different module claims the
      // title) — resolved ONLY for default-layout downloads; a saveTo
      // override replaces the prefix and derives nothing.
      const effectiveManga: string =
        payload.saveTo !== undefined
          ? mangaSegment
          : deps.library.resolveMangaFolder({
              moduleId: payload.moduleId,
              mangaUrl: payload.mangaUrl,
              segment: mangaSegment,
            });
      // ComicInfo Series = the containing folder's name (D1 §3
      // "folder name = ComicInfo Series"): the effective folder for
      // default-layout downloads, the saveTo target's last path
      // segment for an overridden one.
      const seriesName: string =
        payload.saveTo !== undefined
          ? (payload.saveTo.split(/[\\/]/).filter((s) => s !== '').at(-1) ?? payload.saveTo)
          : effectiveManga;
      const packed = await createPacker(output.format).pack(pages, {
        outputDir: workDir,
        ...(output.format === 'zip' || output.format === 'cbz'
          ? {
              comicInfo: {
                series: seriesName,
                title: chapterLabel,
                web: payload.mangaUrl,
                notes: websiteLabel,
              },
            }
          : {}),
      });

      // ── finalize (§7.1 step 5): atomic move + ledger + listing row ──
      const finalized = deps.library.finalize({
        manga: effectiveManga,
        fileName,
        ext: output.format,
        sourcePath: packed.filePath,
        ...(payload.saveTo !== undefined ? { saveTo: payload.saveTo } : {}),
      });
      deps.library.recordLibraryFile({
        moduleId: moduleSegment,
        manga: effectiveManga,
        fileName: `${fileName}.${output.format}`,
        path: finalized.path,
        bytes: finalized.bytes,
        // File-state provenance (one ledger truth): the row keys onto
        // the downloaded-chapters ledger identity (manga url + chapter
        // link) so per-title file listings never guess by path layout.
        mangaUrl: payload.mangaUrl,
        chapterLink: payload.chapterLink,
      });
      // §7.2 ledger dual-write (global row; favorite-side when the job
      // carries the favorites provenance key).
      deps.library.completeChapter({
        moduleId: payload.moduleId,
        url: payload.mangaUrl,
        chapterLinks: [payload.chapterLink],
        ...(payload.mangaKey !== undefined ? { mangaKey: payload.mangaKey } : {}),
      });
      deps.log(`job ${job.id}: done — ${finalized.path} (${String(finalized.bytes)}B, ${String(pages.length)} pages)`);
      // Downloads parity: the finalized artifact path rides the durable
      // progress snapshot — delete(+data) resolves it to remove the
      // library file alongside the job row.
      ctx.setProgress({
        stage: 'finalize',
        done: result.total,
        total: result.total,
        libraryPath: finalized.path,
      });
      // Outbound webhook (D1 §3): the individual chapter.downloaded
      // event — one per finalized chapter, fire-and-forget.
      if (deps.onChapterDownloaded !== undefined) {
        try {
          deps.onChapterDownloaded({
            moduleId: payload.moduleId,
            mangaTitle: payload.mangaTitle ?? mangaSegment,
            mangaUrl: payload.mangaUrl,
            chapterLink: payload.chapterLink,
            ...(payload.chapterName !== undefined && payload.chapterName !== ''
              ? { chapterName: payload.chapterName }
              : {}),
            ...(payload.chapterPosition !== undefined
              ? { chapterPosition: payload.chapterPosition }
              : {}),
            fileName: `${fileName}.${output.format}`,
            path: finalized.path,
            bytes: finalized.bytes,
            format: output.format,
            jobId: job.id,
          });
        } catch {
          // fire-and-forget by contract — never the download path's problem
        }
      }
      return { type: 'done' };
    } catch (error: unknown) {
      return {
        type: 'failed',
        kind: 'net',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      deps.active.unregister(job.id);
      if (hooks !== undefined) {
        await hooks.dispose();
      }
    }
  };

  // [parity-sweep] M10: parallelChapters (FMD2 simultaneous-chapter
  // parity) — the lane slot count is fixed at LaneRunner start, so the
  // value is read once at construction (server start); the UI documents
  // "applies on restart".
  return { concurrency: deps.parallelChapters ?? 1, handler };
}

/** Assemble the queue + lane runner pair (the runtime's download path). */
export function startDownloadLane(
  queue: JobQueue,
  deps: Omit<DownloadLaneDeps, 'queue'>,
): LaneRunner {
  const runner = new LaneRunner(queue, { lanes: { download: downloadLane({ ...deps, queue }) } });
  runner.start();
  return runner;
}
