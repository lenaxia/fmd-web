// @vitest-environment node

/**
 * [inbox] The Home feed API (D1 §2 INBOX — tsk-acidic-oxbow-waits)
 * over the REAL SqliteInboxService on a temp app.db: the §10 route
 * contract —
 *
 * - GET /api/inbox?view=new|archive serves the requested feed shape
 *   (view discriminator + newCount + entries) and NEVER mutates (a
 *   GET'd-twice feed is byte-identical — D1 §3);
 * - POST /api/inbox/ack acknowledges EXACTLY the named chapters
 *   (validation: non-empty bounded chapterKeys array);
 * - POST /api/inbox/caught-up stamps everything visible;
 * - the routes are NOT mounted when the seam is absent (the
 *   covers/metrics posture — API-only test fakes stay minimal);
 * - bad query/bodies are typed 400 error envelopes.
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildHarness } from './helpers.js';
import { SqliteInboxService, inboxChapterKey } from '../../src/runtime/inbox.js';
import { mkTmpDir, rmDir } from '../jobs/helpers.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const MANGA_URL = 'https://site.example/manga/x';

let dbFile = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
});

function openHarnessWithInbox(): { harness: ReturnType<typeof buildHarness>; service: SqliteInboxService } {
  const dir = mkTmpDir('inbox-api');
  dbFile = path.join(dir, 'app.db');
  const service = new SqliteInboxService(new Database(dbFile));
  const harness = buildHarness({ inbox: service });
  return { harness, service };
}

function seedArrivals(service: SqliteInboxService): void {
  service.record({
    moduleId: MODULE,
    mangaKey: `${MODULE}${MANGA_URL}`.toLowerCase(),
    mangaUrl: MANGA_URL,
    mangaTitle: 'Fixture Manga',
    coverLink: 'https://cdn.example/cover.jpg',
    chapters: [
      { link: 'https://site.example/ch/1', name: 'Ch. 1' },
      { link: 'https://site.example/ch/2', name: 'Ch. 2' },
      { link: 'https://site.example/ch/3', name: 'Ch. 3' },
    ],
    at: 1_000,
  });
  service.record({
    moduleId: 'b'.repeat(32),
    mangaKey: 'other',
    mangaUrl: 'https://other.example/manga/y',
    mangaTitle: 'Other Series',
    chapters: [{ link: 'https://other.example/ch/9', name: 'Ch. 9' }],
    at: 2_000,
  });
}

describe('Inbox API — the Home feed routes', () => {
  it('GET /api/inbox?view=new serves the unacknowledged feed with newCount', async () => {
    const h = openHarnessWithInbox();
    seedArrivals(h.service);

    const res = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=new' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      view: string;
      newCount: number;
      entries: Array<{ chapterLink: string; seenAt: string | null; mangaTitle: string | null }>;
    };
    expect(body.view).toBe('new');
    expect(body.newCount).toBe(4);
    expect(body.entries.map((e) => e.chapterLink)).toEqual([
      'https://other.example/ch/9',
      'https://site.example/ch/1',
      'https://site.example/ch/2',
      'https://site.example/ch/3',
    ]);
    expect(body.entries.every((e) => e.seenAt === null)).toBe(true);
    expect(body.entries[1]?.mangaTitle).toBe('Fixture Manga');
  });

  it('GET /api/inbox defaults to the new view (URL-as-truth default)', async () => {
    const h = openHarnessWithInbox();
    seedArrivals(h.service);

    const res = await h.harness.app.inject({ method: 'GET', url: '/api/inbox' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { view: string }).view).toBe('new');
  });

  it('GET /api/inbox is PURE — a second read is byte-identical (D1 §3 GET never mutates)', async () => {
    const h = openHarnessWithInbox();
    seedArrivals(h.service);
    h.service.acknowledge([inboxChapterKey(MODULE, 'https://site.example/ch/1')], Date.now() - 60_000);

    const first = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=archive' });
    const second = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=archive' });

    expect(`${String(first.statusCode)}|${first.body}`).toBe(`${String(second.statusCode)}|${second.body}`);
  });

  it('GET /api/inbox?view=archive serves acknowledged entries (seen stamps, newest first)', async () => {
    const h = openHarnessWithInbox();
    seedArrivals(h.service);
    h.service.acknowledge(
      [inboxChapterKey(MODULE, 'https://site.example/ch/1'), inboxChapterKey(MODULE, 'https://site.example/ch/2')],
      Date.now() - 60_000,
    );

    const res = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=archive' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      view: string;
      newCount: number;
      entries: Array<{ chapterLink: string; seenAt: string | null }>;
    };
    expect(body.view).toBe('archive');
    expect(body.newCount).toBe(2);
    expect(body.entries.map((e) => e.chapterLink)).toEqual([
      'https://site.example/ch/1',
      'https://site.example/ch/2',
    ]);
    expect(body.entries.every((e) => e.seenAt !== null)).toBe(true);
  });

  it('GET /api/inbox?view=<garbage> is a typed 400 (no silent view fallback on the WIRE)', async () => {
    const h = openHarnessWithInbox();
    const res = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=sideways' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('POST /api/inbox/ack acknowledges EXACTLY the named chapters', async () => {
    const h = openHarnessWithInbox();
    seedArrivals(h.service);

    const res = await h.harness.app.inject({
      method: 'POST',
      url: '/api/inbox/ack',
      payload: { chapterKeys: [inboxChapterKey(MODULE, 'https://site.example/ch/1')] },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { acknowledged: number }).acknowledged).toBe(1);
    const feed = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=new' });
    expect((feed.json() as { newCount: number }).newCount).toBe(3);
    const archive = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=archive' });
    expect((archive.json() as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('POST /api/inbox/ack with an unknown key reports 0 flipped (idempotent, never 404)', async () => {
    const h = openHarnessWithInbox();
    const res = await h.harness.app.inject({
      method: 'POST',
      url: '/api/inbox/ack',
      payload: { chapterKeys: ['no-such-key'] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { acknowledged: number }).acknowledged).toBe(0);
  });

  it('POST /api/inbox/ack validates the body (empty array / missing field / oversized)', async () => {
    const h = openHarnessWithInbox();
    for (const payload of [{ chapterKeys: [] }, {}, { chapterKeys: [''] }, { chapterKeys: Array<string>(501).fill('x') }]) {
      const res = await h.harness.app.inject({ method: 'POST', url: '/api/inbox/ack', payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('POST /api/inbox/caught-up stamps EVERY visible chapter', async () => {
    const h = openHarnessWithInbox();
    seedArrivals(h.service);

    const res = await h.harness.app.inject({ method: 'POST', url: '/api/inbox/caught-up' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { acknowledged: number }).acknowledged).toBe(4);
    const feed = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=new' });
    expect((feed.json() as { newCount: number }).newCount).toBe(0);
    const archive = await h.harness.app.inject({ method: 'GET', url: '/api/inbox?view=archive' });
    expect((archive.json() as { entries: unknown[] }).entries).toHaveLength(4);
    // idempotent: a second caught-up flips nothing
    const again = await h.harness.app.inject({ method: 'POST', url: '/api/inbox/caught-up' });
    expect((again.json() as { acknowledged: number }).acknowledged).toBe(0);
  });

  it('the routes are NOT mounted when the seam is absent (covers/metrics posture)', async () => {
    const harness = buildHarness();
    const getRes = await harness.app.inject({ method: 'GET', url: '/api/inbox' });
    expect(getRes.statusCode).toBe(404);
    const ackRes = await harness.app.inject({ method: 'POST', url: '/api/inbox/ack', payload: { chapterKeys: ['x'] } });
    expect(ackRes.statusCode).toBe(404);
    const caughtRes = await harness.app.inject({ method: 'POST', url: '/api/inbox/caught-up' });
    expect(caughtRes.statusCode).toBe(404);
  });
});
