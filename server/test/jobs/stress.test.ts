import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteJobQueue } from '../../src/jobs/queue/queue.js';
import { downloadPayload, mkTmpDir, rmDir } from './helpers.js';

/**
 * Concurrency stress drill (§4 single-writer claim discipline):
 *
 *   16 claimant threads × 500 jobs × 10 repetitions
 *
 * Every claimant is a REAL `worker_thread` holding its OWN
 * better-sqlite3 connection (the §4 one-connection-per-thread rule)
 * racing `BEGIN IMMEDIATE` + `UPDATE … WHERE state IN
 * ('queued','retry') … RETURNING` claims against the same db file.
 *
 * Invariants, asserted HARD on every rep (deterministic — no sleeps,
 * no seeded luck):
 * - ZERO double-claims: the worker-side ledger table has PRIMARY KEY
 *   (rep_id, job_id) — a duplicate claim CRASHES the claimant — and
 *   the coordinator re-counts: exactly one ledger row per job;
 * - ZERO lost jobs: the ledger's job-id set ≡ the enqueued id set, all
 *   500 rows terminal `done`, Σ attempts == 500;
 * - identical digests across all 10 reps (repetition-stable).
 */

const WORKERS = 16;
const JOBS = 500;
const REPS = 10;

interface RepDoneMessage {
  readonly type: 'rep-done';
  readonly repId: number;
  readonly claimed: number;
}

interface RepErrorMessage {
  readonly type: 'rep-error';
  readonly repId: number;
  readonly error: string;
}

type RepResultMessage = RepDoneMessage | RepErrorMessage;

interface StateCount {
  readonly state: string;
  readonly n: number;
}

interface LedgerCount {
  readonly job_id: string;
  readonly c: number;
}

interface SumRow {
  readonly s: number;
}

/**
 * Cache dir for the on-the-fly worker bundle: under the node_modules
 * tree that contains better-sqlite3 (bare-import walk-up resolves),
 * falling back to a test-local dir. Removed again in afterAll.
 */
function bundleCacheDir(): string {
  const require: NodeRequire = createRequire(import.meta.url);
  try {
    const entry: string = require.resolve('better-sqlite3');
    let dir: string = path.dirname(entry);
    while (path.basename(dir) !== 'node_modules' && dir !== path.dirname(dir)) {
      dir = path.dirname(dir);
    }
    if (path.basename(dir) === 'node_modules') {
      return path.join(dir, '.fmd-stress-cache');
    }
  } catch {
    /* fall through to the test-local anchor */
  }
  return fileURLToPath(new URL('./.stress-cache/', import.meta.url));
}

describe(`stress: ${String(WORKERS)} claimants × ${String(JOBS)} jobs × ${String(REPS)} reps`, () => {
  let dir: string;
  let bundleFile: string;
  const workers: Worker[] = [];

  beforeAll(async () => {
    dir = mkTmpDir('queue-stress');
    // Bundle the worker TS (with the queue sources inlined) ONCE into a
    // cache dir under node_modules so the external
    // `require('better-sqlite3')` resolves through normal node_modules
    // walk-up. This compiles the ACTUAL shipped sources — not a stale
    // dist snapshot.
    bundleFile = path.join(bundleCacheDir(), 'stress-worker.mjs');
    fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
    const workerSource: string = fileURLToPath(
      new URL('./helpers/stress-worker.ts', import.meta.url),
    );
    await esbuild.build({
      entryPoints: [workerSource],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      outfile: bundleFile,
      external: ['better-sqlite3'],
      sourcemap: false,
      logLevel: 'silent',
    });
    for (let i = 0; i < WORKERS; i += 1) {
      workers.push(new Worker(bundleFile, { workerData: { workerId: `claimant-${String(i)}` } }));
    }
  }, 30_000);

  afterAll(async () => {
    await Promise.all(
      workers.map(async (w) => {
        await w.terminate();
      }),
    );
    fs.rmSync(path.dirname(bundleFile), { recursive: true, force: true });
    rmDir(dir);
  });

  it('zero double-claims, zero lost jobs — deterministic across all 10 repetitions', async () => {
    const digests: string[] = [];

    for (let rep = 1; rep <= REPS; rep += 1) {
      const repDir: string = path.join(dir, `rep-${String(rep)}`);
      fs.mkdirSync(repDir, { recursive: true });
      const dbPath: string = path.join(repDir, 'app.db');

      // Coordinator thread: seeds the db, enqueues 500 download jobs.
      const coordinator = new SqliteJobQueue({ file: dbPath });
      const ids: string[] = [];
      for (let i = 0; i < JOBS; i += 1) {
        ids.push(coordinator.enqueue(downloadPayload(`/ch/${String(i)}`)).job.id);
      }
      expect(coordinator.counts('download').queued).toBe(JOBS);

      // Release all 16 claimants against the same db file.
      const settled: RepResultMessage[] = await Promise.all(
        workers.map(
          (w, workerIdx) =>
            new Promise<RepResultMessage>((resolve, reject) => {
              const listener = (raw: unknown): void => {
                const msg = raw as RepResultMessage;
                if (msg.repId !== rep) {
                  return;
                }
                w.off('message', listener);
                resolve(msg);
              };
              w.on('message', listener);
              w.once(
                'error',
                (cause: Error): void => {
                  reject(new Error(`claimant-${String(workerIdx)} crashed: ${cause.message}`));
                },
              );
              w.postMessage({ type: 'rep', repId: rep, dbPath });
            }),
        ),
      );

      // Any claimant error (a double-claim trips the ledger UNIQUE) fails the rep.
      const errors: RepErrorMessage[] = settled.filter(
        (m): m is RepErrorMessage => m.type === 'rep-error',
      );
      if (errors.length > 0) {
        throw new Error(`rep ${String(rep)}: claimant errors: ${errors.map((e) => e.error).join('; ')}`);
      }

      // ── coordinator-side verification (raw read connection) ──
      const verify = new Database(dbPath);
      try {
        // ZERO lost jobs: every row terminal done, nothing else.
        const states: StateCount[] = verify
          .prepare('SELECT state, COUNT(*) AS n FROM job GROUP BY state')
          .all() as StateCount[];
        expect(states).toEqual([{ state: 'done', n: JOBS }]);

        // ZERO double-claims: exactly ONE ledger row per job (the
        // worker-side PRIMARY KEY already crashes on duplicates).
        const ledger: LedgerCount[] = verify
          .prepare(
            `SELECT job_id, COUNT(*) AS c FROM stress_claims WHERE rep_id = ? GROUP BY job_id`,
          )
          .all(rep) as LedgerCount[];
        expect(ledger).toHaveLength(JOBS);
        for (const row of ledger) {
          expect(row.c).toBe(1);
        }
        const duplicateRows: number = (
          verify
            .prepare(
              `SELECT COUNT(*) AS c FROM (
                 SELECT rep_id, job_id FROM stress_claims
                 GROUP BY rep_id, job_id HAVING COUNT(*) > 1
               )`,
            )
            .get() as { c: number }
        ).c;
        expect(duplicateRows).toBe(0);

        // ZERO lost jobs (ledger set ≡ enqueued set).
        const ledgerIds: string[] = ledger.map((r) => r.job_id).sort();
        expect(ledgerIds).toEqual([...ids].sort());

        // Every claim path bump counted exactly once.
        const attempts: SumRow = verify
          .prepare('SELECT COALESCE(SUM(attempts), 0) AS s FROM job')
          .get() as SumRow;
        expect(attempts.s).toBe(JOBS);

        // Claimant-side accounting: the 16 rep-done messages report how
        // many claims each claimant made — the sum MUST equal JOBS
        // (coordinator-side and claimant-side ledgers agree).
        const claimedSum: number = settled.reduce(
          (total, m) => total + (m.type === 'rep-done' ? m.claimed : 0),
          0,
        );
        expect(claimedSum).toBe(JOBS);

        digests.push(
          JSON.stringify({
            done: JOBS,
            ledgerRows: ledger.length,
            attempts: attempts.s,
            claimedSum,
          }),
        );
      } finally {
        verify.close();
        coordinator.close();
      }
    }

    // Deterministic under repetition: all 10 reps produced the same digest.
    expect(digests).toHaveLength(REPS);
    expect(new Set(digests).size).toBe(1);
  }, 120_000);
});
