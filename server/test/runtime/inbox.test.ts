// @vitest-environment node

/**
 * Inbox store + service (D1 §2 INBOX — tsk-acidic-oxbow-waits): the
 * Home feed's persisted-truth semantics over a REAL better-sqlite3
 * temp database —
 *
 * 1. seen state is PER CHAPTER (chapter_key): each detected chapter
 *    is its own row, acknowledged individually;
 * 2. acknowledgment clears EXACTLY the acknowledged chapters (the
 *    others stay in the feed; unknown/already-seen keys flip nothing);
 * 3. caught-up stamps EVERY unacknowledged row (the shared bulk
 *    action — one write, all devices, D1 §4/R2);
 * 4. the archive serves acknowledged entries for a rolling 30-day
 *    window (older acknowledged entries leave the view; the physical
 *    purge removes exactly those, never an unacknowledged row);
 * 5. recording is idempotent per chapter_key (re-detection of a
 *    known chapter never duplicates a feed row nor resets its seen
 *    state — D1 §3 "idempotent detection");
 * 6. snapshots (title, cover) ride the row, so an entry survives its
 *    favorite's deletion — the inbox is a feed of arrivals, not a
 *    favorites join.
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  INBOX_ARCHIVE_WINDOW_MS,
  SqliteInboxService,
  inboxChapterKey,
  type InboxRecordInput,
} from '../../src/runtime/inbox.js';
import { mkTmpDir, rmDir } from '../jobs/helpers.js';

const MODULE = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const MANGA_URL = 'https://site.example/manga/x';
const MANGA_KEY = `${MODULE}${MANGA_URL}`.toLowerCase();

let dbFile = '';

afterEach(() => {
  if (dbFile !== '') rmDir(path.dirname(dbFile));
  dbFile = '';
});

function openService(): SqliteInboxService {
  const dir = mkTmpDir('inbox-store');
  dbFile = path.join(dir, 'app.db');
  return new SqliteInboxService(new Database(dbFile));
}

function arrival(
  overrides: Partial<InboxRecordInput> & { readonly chapters: ReadonlyArray<{ readonly link: string; readonly name: string }> },
  at: number,
): InboxRecordInput {
  return {
    moduleId: MODULE,
    mangaKey: MANGA_KEY,
    mangaUrl: MANGA_URL,
    mangaTitle: 'Fixture Manga',
    coverLink: 'https://cdn.example/cover.jpg',
    ...overrides,
    at,
  };
}

describe('SqliteInboxService — per-chapter seen state', () => {
  it('records one row per chapter, newest-first in the new view', () => {
    const inbox = openService();
    expect(
      inbox.record(
        arrival(
          {
            chapters: [
              { link: 'https://site.example/ch/1', name: 'Ch. 1' },
              { link: 'https://site.example/ch/2', name: 'Ch. 2' },
            ],
          },
          1_000,
        ),
      ),
    ).toBe(2);

    const feed = inbox.list('new', 2_000);
    expect(feed.newCount).toBe(2);
    expect(feed.entries.map((entry) => entry.chapterLink)).toEqual([
      // reverse-chronological: same detection batch → chapter_key ASC
      'https://site.example/ch/1',
      'https://site.example/ch/2',
    ]);
    expect(feed.entries.every((entry) => entry.seenAt === null)).toBe(true);
    expect(feed.entries[0]?.mangaTitle).toBe('Fixture Manga');
    expect(feed.entries[0]?.chapterLabel).toBe('Ch. 1');
    expect(feed.entries[0]?.chapterKey).toBe(
      inboxChapterKey(MODULE, 'https://site.example/ch/1'),
    );
  });

  it('orders later detections first (reverse-chronological feed)', () => {
    const inbox = openService();
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/1', name: 'Ch. 1' }] }, 1_000));
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/9', name: 'Ch. 9' }] }, 5_000));
    const feed = inbox.list('new', 6_000);
    expect(feed.entries.map((entry) => entry.chapterLink)).toEqual([
      'https://site.example/ch/9',
      'https://site.example/ch/1',
    ]);
  });

  it('acknowledges EXACTLY the named chapters — the others stay in the feed', () => {
    const inbox = openService();
    inbox.record(
      arrival(
        {
          chapters: [
            { link: 'https://site.example/ch/1', name: 'Ch. 1' },
            { link: 'https://site.example/ch/2', name: 'Ch. 2' },
            { link: 'https://site.example/ch/3', name: 'Ch. 3' },
          ],
        },
        1_000,
      ),
    );
    const key1 = inboxChapterKey(MODULE, 'https://site.example/ch/1');

    const flipped = inbox.acknowledge([key1], 9_000);

    expect(flipped).toBe(1);
    const feed = inbox.list('new', 9_500);
    expect(feed.newCount).toBe(2);
    expect(feed.entries.map((entry) => entry.chapterLink)).toEqual([
      'https://site.example/ch/2',
      'https://site.example/ch/3',
    ]);
    // the acknowledged chapter moved to the archive with its stamp
    const archive = inbox.list('archive', 9_500);
    expect(archive.entries.map((entry) => entry.chapterLink)).toEqual(['https://site.example/ch/1']);
    expect(archive.entries[0]?.seenAt).toBe(new Date(9_000).toISOString());
    // idempotent re-ack: nothing left to flip
    expect(inbox.acknowledge([key1], 9_600)).toBe(0);
    // unknown keys flip nothing
    expect(inbox.acknowledge(['no-such-key'], 9_700)).toBe(0);
  });

  it('caught-up stamps EVERY unacknowledged row (the shared bulk action)', () => {
    const inbox = openService();
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/1', name: 'Ch. 1' }] }, 1_000));
    inbox.record(
      arrival(
        {
          moduleId: 'b'.repeat(32),
          mangaKey: 'other-key',
          mangaUrl: 'https://other.example/manga/y',
          chapters: [{ link: 'https://other.example/ch/7', name: 'Ch. 7' }],
        },
        2_000,
      ),
    );

    expect(inbox.caughtUp(10_000)).toBe(2);
    expect(inbox.list('new', 10_500).newCount).toBe(0);
    expect(inbox.caughtUp(10_600)).toBe(0);
  });

  it('recording is idempotent per chapter_key — a re-detection neither duplicates nor resets', () => {
    const inbox = openService();
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/1', name: 'Ch. 1' }] }, 1_000));
    // acknowledged before the re-detection
    inbox.acknowledge([inboxChapterKey(MODULE, 'https://site.example/ch/1')], 2_000);

    // the next check sweep re-detects the same link (no auto-download:
    // the stored favorites list never learned it)
    const recorded = inbox.record(
      arrival({ chapters: [{ link: 'https://site.example/ch/1', name: 'Ch. 1' }] }, 3_000),
    );

    expect(recorded).toBe(0);
    const archive = inbox.list('archive', 3_500);
    expect(archive.entries).toHaveLength(1);
    // the ORIGINAL detection stamp survives (first arrival is the truth)
    expect(archive.entries[0]?.detectedAt).toBe(new Date(1_000).toISOString());
    expect(archive.entries[0]?.seenAt).toBe(new Date(2_000).toISOString());
  });

  it('case-variant links fold to the SAME chapter key (link identity, Pascal LowerCase parity)', () => {
    const inbox = openService();
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/1', name: 'Ch. 1' }] }, 1_000));
    const recorded = inbox.record(
      arrival({ chapters: [{ link: 'HTTPS://SITE.EXAMPLE/CH/1', name: 'Ch. 1' }] }, 2_000),
    );
    expect(recorded).toBe(0);
    expect(inbox.list('new', 2_500).entries).toHaveLength(1);
  });
});

describe('SqliteInboxService — the rolling 30-day archive', () => {
  it('serves acknowledged entries inside the window and hides older ones', () => {
    const inbox = openService();
    const now = 100_000_000_000;
    // the window runs from the SEEN stamp (decision 6): acknowledged
    // 40 days ago vs 10 days ago — the detection times are irrelevant
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/1', name: 'Ch. 1' }] }, now - 90 * 24 * 3600 * 1000));
    inbox.acknowledge([inboxChapterKey(MODULE, 'https://site.example/ch/1')], now - 40 * 24 * 3600 * 1000);
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/2', name: 'Ch. 2' }] }, now - 50 * 24 * 3600 * 1000));
    inbox.acknowledge([inboxChapterKey(MODULE, 'https://site.example/ch/2')], now - 10 * 24 * 3600 * 1000);

    const archive = inbox.list('archive', now);
    expect(archive.entries.map((entry) => entry.chapterLink)).toEqual(['https://site.example/ch/2']);
  });

  it('purge removes EXACTLY the acknowledged rows past the window — never an unacknowledged row', () => {
    const inbox = openService();
    const now = 100_000_000_000;
    // acknowledged 40 days ago → purge candidate
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/1', name: 'Ch. 1' }] }, now - 40 * 24 * 3600 * 1000));
    inbox.acknowledge([inboxChapterKey(MODULE, 'https://site.example/ch/1')], now - 40 * 24 * 3600 * 1000);
    // acknowledged yesterday → stays
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/2', name: 'Ch. 2' }] }, now - 24 * 3600 * 1000));
    inbox.acknowledge([inboxChapterKey(MODULE, 'https://site.example/ch/2')], now - 24 * 3600 * 1000);
    // unacknowledged for a YEAR → still the feed's truth, never purged
    inbox.record(arrival({ chapters: [{ link: 'https://site.example/ch/3', name: 'Ch. 3' }] }, now - 365 * 24 * 3600 * 1000));

    expect(inbox.purge(now)).toBe(1);
    expect(inbox.list('archive', now).entries.map((entry) => entry.chapterLink)).toEqual([
      'https://site.example/ch/2',
    ]);
    expect(inbox.list('new', now).entries.map((entry) => entry.chapterLink)).toEqual([
      'https://site.example/ch/3',
    ]);
    // a second purge is a no-op
    expect(inbox.purge(now)).toBe(0);
  });

  it('the window constant is 30 days (the D1 §2 charter, frozen)', () => {
    expect(INBOX_ARCHIVE_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('SqliteInboxService — snapshots survive the favorite', () => {
  it('an entry keeps its title/cover snapshots after the favorite is gone (no favorites join)', () => {
    const inbox = openService();
    inbox.record(
      arrival(
        {
          chapters: [{ link: 'https://site.example/ch/1', name: 'Ch. 1' }],
          mangaTitle: 'Deleted Later',
          coverLink: 'https://cdn.example/deleted.jpg',
        },
        1_000,
      ),
    );

    // the favorite row vanishing changes nothing here — the rows are
    // self-contained (arrivals, not a join)
    const feed = inbox.list('new', 2_000);
    expect(feed.entries[0]?.mangaTitle).toBe('Deleted Later');
    expect(feed.entries[0]?.coverLink).toBe('https://cdn.example/deleted.jpg');
  });

  it('records an empty chapter set as a no-op returning 0', () => {
    const inbox = openService();
    expect(inbox.record(arrival({ chapters: [] }, 1_000))).toBe(0);
    expect(inbox.list('new', 2_000).entries).toEqual([]);
  });
});
