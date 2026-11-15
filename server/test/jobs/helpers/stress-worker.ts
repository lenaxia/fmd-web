/**
 * Stress-drill worker (bundled with esbuild at test time, then run in
 * its own worker_thread). Each worker holds ITS OWN better-sqlite3
 * connection — the §4 one-connection-per-thread discipline for real —
 * and hammers the single-writer claim transaction concurrently with
 * its peers.
 *
 * Protocol (worker_threads):
 * - workerData: { workerId }
 * - in:  { type: 'rep', repId, dbPath }
 * - out: { type: 'rep-done', repId, claimed }
 *
 * Claim protocol per job: claim('download') → ledger INSERT (PRIMARY
 * KEY (rep_id, job_id): a double-claim crashes this worker LOUDLY via
 * the UNIQUE constraint) → transition('done'). Exit when the lane has
 * no non-terminal rows left.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { SqliteJobQueue } from '../../../src/jobs/queue/index.js';

interface StressWorkerData {
  readonly workerId: string;
}

interface RepMessage {
  readonly type: 'rep';
  readonly repId: number;
  readonly dbPath: string;
}

interface RepDoneMessage {
  readonly type: 'rep-done';
  readonly repId: number;
  readonly claimed: number;
}

const data: StressWorkerData = workerData as StressWorkerData;
const port = parentPort;

if (port === null) {
  throw new Error('stress worker requires a parent port');
}

interface RemainingRow {
  readonly n: number;
}

async function runRep(msg: RepMessage): Promise<void> {
  // THIS thread, THIS connection — both opened per rep (§4 discipline:
  // one connection per thread; nothing is shared across threads).
  const queue = new SqliteJobQueue({ file: msg.dbPath });
  const ledger = new Database(msg.dbPath);
  ledger.pragma('busy_timeout = 5000');
  ledger.exec(
    `CREATE TABLE IF NOT EXISTS stress_claims (
       rep_id    INTEGER NOT NULL,
       job_id    TEXT    NOT NULL,
       worker_id TEXT    NOT NULL,
       PRIMARY KEY (rep_id, job_id)
     )`,
  );
  const insertClaim = ledger.prepare(
    'INSERT INTO stress_claims (rep_id, job_id, worker_id) VALUES (?, ?, ?)',
  );
  const remaining = ledger.prepare(
    `SELECT COUNT(*) AS n FROM job
     WHERE type = 'download' AND state NOT IN ('done', 'failed', 'cancelled')`,
  );

  let claimed = 0;
  for (;;) {
    const job = queue.claim('download', { workerId: data.workerId });
    if (job !== undefined) {
      // UNIQUE (rep_id, job_id): a second claim of the same job in this
      // rep throws here and the worker dies — the double-claim alarm.
      insertClaim.run(msg.repId, job.id, data.workerId);
      queue.transition(job.id, 'done');
      claimed += 1;
      continue;
    }
    const left: RemainingRow = remaining.get() as RemainingRow;
    if (left.n === 0) {
      break; // lane drained — nothing can reappear (no retry outcomes here)
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1); // brief backoff while peers hold claims
    });
  }

  queue.close();
  ledger.close();
  const done: RepDoneMessage = { type: 'rep-done', repId: msg.repId, claimed };
  port!.postMessage(done);
}

port.on('message', (msg: RepMessage): void => {
  if (msg.type !== 'rep') {
    throw new Error(`unexpected message: ${JSON.stringify(msg)}`);
  }
  void runRep(msg).catch((cause: unknown): void => {
    port!.postMessage({
      type: 'rep-error',
      repId: (msg as RepMessage).repId,
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    });
  });
});
