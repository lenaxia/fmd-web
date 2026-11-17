/**
 * Runtime download lane — §10 semantics over the SQLite queue:
 * idempotent replay (live) vs chained re-enqueue (terminal), the §10
 * cancel transitions, and the WS publish mirroring (PublishingJobQueue).
 * The engine path (lua → pipeline → pack → library) is the phase-3
 * compose e2e's job (scripts/e2e.sh --phase3); these tests pin the
 * queue-semantics seams with the in-memory SQLite fixture queue.
 */
import { describe, expect, it } from 'vitest';
import { WsHub } from '../../src/api/ws/hub.js';
import {
  PublishingJobQueue,
  RuntimeJobService,
  ActiveDownloadRegistry,
  toJobWire,
} from '../../src/runtime/download-lane.js';
import type { SqliteJobQueue } from '../../src/jobs/queue/queue.js';
import { downloadPayload, mkTmpDir, openHarness, rmDir } from '../jobs/helpers.js';
import type { JobT } from '@fmd/contract';

const DOWNLOAD_PAYLOAD = downloadPayload('https://example.invalid/manga/x/1');

function makeService(): {
  service: RuntimeJobService;
  queue: PublishingJobQueue;
  active: ActiveDownloadRegistry;
  published: JobT[];
  dir: string;
  close(): void;
} {
  const dir: string = mkTmpDir('dl-lane-test');
  const sqlite: SqliteJobQueue = openHarness(dir).queue;
  const published: JobT[] = [];
  const queue = new PublishingJobQueue(sqlite, (job): void => {
    published.push(toJobWire(job));
  });
  const active = new ActiveDownloadRegistry();
  const service = new RuntimeJobService(queue, (jobId): boolean => active.cancel(jobId));
  return {
    service,
    queue,
    active,
    published,
    dir,
    close(): void {
      sqlite.close();
      rmDir(dir);
    },
  };
}

describe('RuntimeJobService (§10 idempotency over the SQLite lane)', (): void => {
  it('creates a download job (201 path) with the payload projected', (): void => {
    const { service, close } = makeService();
    try {
      const { job, replayed } = service.createDownload(
        {
          moduleId: DOWNLOAD_PAYLOAD.moduleId,
          mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl,
          chapterLink: DOWNLOAD_PAYLOAD.chapterLink,
          chapterName: 'Chapter 1: The Beginning',
        },
        'dl-key-1',
      );
      expect(replayed).toBe(false);
      expect(job.state).toBe('queued');
      expect(job.type).toBe('download');
      expect(job.payload['chapterName']).toBe('Chapter 1: The Beginning');
      expect(job.createdAt).toMatch(/^\d{4}-/);
    } finally {
      close();
    }
  });

  it('R5 arrival: list `since` floors on the row last transition (updatedAt)', (): void => {
    const { service, queue, close } = makeService();
    try {
      const base = {
        moduleId: DOWNLOAD_PAYLOAD.moduleId,
        mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl,
      };
      const a = service.createDownload(
        { ...base, chapterLink: DOWNLOAD_PAYLOAD.chapterLink },
        'since-key-1',
      );
      const b = service.createDownload(
        { ...base, chapterLink: 'https://example.invalid/manga/x/2' },
        'since-key-2',
      );
      // A terminal transition bumps updated_at (cancel → cancelled).
      // The harness clock is a FROZEN FakeClock — derive the floors from
      // the rows' own stamps instead of Date.now().
      queue.cancel(a.job.id);
      const stamp = Date.parse(b.job.updatedAt);
      const future = new Date(stamp + 60_000).toISOString();
      const past = new Date(stamp - 60_000).toISOString();
      // Nothing transitioned after `future` — the away-summary
      // 'nothing new' shape.
      expect(
        service.list({ since: future, limit: 10 }).jobs.map((job): string => job.id),
      ).toEqual([]);
      // Both rows transitioned (created) after `past`.
      const fresh = service.list({ since: past, limit: 10 }).jobs.map((job): string => job.id);
      expect(fresh).toContain(a.job.id);
      expect(fresh).toContain(b.job.id);
    } finally {
      close();
    }
  });

  it('replays the ORIGINAL live job on an identical key (200 path)', (): void => {
    const { service, close } = makeService();
    try {
      const input = {
        moduleId: DOWNLOAD_PAYLOAD.moduleId,
        mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl,
        chapterLink: DOWNLOAD_PAYLOAD.chapterLink,
      };
      const first = service.createDownload(input, 'key');
      const second = service.createDownload(input, 'key');
      expect(second.replayed).toBe(true);
      expect(second.job.id).toBe(first.job.id);
    } finally {
      close();
    }
  });

  it('409s key reuse with a different payload', (): void => {
    const { service, close } = makeService();
    try {
      service.createDownload(
        { moduleId: DOWNLOAD_PAYLOAD.moduleId, mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl, chapterLink: DOWNLOAD_PAYLOAD.chapterLink },
        'key',
      );
      expect((): unknown =>
        service.createDownload(
          { moduleId: DOWNLOAD_PAYLOAD.moduleId, mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl, chapterLink: 'http://site/manga/ch/2' },
          'key',
        ),
      ).toThrow(/different payload/);
    } finally {
      close();
    }
  });

  it('a TERMINAL original is superseded by a chained fresh attempt (re-download)', (): void => {
    const { service, queue, close } = makeService();
    try {
      const input = {
        moduleId: DOWNLOAD_PAYLOAD.moduleId,
        mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl,
        chapterLink: DOWNLOAD_PAYLOAD.chapterLink,
      };
      const first = service.createDownload(input, 'key');
      queue.cancel(first.job.id); // cancelled = terminal
      const again = service.createDownload(input, 'key');
      expect(again.replayed).toBe(false);
      expect(Number(again.job.id)).toBeGreaterThan(Number(first.job.id));
      expect(again.job.state).toBe('queued');
      // the third same-key create hits the LIVE chained row (replay) —
      // double-submit protection extends across the chain
      const third = service.createDownload(input, 'key');
      expect(third.replayed).toBe(true);
      expect(third.job.id).toBe(again.job.id);
    } finally {
      close();
    }
  });

  it('cancel: queued → cancelled; terminal → 409 conflict', (): void => {
    const { service, close } = makeService();
    try {
      const queued = service.createDownload({
        moduleId: DOWNLOAD_PAYLOAD.moduleId,
        mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl,
        chapterLink: DOWNLOAD_PAYLOAD.chapterLink,
      });
      const cancelled = service.cancel(queued.job.id);
      expect(cancelled.state).toBe('cancelled');
      expect(() => service.cancel(queued.job.id)).toThrow(/nothing to cancel/);
    } finally {
      close();
    }
  });

  it('list: newest-first with a stable keyset cursor', (): void => {
    const { service, close } = makeService();
    try {
      for (let i = 0; i < 3; i += 1) {
        service.createDownload({
          moduleId: DOWNLOAD_PAYLOAD.moduleId,
          mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl,
          chapterLink: `http://site/manga/ch/${String(i)}`,
        });
      }
      const page1 = service.list({ limit: 2 });
      expect(page1.jobs.map((job) => job.payload['chapterLink'])).toEqual([
        'http://site/manga/ch/2',
        'http://site/manga/ch/1',
      ]);
      expect(page1.nextCursor).toBeDefined();
      const page2 = service.list({ limit: 2, ...(page1.nextCursor !== undefined ? { cursor: page1.nextCursor } : {}) });
      expect(page2.jobs.map((job) => job.payload['chapterLink'])).toEqual(['http://site/manga/ch/0']);
      expect(page2.nextCursor).toBeUndefined();
    } finally {
      close();
    }
  });
});

describe('PublishingJobQueue (WS mirror)', (): void => {
  it('publishes a wire snapshot per mutation: enqueue, claim, progress, cancel', (): void => {
    const { service, queue, published, close } = makeService();
    try {
      const { job } = service.createDownload({
        moduleId: DOWNLOAD_PAYLOAD.moduleId,
        mangaUrl: DOWNLOAD_PAYLOAD.mangaUrl,
        chapterLink: DOWNLOAD_PAYLOAD.chapterLink,
      });
      expect(published.at(-1)?.state).toBe('queued');

      const claimed = queue.claim('download', { workerId: 'test' });
      expect(claimed?.id).toBe(job.id);
      expect(published.at(-1)?.state).toBe('running');

      queue.updateProgress(job.id, { done: 1, total: 3 });
      expect(published.at(-1)?.progress).toEqual({ done: 1, total: 3 });

      queue.cancel(job.id);
      expect(published.at(-1)?.state).toBe('cancelled');
      expect(published.length).toBeGreaterThanOrEqual(4);
    } finally {
      close();
    }
  });

  it('publish() output validates against the §10 Job wire schema (hub-compatible)', (): void => {
    const dir: string = mkTmpDir('dl-lane-test');
    const sqlite = openHarness(dir).queue;
    const hub = new WsHub();
    const queue = new PublishingJobQueue(sqlite, (job): void => {
      expect(() => hub.publish(toJobWire(job))).not.toThrow();
    });
    queue.enqueue(DOWNLOAD_PAYLOAD);
    queue.claim('download', { workerId: 'test' });
    sqlite.close();
    rmDir(dir);
  });
});
