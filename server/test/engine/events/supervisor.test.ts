import { describe, expect, it } from 'vitest';
import type { EventDispatchResult } from '@fmd/contract';
import {
  DEFAULT_SUPERVISOR_OPTIONS,
  EngineSupervisor,
  rssRecycleThresholdBytes,
  type AttemptOutcome,
  type SupervisorEngine,
  type SupervisedExecution,
} from '../../../src/engine/events/supervisor.js';

/** Narrowing assert: expect() does not narrow, TS2339 otherwise. */
function assertFailed(
  outcome: SupervisedExecution,
): Extract<SupervisedExecution, { status: 'failed' }> {
  if (outcome.status !== 'failed') {
    throw new Error(`expected a failed outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

/**
 * Fault-injection tests for the §4/§5.12 robustness policy (FAKE engines):
 * hang → deadline → HTTP-abort → job fail; double non-HTTP hang → worker
 * recycle + `worker_stalled`; LUA_ERRMEM → engine quarantine + rebuild +
 * retry-once → `engine_oom` (D6); RSS budget recycling at 25 % over (§5.12).
 */

const LUA_ERRMEM = 'not enough memory';

/**
 * Scripted FAKE engine: the factory hands each engine its own script and
 * the engine cycles it — engine 1 keeps OOMing/hanging on every attempt,
 * the rebuilt engine 2 (etc.) behaves per its own script.
 */
class FakeEngine implements SupervisorEngine {
  readonly lifecycle: string[] = [];
  private cursor = 0;

  constructor(
    readonly id: string,
    private readonly script: readonly AttemptOutcome[],
    readonly footprint: number = 0,
  ) {}

  run(): AttemptOutcome {
    const outcome = this.script[this.cursor % this.script.length];
    this.cursor += 1;
    return outcome ?? { kind: 'error', reason: 'empty script' };
  }

  rssBytes(): number {
    return this.footprint;
  }

  dispose(): void {
    this.lifecycle.push('disposed');
  }
}

/** One script per engine, in build order (index 0 = first engine). */
function fakeFactory(scripts: AttemptOutcome[][], footprint = 0): {
  create: (id: string) => SupervisorEngine;
  engines: FakeEngine[];
} {
  const engines: FakeEngine[] = [];
  return {
    engines,
    create: (id: string) => {
      const engine = new FakeEngine(id, scripts[engines.length] ?? [], footprint);
      engines.push(engine);
      return engine;
    },
  };
}

function completed(result: EventDispatchResult = { kind: 'boolean', value: true }): AttemptOutcome {
  return { kind: 'completed', result };
}

function hungDeadline(wedged: boolean): AttemptOutcome {
  return {
    kind: 'deadline-missed',
    wedged,
    reason: wedged ? 'deadline exceeded (wasm loop wedged)' : 'deadline exceeded (HTTP aborted)',
  };
}

describe('EngineSupervisor — fault injection (§4, §5.12, D6)', () => {
  it('a clean event completes without touching the engine lifecycle', () => {
    const factory = fakeFactory([[completed()]]);
    const supervisor = new EngineSupervisor(factory.create, DEFAULT_SUPERVISOR_OPTIONS);

    const outcome = supervisor.runAttempt();

    expect(outcome).toEqual({
      status: 'done',
      result: { kind: 'boolean', value: true },
      attempts: 1,
    });
    expect(factory.engines).toHaveLength(1);
    expect(factory.engines[0]?.lifecycle).toEqual([]);
  });

  it('hang → deadline → HTTP-abort → job fails (worker survives, no recycle)', () => {
    const factory = fakeFactory([[hungDeadline(false), completed()]]);
    const supervisor = new EngineSupervisor(factory.create, DEFAULT_SUPERVISOR_OPTIONS);

    const outcome = supervisor.runAttempt();

    expect(outcome).toEqual({
      status: 'failed',
      failureKind: 'net',
      reason: expect.stringContaining('deadline exceeded'),
      attempts: 1,
    });
    // an interrupted (non-wedged) miss is not a stall strike
    expect(supervisor.strikeCount).toBe(0);
    expect(factory.engines[0]?.lifecycle).toEqual([]);
    expect(supervisor.log.map((e) => e.type)).toEqual(['deadline-missed']);
  });

  it('a first wedged (non-HTTP) miss fails the event but keeps the worker', () => {
    const factory = fakeFactory([[hungDeadline(true)]]);
    const supervisor = new EngineSupervisor(factory.create, DEFAULT_SUPERVISOR_OPTIONS);

    const outcome = supervisor.runAttempt();

    expect(assertFailed(outcome).failureKind).toBe('net');
    expect(supervisor.strikeCount).toBe(1);
    expect(factory.engines).toHaveLength(1); // no recycle yet
    expect(factory.engines[0]?.lifecycle).toEqual([]);
  });

  it('double-hang → worker recycled, job fails worker_stalled, strikes reset', () => {
    const factory = fakeFactory([[hungDeadline(true)]]);
    const supervisor = new EngineSupervisor(factory.create, DEFAULT_SUPERVISOR_OPTIONS);

    supervisor.runAttempt(); // strike 1
    const outcome = supervisor.runAttempt(); // strike 2 → recycle

    expect(outcome).toEqual({
      status: 'failed',
      failureKind: 'worker_stalled',
      reason: expect.stringContaining('worker recycled'),
      attempts: 2,
    });
    // old engine disposed, a fresh engine built and installed
    expect(factory.engines).toHaveLength(2);
    expect(factory.engines[0]?.lifecycle).toEqual(['disposed']);
    expect(supervisor.engine.id).toBe('engine-2');
    expect(supervisor.strikeCount).toBe(0);
    expect(supervisor.log.map((e) => e.type)).toEqual([
      'deadline-missed',
      'deadline-missed',
      'worker-recycled',
      'engine-rebuilt',
    ]);
  });

  it('LUA_ERRMEM → quarantine + rebuild, retry succeeds → done (D6)', () => {
    const factory = fakeFactory([
      [{ kind: 'engine-oom', reason: LUA_ERRMEM }],
      [completed({ kind: 'code', value: 0, readBack: {} })],
    ]);
    const supervisor = new EngineSupervisor(factory.create, DEFAULT_SUPERVISOR_OPTIONS);

    const outcome = supervisor.runAttempt();

    expect(outcome).toEqual({
      status: 'done',
      result: { kind: 'code', value: 0, readBack: {} },
      attempts: 2,
    });
    // engine 1 quarantined (disposed), engine 2 rebuilt and used for the retry
    expect(factory.engines).toHaveLength(2);
    expect(factory.engines[0]?.lifecycle).toEqual(['disposed']);
    expect(factory.engines[1]?.lifecycle).toEqual([]);
    expect(supervisor.log.map((e) => e.type)).toEqual([
      'engine-quarantined',
      'engine-rebuilt',
    ]);
  });

  it('LUA_ERRMEM → quarantine + rebuild, retry OOMs again → job fails engine_oom (D6)', () => {
    const factory = fakeFactory([[{ kind: 'engine-oom', reason: LUA_ERRMEM }], [{ kind: 'engine-oom', reason: LUA_ERRMEM }]]);
    const supervisor = new EngineSupervisor(factory.create, DEFAULT_SUPERVISOR_OPTIONS);

    const outcome = supervisor.runAttempt();

    expect(outcome).toEqual({
      status: 'failed',
      failureKind: 'engine_oom',
      reason: expect.stringContaining(LUA_ERRMEM),
      attempts: 2,
    });
    // exactly one retry: 2 engines used; both quarantined (disposed) —
    // the supervisor stays lazy until the next job needs an engine
    expect(factory.engines).toHaveLength(2);
    expect(factory.engines[0]?.lifecycle).toEqual(['disposed']);
    expect(factory.engines[1]?.lifecycle).toEqual(['disposed']);
    expect(supervisor.log.map((e) => e.type)).toEqual([
      'engine-quarantined',
      'engine-rebuilt',
      'engine-quarantined',
    ]);
    // the supervisor lazily rebuilds for the next job
    expect(supervisor.engine.id).toBe('engine-3');
  });

  it('RSS over 25% of the pool budget recycles the engine before the attempt', () => {
    const budget = 1024;
    const threshold = rssRecycleThresholdBytes({
      rssBudgetBytes: budget,
      rssRecycleFactor: 1.25,
    });
    expect(threshold).toBe(1280);

    let poolRss = threshold + 1; // strictly over threshold
    const factory = fakeFactory([[completed()], [completed()]]);
    const supervisor = new EngineSupervisor(
      factory.create,
      { ...DEFAULT_SUPERVISOR_OPTIONS, rssBudgetBytes: budget },
      () => poolRss,
    );

    const outcome = supervisor.runAttempt();
    expect(outcome.status).toBe('done');
    expect(factory.engines).toHaveLength(2); // recycled before the attempt
    expect(factory.engines[0]?.lifecycle).toEqual(['disposed']);
    expect(supervisor.log.map((e) => e.type)).toEqual(['rss-recycle', 'engine-rebuilt']);

    // back under budget: no further recycling
    poolRss = threshold - 1;
    supervisor.runAttempt();
    expect(factory.engines).toHaveLength(2);
  });

  it('engine RSS exactly at the recycle threshold does not recycle', () => {
    const budget = DEFAULT_SUPERVISOR_OPTIONS.rssBudgetBytes;
    let poolRss = rssRecycleThresholdBytes(DEFAULT_SUPERVISOR_OPTIONS); // == threshold
    const factory = fakeFactory([[completed()]]);
    const supervisor = new EngineSupervisor(
      factory.create,
      DEFAULT_SUPERVISOR_OPTIONS,
      () => poolRss,
    );
    supervisor.runAttempt();
    expect(factory.engines).toHaveLength(1);
    poolRss = rssRecycleThresholdBytes(DEFAULT_SUPERVISOR_OPTIONS) + 1;
    supervisor.runAttempt();
    expect(factory.engines).toHaveLength(2);
    expect(budget).toBe(2 * 1024 ** 3);
  });

  it('a completed event after a wedged miss resets the strike ledger', () => {
    const factory = fakeFactory([[hungDeadline(true), completed(), hungDeadline(true), completed()]]);
    const supervisor = new EngineSupervisor(factory.create, DEFAULT_SUPERVISOR_OPTIONS);

    supervisor.runAttempt(); // strike 1
    supervisor.runAttempt(); // completes → ledger reset
    expect(supervisor.strikeCount).toBe(0);
    const outcome = supervisor.runAttempt(); // strike 1 again — still under tolerance
    expect(assertFailed(outcome).failureKind).toBe('net');
    expect(factory.engines).toHaveLength(1); // never recycled
  });

  it('a plain module error fails the job without touching the engine', () => {
    const factory = fakeFactory([[{ kind: 'error', reason: 'module blew up' }]]);
    const supervisor = new EngineSupervisor(factory.create, DEFAULT_SUPERVISOR_OPTIONS);

    const outcome = supervisor.runAttempt();
    expect(outcome).toEqual({
      status: 'failed',
      failureKind: 'net',
      reason: 'module blew up',
      attempts: 1,
    });
    expect(factory.engines[0]?.lifecycle).toEqual([]);
  });
});
