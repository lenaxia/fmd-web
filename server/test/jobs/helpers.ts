/**
 * Job queue test helpers (offline, DESIGN.md §13): tmp-dir SQLite dbs
 * and the deterministic FakeClock harness — no sleeps, no sockets.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeClock } from '../../src/sync/db/rate-budget.js';
import { SqliteJobQueue } from '../../src/jobs/queue/queue.js';

/** Fresh temp dir per test (cleaned up in afterEach). */
export function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(`/tmp/opencode/${prefix}-`);
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface QueueHarness {
  readonly queue: SqliteJobQueue;
  readonly clock: FakeClock;
  readonly file: string;
  readonly dir: string;
}

export interface HarnessOptions {
  readonly flushIntervalMs?: number;
  readonly walAutocheckpointPages?: number;
  readonly recoverOnOpen?: boolean;
}

/** Open a queue harness: FakeClock + fresh `app.db` in `dir`. */
export function openHarness(dir: string, opts?: HarnessOptions): QueueHarness {
  const file: string = path.join(dir, 'app.db');
  const clock: FakeClock = new FakeClock();
  const queue: SqliteJobQueue = new SqliteJobQueue({
    file,
    clock,
    ...(opts?.flushIntervalMs !== undefined ? { flushIntervalMs: opts.flushIntervalMs } : {}),
    ...(opts?.walAutocheckpointPages !== undefined
      ? { walAutocheckpointPages: opts.walAutocheckpointPages }
      : {}),
    ...(opts?.recoverOnOpen !== undefined ? { recoverOnOpen: opts.recoverOnOpen } : {}),
  });
  return { queue, clock, file, dir };
}

/** Canonical download payload for tests. */
export function downloadPayload(chapterLink: string): {
  type: 'download';
  moduleId: string;
  mangaUrl: string;
  chapterLink: string;
} {
  return {
    type: 'download',
    moduleId: 'a'.repeat(32),
    mangaUrl: 'https://example.invalid/manga/x',
    chapterLink,
  };
}

/** A chapter-shaped coalesced progress snapshot. */
export function chapterProgress(chapterIndex: number, chapterTotal: number): {
  chapterIndex: number;
  chapterTotal: number;
} {
  return { chapterIndex, chapterTotal };
}
