import { join } from 'node:path';
import type { JobT, JobState, LaneId } from '@fmd/contract';
import { ApiError } from '../api/errors.js';
import type {
  JobCreateInput,
  JobRecord,
  JobService,
  JobsPage,
} from '../api/services.js';
import { IdempotencyConflictError, isTerminalJobState, type JobTransitionDetail } from '../jobs/queue/index.js';
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
import { indexFileName } from '../jobs/download/filenames.js';
import { readMarkers, writeMarkers } from '../jobs/download/marker-store.js';
import { ZipPacker } from '../jobs/packers/zip-packer.js';
import { SqliteLibraryStore } from '../jobs/library/store.js';
import { sanitizeFileName, truncateKeepTail } from '../jobs/library/filenames.js';
import type { WsHub } from '../api/ws/hub.js';
import { EngineDownloadHooks, type EngineDownloadOptions } from './download-engine.js';

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
  ) {}

  createDownload(input: JobCreateInput, idempotencyKey?: string): { job: JobRecord; replayed: boolean } {
    const payload = {
      type: 'download',
      moduleId: input.moduleId,
      mangaUrl: input.mangaUrl,
      ...(input.mangaTitle !== undefined ? { mangaTitle: input.mangaTitle } : {}),
      chapterLink: input.chapterLink,
      ...(input.chapterName !== undefined ? { chapterName: input.chapterName } : {}),
    } as const;
    try {
      const result = this.queue.enqueue(payload, idempotencyKey !== undefined ? { idempotencyKey } : undefined);
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
    payload: { type: 'download'; moduleId: string; mangaUrl: string; chapterLink: string; mangaTitle?: string; chapterName?: string },
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

  list(opts: { state?: JobRecord['state']; cursor?: string; limit: number }): JobsPage {
    let boundaryId = Number.MAX_SAFE_INTEGER;
    if (opts.cursor !== undefined) {
      const raw = Number.parseInt(Buffer.from(opts.cursor, 'base64url').toString('utf8'), 10);
      if (!Number.isInteger(raw) || raw < 0) {
        throw new ApiError(400, 'bad_request', 'invalid jobs cursor');
      }
      boundaryId = raw;
    }
    const all = this.queue
      .list({ ...(opts.state !== undefined ? { state: opts.state } : {}), lane: 'download' })
      .filter((job): boolean => Number(job.id) < boundaryId)
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
  readonly active: ActiveDownloadRegistry;
  readonly log: (message: string) => void;
  /** Per-image retry budget (default 2 — FMD2 RetryCount analog). */
  readonly imageRetryBudget?: number;
}

/** Deterministic work-dir segment for a URL's tail (path-safe). */
function urlSegment(url: string, fallback: string): string {
  const tail = url.split('?')[0]?.split('#')[0]?.split('/').filter((s) => s !== '').at(-1);
  let decoded = tail ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw tail (malformed escape)
  }
  const sanitized = sanitizeFileName(decoded);
  return sanitized === '' ? fallback : truncateKeepTail(sanitized, 80);
}

const DOWNLOAD_STAGE = 'download';

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

    let hooks: EngineDownloadHooks | undefined;
    let runner: DownloadChapterRunner | undefined;
    try {
      // Terminal-before-start race (cancel landed between claim and here).
      const current = deps.queue.get(job.id);
      if (current !== undefined && current.state === 'cancelled') {
        return { type: 'failed', kind: 'net', error: 'cancelled before start' };
      }

      hooks = await EngineDownloadHooks.create(payload.moduleId, deps.engine);
      const limiter = new PerHostSiteLimiter();
      const resumeMarkers = readMarkers(workDir);
      runner = new DownloadChapterRunner(
        { module: hooks, pool: new ConcurrentImageWorkerPool(), limiter },
        {
          moduleId: payload.moduleId,
          mangaUrl: payload.mangaUrl,
          chapterLink: payload.chapterLink,
          ...(payload.chapterName !== undefined ? { chapterName: payload.chapterName } : {}),
          workDir,
          maxThreadPerTaskLimit: 1,
          ...(resumeMarkers !== undefined ? { resumeMarkers } : {}),
          imageRetryBudget: deps.imageRetryBudget ?? 2,
          persistMarkers: (pageLinks): void => {
            writeMarkers(workDir, pageLinks);
            const done = pageLinks.filter((marker): boolean => marker === 'D').length;
            ctx.setProgress({ stage: DOWNLOAD_STAGE, done, total: pageLinks.length });
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

      // ── pack (§7.3): savedFiles in WorkId order → ZIP in the work dir ──
      ctx.setProgress({ stage: 'pack', done: result.done, total: result.total });
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
            fileName: `${indexFileName(workId)}.${ext}`,
          };
        })
        .filter((page): page is { workId: number; filePath: string; fileName: string } => page !== undefined);
      const packed = await new ZipPacker('zip').pack(pages, { outputDir: workDir });

      // ── finalize (§7.1 step 5): atomic move + ledger + listing row ──
      const chapterBase = sanitizeFileName(payload.chapterName ?? chapterSegment);
      const fileName = truncateKeepTail(chapterBase === '' ? chapterSegment : chapterBase, 120);
      const finalized = deps.library.finalize({
        moduleId: moduleSegment,
        manga: mangaSegment,
        fileName,
        ext: 'zip',
        sourcePath: packed.filePath,
      });
      deps.library.recordLibraryFile({
        moduleId: moduleSegment,
        manga: mangaSegment,
        fileName: `${fileName}.zip`,
        path: finalized.path,
        bytes: finalized.bytes,
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
      ctx.setProgress({ stage: 'finalize', done: result.total, total: result.total });
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

  return { concurrency: 1, handler };
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
