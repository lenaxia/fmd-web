/**
 * Readiness semantics under fault injection (§10 acceptance): a
 * corrupted catalog file flips /readyz to 503 (with the failing family
 * in the reason) while /healthz stays 200 — liveness is unaffected by
 * data faults. Also covers the db-open and lua-tree probes and the
 * per-file probe cache (a changed file re-probes on the next scrape).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { ReadinessProbe, composeReadiness } from '../../src/observability/health.js';
import { buildApp } from '../../src/api/app.js';
import {
  InMemoryFavoriteService,
  InMemoryLibraryService,
  InMemoryModuleService,
} from '../../src/api/services.js';
import {
  InMemoryCatalogStore,
  TEST_VERSION,
  catalogFixtures,
  defaultRegistrations,
} from '../api/helpers.js';
import { openQueueDb, ensureJobSchema } from '../../src/jobs/queue/connection.js';

const TMP = mkdtempSync(join(tmpdir(), 'fmd-readyz-'));
const CATALOG_DB = join(TMP, 'catalogs', 'NatsukiMangas.db');

function buildDataDir(): void {
  mkdirSync(join(TMP, 'catalogs'), { recursive: true });
  mkdirSync(join(TMP, 'lua', 'modules'), { recursive: true });
  // app.db: the real queue schema.
  const db = openQueueDb(join(TMP, 'app.db'));
  ensureJobSchema(db);
  db.close();
  // A valid (attachable) catalog db.
  const catalog = new Database(CATALOG_DB);
  catalog.exec('CREATE TABLE entry (id INTEGER PRIMARY KEY, title TEXT)');
  catalog.prepare('INSERT INTO entry (title) VALUES (?)').run('Fixture');
  catalog.close();
  // The synced lua tree.
  writeFileSync(join(TMP, 'lua', 'modules', 'FixtureModule.lua'), 'return {}\n');
}

afterAll((): void => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('readyz readiness probes (§10, fault injection)', (): void => {
  it('a corrupted catalog file → readyz 503, healthz stays 200', async (): Promise<void> => {
    buildDataDir();
    const probe = new ReadinessProbe({ dataDir: TMP });
    expect(probe.readiness()).toEqual({ ready: true });

    const app = buildApp(
      {
        modules: new InMemoryModuleService(defaultRegistrations()),
        catalogs: new InMemoryCatalogStore(catalogFixtures(), []),
        info: { getInfo: async (): Promise<never> => {
          throw new Error('unused');
        } },
        jobs: {
          createDownload: (): never => {
            throw new Error('unused');
          },
          get: (): undefined => undefined,
          list: (): never => {
            throw new Error('unused');
          },
          cancel: (): never => {
            throw new Error('unused');
          },
          resume: (): never => {
            throw new Error('unused');
          },
          action: (): never => {
            throw new Error('unused');
          },
          remove: (): never => {
            throw new Error('unused');
          },
          bulkAction: (): never => {
            throw new Error('unused');
          },
        },
        library: new InMemoryLibraryService(),
        favorites: new InMemoryFavoriteService(),
        sync: {
          syncModules: async (): Promise<never> => {
            throw new Error('unused');
          },
          syncCatalog: async (): Promise<never> => {
            throw new Error('unused');
          },
          syncAllCatalogs: async (): Promise<never> => {
            throw new Error('unused');
          },
        },
        readiness: probe.probe,
      },
      { version: TEST_VERSION },
    );

    // Baseline: both probes green.
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);

    // FAULT: corrupt the catalog file (garbage bytes — "file is not a database").
    writeFileSync(CATALOG_DB, Buffer.from('definitely not a sqlite database'.repeat(4), 'utf8'));

    const readyz = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readyz.statusCode).toBe(503);
    const body = readyz.json() as { ready: boolean; reason?: string };
    expect(body.ready).toBe(false);
    expect(body.reason).toContain('catalogs');
    expect(body.reason).toContain('not a database');

    // Liveness is UNAFFECTED by the data fault (restart cannot heal it).
    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
    expect(healthz.json()).toEqual({ status: 'ok', version: TEST_VERSION });

    // The probe cache keys on (size, mtime): repairing the file (fresh
    // db at the same path) flips readiness back WITHOUT a restart.
    rmSync(CATALOG_DB);
    const repaired = new Database(CATALOG_DB);
    repaired.exec('CREATE TABLE entry (id INTEGER PRIMARY KEY, title TEXT)');
    repaired.close();
    expect(probe.readiness()).toEqual({ ready: true });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);

    await app.close();
  });

  it('db-open and lua-tree faults surface per family (probe detail)', (): void => {
    const missing = new ReadinessProbe({ dataDir: join(TMP, 'does-not-exist') });
    const checks = missing.checks();
    expect(checks.find((check) => check.check === 'db' && !check.ok)).toBeDefined();
    expect(checks.find((check) => check.check === 'luaTree' && !check.ok)).toBeDefined();
    const status = missing.readiness();
    expect(status.ready).toBe(false);
    expect(status.reason).toContain('db');
    expect(status.reason).toContain('luaTree');
  });

  it('a corrupted app db fails the db family (SELECT 1 probe)', (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'fmd-appdb-'));
    try {
      const corrupt = join(dir, 'app.db');
      writeFileSync(corrupt, Buffer.from('garbage header'.repeat(8), 'utf8'));
      const probe = new ReadinessProbe({ dataDir: dir });
      const result = probe.checks().find((check) => check.check === 'db');
      expect(result?.ok).toBe(false);
      expect(probe.readiness().ready).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('composeReadiness: the first not-ready source wins (bootstrap gates first)', (): void => {
    const bootstrapGating = composeReadiness(
      (): { ready: boolean; reason?: string } => ({ ready: false, reason: 'bootstrap: modules…' }),
      new ReadinessProbe({ dataDir: join(TMP, 'still-missing') }).probe,
    );
    expect(bootstrapGating()).toEqual({ ready: false, reason: 'bootstrap: modules…' });

    const infraGating = composeReadiness(
      (): { ready: boolean } => ({ ready: true }),
      new ReadinessProbe({ dataDir: join(TMP, 'still-missing') }).probe,
    );
    expect(infraGating().ready).toBe(false);
    expect(infraGating().reason).toContain('luaTree');
  });
});
