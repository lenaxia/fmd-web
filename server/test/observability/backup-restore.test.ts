/**
 * Backup/restore rehearsal (§9 acceptance): backup the data dir →
 * corrupt BOTH the app db and a catalog file → /readyz red → restore
 * from the snapshot → validation green + /readyz 200 again (and the
 * job data survived the round trip). The backup uses the online backup
 * API (sqlite3 .backup equivalent); the restore validation IS the
 * readiness check.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { backupDataDir, restoreDataDir } from '../../src/observability/backup.js';
import { ReadinessProbe } from '../../src/observability/health.js';
import { InstrumentedJobQueue } from '../../src/observability/instrumented-queue.js';
import { FmdMetrics } from '../../src/observability/metrics.js';
import { SqliteJobQueue } from '../../src/jobs/queue/queue.js';
import { openQueueDb, ensureJobSchema } from '../../src/jobs/queue/connection.js';

const TMP = mkdtempSync(join(tmpdir(), 'fmd-backup-'));
const DATA = join(TMP, 'data');
const BACKUP = join(TMP, 'backup');
const APP_DB = join(DATA, 'app.db');
const CATALOG_DB = join(DATA, 'catalogs', 'FixtureCatalog.db');

afterAll((): void => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('backup → corrupt → restore → readyz green (§9 rehearsal)', (): void => {
  it('restores a consistent snapshot and validates it with the readiness checks', async (): Promise<void> => {
    // ── build a live-shaped data dir ──────────────────────────────────
    mkdirSync(join(DATA, 'catalogs'), { recursive: true });
    mkdirSync(join(DATA, 'lua', 'modules'), { recursive: true });
    const db = openQueueDb(APP_DB);
    ensureJobSchema(db);
    db.close();
    writeFileSync(join(DATA, 'lua', 'modules', 'Fixture.lua'), 'return {}\n');
    writeFileSync(join(DATA, 'sync-state.json'), JSON.stringify({ sha: 'f'.repeat(64) }));
    const catalog = new Database(CATALOG_DB);
    catalog.exec('CREATE TABLE entry (id INTEGER PRIMARY KEY, title TEXT)');
    catalog.prepare('INSERT INTO entry (title) VALUES (?)').run('Before backup');
    catalog.close();

    // Jobs in the app db (data the restore must bring back).
    const metrics = new FmdMetrics();
    const queue = new InstrumentedJobQueue(new SqliteJobQueue({ file: APP_DB }), metrics);
    const created = queue.enqueue({
      type: 'download', moduleId: 'a'.repeat(32),
      mangaUrl: 'https://example.test/m', chapterLink: 'https://example.test/c1',
    });
    queue.close();

    const probe = new ReadinessProbe({ dataDir: DATA });
    expect(probe.readiness()).toEqual({ ready: true });

    // ── backup (online backup API + file copy) ────────────────────────
    const report = await backupDataDir({ dataDir: DATA, backupDir: BACKUP });
    expect([...report.dbFiles].sort()).toEqual(['app.db', 'catalogs/FixtureCatalog.db']);
    expect(report.copiedFiles).toContain('lua/modules/Fixture.lua');
    expect(report.copiedFiles).toContain('sync-state.json');
    // No live sidecars were copied (the backup API folds them in).
    const backedUp = readdirSync(BACKUP, { recursive: true }).map(String);
    expect(backedUp.some((name) => name.endsWith('-wal') || name.endsWith('-journal'))).toBe(false);
    expect(backedUp).toContain('catalogs/FixtureCatalog.db');

    // ── corrupt BOTH databases (the fault) ───────────────────────────
    writeFileSync(APP_DB, Buffer.from('corrupted app db'.repeat(16), 'utf8'));
    writeFileSync(CATALOG_DB, Buffer.from('corrupted catalog'.repeat(16), 'utf8'));
    const corruptChecks = probe.checks();
    expect(corruptChecks.find((c) => c.check === 'db')?.ok).toBe(false);
    expect(corruptChecks.find((c) => c.check === 'catalogs')?.ok).toBe(false);
    expect(probe.readiness().ready).toBe(false);

    // ── restore + validation (§9: restore validated at startup) ──────
    const restore = restoreDataDir({ backupDir: BACKUP, dataDir: DATA });
    expect(restore.valid).toBe(true);
    expect(restore.restoredFiles).toContain('app.db');
    expect(restore.restoredFiles).toContain('catalogs/FixtureCatalog.db');
    // Validation is EXACTLY the readiness check set — all green.
    expect(restore.validation.every((check) => check.ok)).toBe(true);
    expect(probe.readiness()).toEqual({ ready: true });

    // ── the restored data survived the round trip ─────────────────────
    const reopened = new SqliteJobQueue({ file: APP_DB });
    expect(reopened.get(created.job.id)?.state).toBe('queued');
    reopened.close();
    const restoredCatalog = new Database(CATALOG_DB, { readonly: true });
    expect(
      (restoredCatalog.prepare('SELECT title FROM entry').get() as { title: string }).title,
    ).toBe('Before backup');
    restoredCatalog.close();
  });
});
