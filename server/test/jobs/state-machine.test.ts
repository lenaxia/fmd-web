import { describe, expect, it } from 'vitest';
import type { JobState } from '@fmd/contract';
import { TRANSITIONS } from '../../src/jobs/lanes.js';
import {
  JOB_FAILURE_KINDS,
  InvalidJobTransitionError,
  MissingJobFailureKindError,
  assertJobTransition,
  isJobFailureKind,
  isTerminalJobState,
} from '../../src/jobs/queue/state-machine.js';

const ALL_STATES: readonly JobState[] = Object.keys(TRANSITIONS) as JobState[];

/** Every (from → to) edge declared legal by the §7.1 table. */
const LEGAL_EDGES: ReadonlyArray<readonly [JobState, JobState]> = ALL_STATES.flatMap((from) =>
  TRANSITIONS[from].map((to): readonly [JobState, JobState] => [from, to]),
);

/** Every (from → to) pair NOT in the table — each must throw. */
const ILLEGAL_EDGES: ReadonlyArray<readonly [JobState, JobState]> = ALL_STATES.flatMap((from) =>
  ALL_STATES.filter((to) => !TRANSITIONS[from].includes(to)).map(
    (to): readonly [JobState, JobState] => [from, to],
  ),
);

describe('§7.1 state machine — legal paths (enumerated from the table)', () => {
  it('the table covers exactly the §7.1 chain', () => {
    expect(TRANSITIONS.queued).toEqual(['running', 'cancelled']);
    expect(TRANSITIONS.running).toEqual(['retry', 'done', 'failed', 'cancelled']);
    expect(TRANSITIONS.retry).toEqual(['running', 'cancelled']);
    expect(TRANSITIONS.done).toEqual([]);
    expect(TRANSITIONS.failed).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(ALL_STATES).toHaveLength(6);
  });

  for (const [from, to] of LEGAL_EDGES) {
    it(`${from} → ${to} is legal`, () => {
      expect(
        to === 'failed'
          ? assertJobTransition(from, to, { failureKind: 'net' })
          : assertJobTransition(from, to),
      ).toBe(to);
    });
  }

  it('the full §7.1 lifecycle walks legally: queued→running→retry→running→done', () => {
    let state: JobState = 'queued';
    state = assertJobTransition(state, 'running');
    state = assertJobTransition(state, 'retry');
    state = assertJobTransition(state, 'running');
    state = assertJobTransition(state, 'done');
    expect(state).toBe('done');
  });

  it('every terminal state is closed (no outgoing edges)', () => {
    for (const state of ALL_STATES) {
      expect(isTerminalJobState(state)).toBe(TRANSITIONS[state].length === 0);
    }
    expect(ALL_STATES.filter(isTerminalJobState).sort()).toEqual(['cancelled', 'done', 'failed']);
  });
});

describe('§7.1 state machine — invalid transitions THROW', () => {
  const illegalCount: number = ILLEGAL_EDGES.length;

  it('there are illegal pairs to prove (sanity: 6×6 grid minus legal edges)', () => {
    expect(ALL_STATES.length * ALL_STATES.length - LEGAL_EDGES.length).toBe(illegalCount);
    expect(illegalCount).toBeGreaterThan(0);
  });

  for (const [from, to] of ILLEGAL_EDGES) {
    it(`${from} → ${to} throws InvalidJobTransitionError`, () => {
      expect(() => assertJobTransition(from, to)).toThrow(InvalidJobTransitionError);
      expect(() => assertJobTransition(from, to)).toThrow(
        `invalid job transition: ${from} → ${to}`,
      );
    });
  }

  it('a self-transition is always illegal (even from non-terminal states)', () => {
    for (const state of ALL_STATES) {
      expect(() => assertJobTransition(state, state)).toThrow(InvalidJobTransitionError);
    }
  });
});

describe('§7.1 failure classification (§4 kinds) is enforced', () => {
  it('→ failed WITHOUT a failureKind throws MissingJobFailureKindError', () => {
    expect(() => assertJobTransition('running', 'failed')).toThrow(MissingJobFailureKindError);
  });

  it('→ failed with an unknown failureKind throws MissingJobFailureKindError', () => {
    expect(() =>
      assertJobTransition('running', 'failed', {
        failureKind: 'bogus' as unknown as (typeof JOB_FAILURE_KINDS)[number],
      }),
    ).toThrow(MissingJobFailureKindError);
  });

  it('exactly the four §4 kinds are recognized', () => {
    expect([...JOB_FAILURE_KINDS].sort()).toEqual(['engine_oom', 'net', 'pack', 'worker_stalled']);
    for (const kind of JOB_FAILURE_KINDS) {
      expect(isJobFailureKind(kind)).toBe(true);
    }
    expect(isJobFailureKind('bogus')).toBe(false);
    expect(isJobFailureKind(undefined)).toBe(false);
  });

  it('→ failed with every legal kind passes', () => {
    for (const kind of JOB_FAILURE_KINDS) {
      expect(assertJobTransition('running', 'failed', { failureKind: kind })).toBe('failed');
    }
  });

  it('non-failed transitions must NOT carry a failureKind requirement (accepted but unused)', () => {
    expect(assertJobTransition('queued', 'running')).toBe('running');
  });
});
