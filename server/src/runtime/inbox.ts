/**
 * Inbox store + service (D1 §2 INBOX — tsk-acidic-oxbow-waits): the
 * Home feed's persisted truth. ONE row per detected new chapter —
 * `seen_at NULL` = unacknowledged (the feed), a stamp = acknowledged
 * (the archive). Seen state is PER CHAPTER (`chapter_key`, D1 §3
 * "a chapter = its link"): acknowledging clears exactly the
 * acknowledged chapters, and the shared caught-up action stamps every
 * unacknowledged row at once.
 *
 * The rows are WRITTEN by the check engine's one detection path
 * (`FavoritesEngine.checkFavorite` — scheduler sweeps, manual
 * check-now and batch checks all flow through it; there is no second
 * detection path anywhere) and READ by the inbox API. Snapshots
 * (title, cover link) ride the row so an entry keeps rendering after
 * its favorite is deleted — the inbox is a feed of arrivals, not a
 * favorites join.
 *
 * SHARED CAUGHT-UP STATE ACROSS DEVICES (documented decision): seen
 * rows live in app.db server-side, so "caught up" is one truth for
 * every browser/device that opens the instance — acknowledging on one
 * device clears the feed on another. This is the D1 §4 single-user
 * assumption (R2) applied to read state: one operator, one inbox.
 * Marking read never replays anywhere because no per-device state
 * exists.
 *
 * ARCHIVE WINDOW: acknowledged entries stay readable for a rolling 30
 * days (D1 §2 "inbox entries archive after 30 days" — they are a
 * feed, not a ledger; the downloaded-truth ledger is separate and
 * permanent). The window rides the archive query's WHERE clause (a
 * GET never mutates — D1 §3); the physical purge is scheduled
 * housekeeping (`purge`, hourly from the runtime assembly), never a
 * read side effect.
 *
 * §9 table `inbox_event(chapter_key PK, module_id, manga_key,
 * manga_url, manga_title, cover_link, chapter_link, chapter_label,
 * detected_at, seen_at)` in app.db — same better-sqlite3 sync
 * discipline as the library/favorites stores (single-statement
 * writes, safe to call fire-and-forget from the check path).
 */
import type Database from 'better-sqlite3';
import { asciiLowerCase } from '../jobs/library/merge.js';

/**
 * The archive window (ms) — acknowledged entries older than this
 * leave the archive view and become purge candidates. 30 days per
 * the D1 §2 INBOX charter.
 */
export const INBOX_ARCHIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `asciiLowerCase(moduleId) + '|' + asciiLowerCase(link)` — the
 * per-chapter seen identity. Same Pascal `LowerCase` folding as the
 * favorites mangaKey (`downloadedChaptersKey`); the separator keeps
 * module and link from ever concat-ambiguating. A re-detection of a
 * known chapter is a NO-OP (INSERT OR IGNORE) — idempotent detection
 * is a D1 §3 invariant, and a chapter that already arrived has
 * already been fed to the user.
 */
export function inboxChapterKey(moduleId: string, chapterLink: string): string {
  return `${asciiLowerCase(moduleId)}|${asciiLowerCase(chapterLink)}`;
}

/** One inbox entry as the API serves it (§10 wire shape). */
export interface InboxEntry {
  readonly chapterKey: string;
  readonly moduleId: string;
  readonly mangaKey: string;
  readonly mangaUrl: string;
  readonly mangaTitle: string | null;
  readonly coverLink: string | null;
  readonly chapterLink: string;
  readonly chapterLabel: string;
  /** RFC 3339 UTC — when the check engine detected the chapter. */
  readonly detectedAt: string;
  /** RFC 3339 UTC — null = unacknowledged (the new feed). */
  readonly seenAt: string | null;
}

/** The check-engine recording input (a FavoriteRow projection). */
export interface InboxRecordInput {
  readonly moduleId: string;
  readonly mangaKey: string;
  readonly mangaUrl: string;
  readonly mangaTitle?: string;
  readonly coverLink?: string;
  readonly chapters: ReadonlyArray<{ readonly link: string; readonly name: string }>;
  /** Detection time (epoch ms) — the wall/fake clock stamp. */
  readonly at: number;
}

/** The app-level seam the API layer consumes (tests inject fakes). */
export interface InboxService {
  /** Record newly detected chapters (idempotent per chapter_key). */
  record(input: InboxRecordInput): number;
  /** One feed view: `new` = unacknowledged, `archive` = acknowledged
   * within the rolling 30-day window (both newest-first). */
  list(view: 'new' | 'archive', now?: number): { entries: readonly InboxEntry[]; newCount: number };
  /** Acknowledge EXACTLY the named chapters (unknown/already-seen
   * keys are no-ops). Returns how many rows flipped. */
  acknowledge(chapterKeys: readonly string[], at: number): number;
  /** The shared caught-up action: stamp every unacknowledged row. */
  caughtUp(at: number): number;
  /** Physical housekeeping: delete acknowledged rows past the
   * archive window. Returns how many rows were removed. */
  purge(now: number): number;
}

export function ensureInboxSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_event (
      chapter_key   TEXT PRIMARY KEY,
      module_id     TEXT NOT NULL,
      manga_key     TEXT NOT NULL,
      manga_url     TEXT NOT NULL,
      manga_title   TEXT,
      cover_link    TEXT,
      chapter_link  TEXT NOT NULL,
      chapter_label TEXT NOT NULL DEFAULT '',
      detected_at   INTEGER NOT NULL,
      seen_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS inbox_event_seen_idx
      ON inbox_event (seen_at, detected_at);
  `);
}

interface RowShape {
  readonly chapter_key: string;
  readonly module_id: string;
  readonly manga_key: string;
  readonly manga_url: string;
  readonly manga_title: string | null;
  readonly cover_link: string | null;
  readonly chapter_link: string;
  readonly chapter_label: string;
  readonly detected_at: number;
  readonly seen_at: number | null;
}

function toEntry(row: RowShape): InboxEntry {
  return {
    chapterKey: row.chapter_key,
    moduleId: row.module_id,
    mangaKey: row.manga_key,
    mangaUrl: row.manga_url,
    mangaTitle: row.manga_title,
    coverLink: row.cover_link,
    chapterLink: row.chapter_link,
    chapterLabel: row.chapter_label,
    detectedAt: new Date(row.detected_at).toISOString(),
    seenAt: row.seen_at === null ? null : new Date(row.seen_at).toISOString(),
  };
}

export class SqliteInboxService implements InboxService {
  private readonly insertIgnore: Database.Statement;
  private readonly ackOneRow: Database.Statement;
  private readonly ackAllRows: Database.Statement;
  private readonly listNewRows: Database.Statement;
  private readonly listArchiveRows: Database.Statement;
  private readonly countNewRows: Database.Statement;
  private readonly purgeRows: Database.Statement;
  private readonly db: Database.Database;

  public constructor(db: Database.Database) {
    ensureInboxSchema(db);
    this.db = db;
    this.insertIgnore = db.prepare(
      `INSERT INTO inbox_event (
         chapter_key, module_id, manga_key, manga_url, manga_title,
         cover_link, chapter_link, chapter_label, detected_at, seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(chapter_key) DO NOTHING`,
    );
    this.listNewRows = db.prepare(
      `SELECT * FROM inbox_event WHERE seen_at IS NULL
       ORDER BY detected_at DESC, chapter_key ASC`,
    );
    this.ackOneRow = db.prepare(
      'UPDATE inbox_event SET seen_at = ? WHERE chapter_key = ? AND seen_at IS NULL',
    );
    this.ackAllRows = db.prepare('UPDATE inbox_event SET seen_at = ? WHERE seen_at IS NULL');
    this.listArchiveRows = db.prepare(
      `SELECT * FROM inbox_event
       WHERE seen_at IS NOT NULL AND seen_at >= ?
       ORDER BY seen_at DESC, chapter_key ASC`,
    );
    this.countNewRows = db.prepare(
      'SELECT COUNT(*) AS n FROM inbox_event WHERE seen_at IS NULL',
    );
    this.purgeRows = db.prepare(
      'DELETE FROM inbox_event WHERE seen_at IS NOT NULL AND seen_at < ?',
    );
  }

  public record(input: InboxRecordInput): number {
    if (input.chapters.length === 0) {
      return 0;
    }
    return this.db.transaction((): number => {
      let recorded = 0;
      for (const chapter of input.chapters) {
        recorded += this.insertIgnore.run(
          inboxChapterKey(input.moduleId, chapter.link),
          input.moduleId,
          input.mangaKey,
          input.mangaUrl,
          input.mangaTitle ?? null,
          input.coverLink ?? null,
          chapter.link,
          chapter.name,
          input.at,
        ).changes;
      }
      return recorded;
    })();
  }

  public list(
    view: 'new' | 'archive',
    now: number = Date.now(),
  ): { entries: readonly InboxEntry[]; newCount: number } {
    const rows =
      view === 'archive'
        ? (this.listArchiveRows.all(now - INBOX_ARCHIVE_WINDOW_MS) as RowShape[])
        : (this.listNewRows.all() as RowShape[]);
    return {
      entries: rows.map(toEntry),
      newCount: (this.countNewRows.get() as { n: number }).n,
    };
  }

  public acknowledge(chapterKeys: readonly string[], at: number): number {
    if (chapterKeys.length === 0) {
      return 0;
    }
    return this.db.transaction((): number => {
      let flipped = 0;
      for (const key of chapterKeys) {
        flipped += this.ackOneRow.run(at, key).changes;
      }
      return flipped;
    })();
  }

  public caughtUp(at: number): number {
    return this.ackAllRows.run(at).changes;
  }

  public purge(now: number): number {
    return this.purgeRows.run(now - INBOX_ARCHIVE_WINDOW_MS).changes;
  }
}
