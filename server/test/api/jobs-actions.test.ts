/**
 * Downloads-parity integration tests (tsk-retro-fountain-tasks):
 *
 * - The FULL action × state matrix for POST /api/jobs/:id/action
 *   (pause/resume/retry/redownload/enable/disable) — every legal cell
 *   produces the documented effect, every illegal cell the typed 409
 *   envelope with {job, action} details.
 * - DELETE /api/jobs/:id (row only | ?data=true also removes the
 *   recorded artifact).
 * - POST /api/jobs/bulk-action: Pause all / Resume all / Delete
 *   completed — each IDEMPOTENT (second pass affects 0), illegal
 *   scope pairings 400.
 * - GET /api/jobs filters: states csv multi-select, q substring over
 *   title/chapter, addedFrom/addedTo window.
 */
import { describe, expect, it } from 'vitest';
import { buildHarness, expectEnvelope, MODULE_A_ID, type Harness } from './helpers.js';
import { InMemoryJobService } from '../../src/api/services.js';

type JobState = 'queued' | 'running' | 'retry' | 'done' | 'failed' | 'cancelled';
type ActionType = 'pause' | 'resume' | 'retry' | 'redownload' | 'enable' | 'disable';

function downloadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    moduleId: MODULE_A_ID,
    mangaUrl: 'https://ex.org/manga/x',
    mangaTitle: 'Fixture Manga',
    chapterLink: 'https://ex.org/manga/x/1',
    chapterName: 'Ch. 1',
    ...overrides,
  };
}

interface JobWire {
  readonly id: string;
  readonly state: JobState;
  readonly paused?: boolean;
}

async function createJob(h: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/jobs/download',
    payload: downloadBody({ idempotencyKey: `key-${String(Math.random()).slice(2)}`, ...overrides }),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { job: JobWire }).job.id;
}

async function act(
  h: Harness,
  id: string,
  type: ActionType,
): Promise<{ status: number; body: { job?: JobWire; error?: { code: string; details?: unknown } } }> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/jobs/${id}/action`,
    payload: { type },
  });
  return { status: res.statusCode, body: res.json() as { job?: JobWire; error?: { code: string; details?: unknown } } };
}

async function expect409(
  h: Harness,
  id: string,
  type: ActionType,
  state: string,
  paused = false,
): Promise<void> {
  const result = await act(h, id, type);
  expect(result.status).toBe(409);
  expect(result.body.error?.code).toBe('conflict');
  expect(result.body.error?.details).toEqual({ job: { id, state, paused }, action: type });
}

async function getJob(h: Harness, id: string): Promise<JobWire> {
  const res = await h.app.inject({ method: 'GET', url: `/api/jobs/${id}` });
  expect(res.statusCode).toBe(200);
  return (res.json() as { job: JobWire }).job;
}

/** A harness with one job forced into each §7.1 state (+held variant). */
async function matrixHarness(): Promise<{ h: Harness; ids: Record<string, string> }> {
  const h = buildHarness();
  const ids: Record<string, string> = {
    queued: await createJob(h),
    held: await createJob(h, { paused: true }),
    running: await createJob(h),
    retry: await createJob(h),
    done: await createJob(h),
    failed: await createJob(h),
    cancelled: await createJob(h),
  };
  h.jobs.forceState(ids['running'] as string, 'running');
  h.jobs.forceState(ids['retry'] as string, 'retry');
  h.jobs.forceState(ids['done'] as string, 'done', { stage: 'finalize', done: 3, total: 3, libraryPath: '/tmp/lib/x.zip' });
  h.jobs.forceState(ids['failed'] as string, 'failed');
  h.jobs.forceState(ids['cancelled'] as string, 'cancelled');
  return { h, ids };
}

describe('POST /api/jobs/:id/action — the state matrix', (): void => {
  it('pause: queued → hold; held → no-op; running/retry → cancelled; terminal → 409', async (): Promise<void> => {
    const { h, ids } = await matrixHarness();

    const paused = await act(h, ids['queued'] as string, 'pause');
    expect(paused.status).toBe(200);
    expect(paused.body.job?.state).toBe('queued');
    expect(paused.body.job?.paused).toBe(true);

    const heldNoop = await act(h, ids['held'] as string, 'pause');
    expect(heldNoop.status).toBe(200);
    expect(heldNoop.body.job?.paused).toBe(true); // still held, no error

    for (const key of ['running', 'retry'] as const) {
      const stopped = await act(h, ids[key] as string, 'pause');
      expect(stopped.status).toBe(200);
      expect(stopped.body.job?.state).toBe('cancelled');
      expect(stopped.body.job?.paused).toBeUndefined();
    }

    for (const key of ['done', 'failed', 'cancelled'] as const) {
      await expect409(h, ids[key] as string, 'pause', key === 'done' ? 'done' : key === 'failed' ? 'failed' : 'cancelled');
    }
  });

  it('resume: held → lift; queued → no-op; cancelled → fresh chained attempt; running/retry/done/failed → 409', async (): Promise<void> => {
    const { h, ids } = await matrixHarness();

    const lifted = await act(h, ids['held'] as string, 'resume');
    expect(lifted.status).toBe(200);
    expect(lifted.body.job?.state).toBe('queued');
    expect(lifted.body.job?.paused).toBeUndefined();

    const noop = await act(h, ids['queued'] as string, 'resume');
    expect(noop.status).toBe(200);
    expect(noop.body.job?.id).toBe(ids['queued']);
    expect(noop.body.job?.paused).toBeUndefined();

    const requeued = await act(h, ids['cancelled'] as string, 'resume');
    expect(requeued.status).toBe(200);
    expect(requeued.body.job?.state).toBe('queued');
    expect(requeued.body.job?.id).not.toBe(ids['cancelled']); // a FRESH row

    for (const key of ['running', 'retry', 'done', 'failed'] as const) {
      await expect409(h, ids[key] as string, 'resume', key);
    }
  });

  it('retry: failed → fresh attempt; every other state → 409', async (): Promise<void> => {
    const { h, ids } = await matrixHarness();

    const retried = await act(h, ids['failed'] as string, 'retry');
    expect(retried.status).toBe(200);
    expect(retried.body.job?.state).toBe('queued');
    expect(retried.body.job?.id).not.toBe(ids['failed']);
    expect((await getJob(h, ids['failed'] as string)).state).toBe('failed'); // original untouched

    for (const key of ['queued', 'held', 'running', 'retry', 'done', 'cancelled'] as const) {
      await expect409(h, ids[key] as string, 'retry', key === 'held' ? 'queued' : key, key === 'held');
    }
  });

  it('redownload: done → fresh attempt; every other state → 409', async (): Promise<void> => {
    const { h, ids } = await matrixHarness();

    const again = await act(h, ids['done'] as string, 'redownload');
    expect(again.status).toBe(200);
    expect(again.body.job?.state).toBe('queued');
    expect(again.body.job?.id).not.toBe(ids['done']);

    for (const key of ['queued', 'held', 'running', 'retry', 'failed', 'cancelled'] as const) {
      await expect409(h, ids[key] as string, 'redownload', key === 'held' ? 'queued' : key, key === 'held');
    }
  });

  it('disable/enable: queued-only hold toggles (idempotent), running/terminal → 409', async (): Promise<void> => {
    const { h, ids } = await matrixHarness();

    const disabled = await act(h, ids['queued'] as string, 'disable');
    expect(disabled.status).toBe(200);
    expect(disabled.body.job?.paused).toBe(true);

    const enabled = await act(h, ids['held'] as string, 'enable');
    expect(enabled.status).toBe(200);
    expect(enabled.body.job?.paused).toBeUndefined();

    // Idempotent repeats.
    expect((await act(h, ids['queued'] as string, 'disable')).status).toBe(200);
    expect((await act(h, ids['held'] as string, 'enable')).status).toBe(200);

    for (const type of ['disable', 'enable'] as const) {
      await expect409(h, ids['running'] as string, type, 'running');
      await expect409(h, ids['done'] as string, type, 'done');
      await expect409(h, ids['cancelled'] as string, type, 'cancelled');
    }
  });

  it('unknown job → 404; unknown action → validation_error', async (): Promise<void> => {
    const h = buildHarness();
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/jobs/999/action',
      payload: { type: 'pause' },
    });
    expect(missing.statusCode).toBe(404);
    expectEnvelope(missing.body, 'not_found');

    const id = await createJob(h);
    const bogus = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${id}/action`,
      payload: { type: 'yeet' },
    });
    expect(bogus.statusCode).toBe(400);
    expectEnvelope(bogus.body, 'validation_error');
  });
});

describe('DELETE /api/jobs/:id — row | row + data', (): void => {
  it('default keeps the artifact; ?data=true removes the recorded library file', async (): Promise<void> => {
    const deletedPaths: string[] = [];
    const h = buildHarness({
      jobs: new InMemoryJobService((path): boolean => {
        deletedPaths.push(path);
        return true;
      }),
    });

    const plain = await createJob(h, { chapterName: 'Ch. 1' });
    h.jobs.forceState(plain, 'done', { stage: 'finalize', done: 1, total: 1, libraryPath: '/tmp/lib/a.zip' });
    const rowOnly = await h.app.inject({ method: 'DELETE', url: `/api/jobs/${plain}` });
    expect(rowOnly.statusCode).toBe(200);
    expect((rowOnly.json() as { dataDeleted: boolean }).dataDeleted).toBe(false);
    expect(deletedPaths).toEqual([]); // artifact untouched

    const withData = await createJob(h, { chapterName: 'Ch. 2' });
    h.jobs.forceState(withData, 'done', { stage: 'finalize', done: 2, total: 2, libraryPath: '/tmp/lib/b.zip' });
    const gone = await h.app.inject({ method: 'DELETE', url: `/api/jobs/${withData}?data=true` });
    expect(gone.statusCode).toBe(200);
    expect((gone.json() as { dataDeleted: boolean }).dataDeleted).toBe(true);
    expect(deletedPaths).toEqual(['/tmp/lib/b.zip']);

    // Row gone either way; second delete 404s.
    for (const id of [plain, withData]) {
      const again = await h.app.inject({ method: 'DELETE', url: `/api/jobs/${id}` });
      expect(again.statusCode).toBe(404);
    }
  });

  it('deletes a running job (abort-then-remove) and an unknown id 404s', async (): Promise<void> => {
    const h = buildHarness();
    const running = await createJob(h);
    h.jobs.forceState(running, 'running');
    const res = await h.app.inject({ method: 'DELETE', url: `/api/jobs/${running}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { job: JobWire }).job.state).toBe('running'); // the removed snapshot
    expect(await h.app.inject({ method: 'GET', url: `/api/jobs/${running}` })).toMatchObject({ statusCode: 404 });
  });
});

describe('POST /api/jobs/bulk-action — toolbar semantics (idempotent)', (): void => {
  it('pause all: holds queued, cancels running/retry; second pass affects 0', async (): Promise<void> => {
    const { h, ids } = await matrixHarness();
    const first = await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'pause', scope: 'all' } });
    expect(first.statusCode).toBe(200);
    const body1 = first.json() as { affected: number; jobs: JobWire[] };
    // queued + held(no-op skip) + running + retry = 3 touched
    expect(body1.affected).toBe(3);

    const second = await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'pause', scope: 'all' } });
    expect((second.json() as { affected: number }).affected).toBe(0); // idempotent
    expect((await getJob(h, ids['queued'] as string)).paused).toBe(true);
    expect((await getJob(h, ids['running'] as string)).state).toBe('cancelled');
  });

  it('resume all: lifts holds + re-enqueues cancelled; second pass affects 0', async (): Promise<void> => {
    const { h } = await matrixHarness();
    await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'pause', scope: 'all' } });
    const resume = await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'resume', scope: 'all' } });
    expect(resume.statusCode).toBe(200);
    const body = resume.json() as { affected: number; jobs: JobWire[] };
    // 2 held rows lifted + 3 cancelled rows re-enqueued (running and
    // retry — both cancelled by pause-all — plus the seeded one).
    expect(body.affected).toBe(5);
    expect(body.jobs.every((job): boolean => job.state === 'queued')).toBe(true);

    const second = await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'resume', scope: 'all' } });
    expect((second.json() as { affected: number }).affected).toBe(0);
  });

  it('delete completed: removes ONLY done rows, artifacts kept; second pass affects 0', async (): Promise<void> => {
    const deletedPaths: string[] = [];
    const h = buildHarness({
      jobs: new InMemoryJobService((path): boolean => {
        deletedPaths.push(path);
        return true;
      }),
    });
    const done1 = await createJob(h);
    const done2 = await createJob(h);
    const live = await createJob(h);
    h.jobs.forceState(done1, 'done', { libraryPath: '/tmp/lib/1.zip' });
    h.jobs.forceState(done2, 'done', { libraryPath: '/tmp/lib/2.zip' });

    const first = await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'delete', scope: 'completed' } });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { affected: number };
    expect(body.affected).toBe(2);
    expect(deletedPaths).toEqual([]); // FMD2 RemoveAllFinishedTasks keeps files
    expect(await h.app.inject({ method: 'GET', url: `/api/jobs/${live}` })).toMatchObject({ statusCode: 200 });

    const second = await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'delete', scope: 'completed' } });
    expect((second.json() as { affected: number }).affected).toBe(0);
  });

  it('illegal scope pairings → 400', async (): Promise<void> => {
    const h = buildHarness();
    const a = await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'pause', scope: 'completed' } });
    expect(a.statusCode).toBe(400);
    expectEnvelope(a.body, 'bad_request');
    const b = await h.app.inject({ method: 'POST', url: '/api/jobs/bulk-action', payload: { action: 'delete', scope: 'all' } });
    expect(b.statusCode).toBe(400);
  });
});

describe('GET /api/jobs — downloads-parity filters', (): void => {
  it('states csv multi-select ORs the states; unknown member → validation_error', async (): Promise<void> => {
    const h = buildHarness();
    await createJob(h, { chapterName: 'Ch. A' });
    const running = await createJob(h, { chapterName: 'Ch. B' });
    h.jobs.forceState(running, 'running');

    const both = await h.app.inject({ method: 'GET', url: '/api/jobs?states=queued,running' });
    expect((both.json() as { jobs: JobWire[] }).jobs).toHaveLength(2);
    const one = await h.app.inject({ method: 'GET', url: '/api/jobs?states=running' });
    expect((one.json() as { jobs: JobWire[] }).jobs).toHaveLength(1);

    const bad = await h.app.inject({ method: 'GET', url: '/api/jobs?states=queued,nope' });
    expect(bad.statusCode).toBe(400);
    expectEnvelope(bad.body, 'validation_error');
  });

  it('q matches mangaTitle OR chapterName, case-insensitive', async (): Promise<void> => {
    const h = buildHarness();
    await createJob(h, { mangaTitle: 'Alpha Quest', chapterName: 'Ch. 1' });
    await createJob(h, { mangaTitle: 'Beta Trails', chapterName: 'The middle' });

    const byTitle = await h.app.inject({ method: 'GET', url: '/api/jobs?q=alpha' });
    expect((byTitle.json() as { jobs: JobWire[] }).jobs).toHaveLength(1);
    const byChapter = await h.app.inject({ method: 'GET', url: '/api/jobs?q=MIDDLE' });
    expect((byChapter.json() as { jobs: JobWire[] }).jobs).toHaveLength(1);
    const none = await h.app.inject({ method: 'GET', url: '/api/jobs?q=zzz' });
    expect((none.json() as { jobs: JobWire[] }).jobs).toHaveLength(0);
  });

  it('addedFrom/addedTo bound the created-at window (inclusive UTC days)', async (): Promise<void> => {
    const h = buildHarness();
    const fresh = await createJob(h, { chapterName: 'today' });
    const old = await createJob(h, { chapterName: 'old' });
    const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    h.jobs.forceState(old, 'queued', undefined, `${oldDate}T12:00:00.000Z`);

    const windowed = await h.app.inject({ method: 'GET', url: `/api/jobs?addedFrom=${today}&addedTo=${today}` });
    const windowJobs = (windowed.json() as { jobs: JobWire[] }).jobs;
    expect(windowJobs).toHaveLength(1);
    expect(windowJobs[0]?.id).toBe(fresh);

    const older = await h.app.inject({ method: 'GET', url: `/api/jobs?addedTo=${oldDate}` });
    const olderJobs = (older.json() as { jobs: JobWire[] }).jobs;
    expect(olderJobs).toHaveLength(1);
    expect(olderJobs[0]?.id).toBe(old);

    const both = await h.app.inject({ method: 'GET', url: `/api/jobs?addedFrom=${oldDate}` });
    expect((both.json() as { jobs: JobWire[] }).jobs).toHaveLength(2);
  });
});
