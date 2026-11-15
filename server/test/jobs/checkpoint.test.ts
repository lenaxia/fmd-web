import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUSY_TIMEOUT_MS,
  CheckpointMonitor,
  WAL_AUTOCHECKPOINT_DEFAULT_PAGES,
  openQueueDb,
  walSizeBytes,
} from '../../src/jobs/queue/connection.js';
import { mkTmpDir, rmDir } from './helpers.js';

/**
 * Checkpoint-stall drill (§4 "WAL auto-checkpoint sized … and
 * checkpoint stalls monitored"). Two connections = two threads (§4
 * discipline: one connection per thread):
 *
 * - a reader holding an open read transaction PINS the WAL — the
 *   auto-checkpoint and explicit PASSIVE checkpoints cannot fully
 *   advance (busy), yet WRITERS KEEP COMMITTING — a stall is visible,
 *   never fatal;
 * - once the reader releases, a TRUNCATE checkpoint drains the WAL to
 *   zero bytes;
 * - the auto-checkpoint threshold is real and tunable: past N pages of
 *   writes with no reader, everything is already checkpointed (log=0).
 */
describe('§4 WAL discipline — auto-checkpoint sizing (default 1000 pages, tunable)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir('queue-wal-size');
  });

  afterEach(() => {
    rmDir(dir);
  });

  function writeRows(db: Database.Database, count: number): void {
    db.exec('CREATE TABLE IF NOT EXISTS scratch (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO scratch (blob) VALUES (?)');
    const blob: string = 'x'.repeat(2_048); // ~a page of payload per row
    for (let i = 0; i < count; i += 1) {
      db.transaction((): void => {
        insert.run(blob);
      })();
    }
  }

  it('§4 discipline constants are pinned: busy_timeout=5000, autocheckpoint default=1000', () => {
    const file: string = path.join(dir, 'app.db');
    const db: Database.Database = openQueueDb(file);
    try {
      expect(BUSY_TIMEOUT_MS).toBe(5_000);
      expect(WAL_AUTOCHECKPOINT_DEFAULT_PAGES).toBe(1_000);
      expect(db.pragma('busy_timeout', { simple: true })).toBe(BUSY_TIMEOUT_MS);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(
        WAL_AUTOCHECKPOINT_DEFAULT_PAGES,
      );
    } finally {
      db.close();
    }
  });

  it('the threshold is tunable and effective: past N pages, nothing is left to checkpoint', () => {
    const tunedFile: string = path.join(dir, 'tuned.db');
    const rawFile: string = path.join(dir, 'raw.db');

    // Tuned: tiny threshold (8 pages) — writes overshoot it quickly.
    const tuned: Database.Database = openQueueDb(tunedFile, { walAutocheckpointPages: 8 });
    expect(tuned.pragma('wal_autocheckpoint', { simple: true })).toBe(8);
    writeRows(tuned, 200); // ~400+ pages of WAL → several auto-checkpoints
    // With no reader pinning frames, every auto-checkpoint drains the
    // WAL as it grows: only the frames since the LAST auto remain
    // pending (a handful — bounded by the threshold).
    const tunedOutcome = tuned.pragma('wal_checkpoint(PASSIVE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    tuned.close();

    // Control: autocheckpoint DISABLED — the same volume stays pending.
    const raw: Database.Database = openQueueDb(rawFile, { walAutocheckpointPages: 0 });
    expect(raw.pragma('wal_autocheckpoint', { simple: true })).toBe(0);
    writeRows(raw, 200);
    const rawOutcome = raw.pragma('wal_checkpoint(PASSIVE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    raw.close();

    expect(tunedOutcome[0]?.busy).toBe(0);
    expect(tunedOutcome[0]?.checkpointed).toBe(tunedOutcome[0]?.log); // remainder is movable
    // Differential proof of the sizing: the tuned WAL holds a handful
    // of frames; the disabled one holds hundreds.
    expect((tunedOutcome[0]?.log ?? 0)).toBeGreaterThan(0);
    expect((rawOutcome[0]?.log ?? 0)).toBeGreaterThan((tunedOutcome[0]?.log ?? 0) * 10);
  });

  it('rejects non-integer / negative page thresholds', () => {
    const file: string = path.join(dir, 'bad.db');
    expect((): Database.Database => openQueueDb(file, { walAutocheckpointPages: -1 })).toThrow(
      /wal_autocheckpoint/,
    );
    expect((): Database.Database => openQueueDb(file, { walAutocheckpointPages: 1.5 })).toThrow(
      /wal_autocheckpoint/,
    );
  });
});

describe('§4 checkpoint-stall drill — readers pin the WAL, writers never fail', () => {
  let dir: string;
  let writer: Database.Database;
  let reader: Database.Database;
  let file: string;
  let monitor: CheckpointMonitor;

  beforeEach(() => {
    dir = mkTmpDir('queue-wal-stall');
    file = path.join(dir, 'app.db');
    // Two connections = two threads (§4: one connection per thread).
    writer = openQueueDb(file);
    reader = new Database(file);
    reader.pragma('busy_timeout = 5000');
    monitor = new CheckpointMonitor(250);
    writer.exec('CREATE TABLE scratch (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)');
  });

  afterEach(() => {
    try {
      reader.close();
    } catch {
      /* may already be closed by the drill */
    }
    writer.close();
    rmDir(dir);
  });

  function writeOne(): void {
    writer
      .prepare('INSERT INTO scratch (blob) VALUES (?)')
      .run('y'.repeat(4_096)); // ~1 page per commit
  }

  it('stall: reader pins frames → checkpoint busy → writers STILL commit → release → WAL truncates', () => {
    // The reader opens a read transaction BEFORE the writes: its
    // snapshot pins the WAL start; frames accumulate past its mark.
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM scratch').get();

    // 64 commits (~64+ WAL pages) WHILE the reader holds its mark.
    for (let i = 0; i < 64; i += 1) {
      writeOne(); // every commit succeeds — a stall never fails a writer
    }
    const committed: number = (writer.prepare('SELECT COUNT(*) AS n FROM scratch').get() as {
      n: number;
    }).n;
    expect(committed).toBe(64);
    expect(walSizeBytes(file)).toBeGreaterThan(0);

    // The explicit PASSIVE checkpoint cannot finish: it quietly leaves
    // frames behind the reader (PASSIVE never blocks, so `busy` stays
    // false — the STALL is `checkpointed < log`, which the monitor
    // classifies as stalled).
    const stalled = monitor.run(writer, 'PASSIVE');
    expect(stalled.busy).toBe(false);
    expect(stalled.stalled).toBe(true);
    expect(stalled.checkpointed).toBeLessThan(stalled.log); // frames left behind
    expect(monitor.stats().stalls).toBe(1);
    expect(monitor.stats().runs).toBe(1);

    // Writers kept the whole time (re-assert post-checkpoint).
    writeOne();
    expect((writer.prepare('SELECT COUNT(*) AS n FROM scratch').get() as { n: number }).n).toBe(65);

    // Release the reader → the pin is gone → TRUNCATE drains everything.
    reader.exec('COMMIT');
    reader.close();
    const drained = monitor.run(writer, 'TRUNCATE');
    expect(drained.busy).toBe(false);
    expect(drained.stalled).toBe(false);
    expect(drained.checkpointed).toBe(drained.log); // everything moved
    expect(walSizeBytes(file)).toBe(0); // TRUNCATE resets the WAL file

    const stats = monitor.stats();
    expect(stats.runs).toBe(2);
    expect(stats.stalls).toBe(1); // the stall was OBSERVED, not silent
    expect(stats.maxDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('the monitor records clean runs as non-stalls', () => {
    for (let i = 0; i < 8; i += 1) {
      writeOne();
    }
    const outcome = monitor.run(writer, 'PASSIVE');
    expect(outcome.busy).toBe(false);
    expect(outcome.stalled).toBe(false);
    expect(monitor.stats().stalls).toBe(0);
    expect(monitor.stats().runs).toBe(1);
    expect(monitor.stats().lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects a non-positive stall threshold', () => {
    expect(() => new CheckpointMonitor(0)).toThrow(/stallThresholdMs/);
  });
});
