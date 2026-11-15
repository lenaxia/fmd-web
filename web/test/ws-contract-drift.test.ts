/**
 * WS contract drift test (acceptance: "shared zod types used by both
 * server and (via package import) web client — type-drift test"): the
 * SPA speaks the SAME `/ws` protocol schemas the server hub validates
 * with — imported from `@fmd/contract` (workspace package), NOT
 * redefined here. Runtime level: every contract-valid server frame
 * parses through the client's hand-rolled (bundle-light) narrow, and
 * everything the client accepts satisfies the shared schema. Type
 * level: the client aliases ARE the contract types, and the OpenAPI-
 * generated `Job` projection composes with them (the full chain —
 * contract zod ↔ snapshot ↔ generated client — is pinned server-side
 * in `server/test/api/ws/wire-drift.test.ts` + `api-drift.test.ts`).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  JobSchema,
  WsHelloMessageSchema,
  WsServerMessageSchema,
  type JobT,
  type WsHelloMessageT,
  type WsJobEventMessageT,
  type WsServerMessageT,
} from '@fmd/contract';
import {
  eventJobToWire,
  type GapMessage,
  type HelloMessage,
  type JobEventMessage,
  type JobWire,
  type WsServerMessage,
} from '../src/state/ws-protocol';
import { parseServerMessage } from '../src/state/ws-backfill';
import { jobFixture } from './fixtures';

function frame(message: unknown): string {
  return JSON.stringify(message);
}

describe('client parser vs the shared contract schemas', (): void => {
  it('every contract-valid server frame round-trips through the client parser', (): Promise<void> => {
    const job = JobSchema.parse(jobFixture('j1', { state: 'running', progress: { page: 2 } })) as JobWire;
    const frames: WsServerMessageT[] = [
      { type: 'event', id: '1', job: job as JobWire } as WsJobEventMessageT,
      { type: 'resync' },
      { type: 'gap', fromId: '4', toId: '9' },
    ];
    for (const message of frames) {
      const wire = frame(WsServerMessageSchema.parse(message));
      const parsed = parseServerMessage(wire);
      expect(parsed).toEqual(JSON.parse(wire) as WsServerMessage);
      // And whatever the client accepts satisfies the shared schema.
      expect(WsServerMessageSchema.safeParse(parsed).success).toBe(true);
    }
    return Promise.resolve();
  });

  it('the client hello satisfies the shared hello schema', (): void => {
    const firstConnect: HelloMessage = { type: 'hello' };
    const reconnect: HelloMessage = { type: 'hello', lastEventId: '41' };
    expect(WsHelloMessageSchema.parse(firstConnect)).toEqual(firstConnect);
    expect(WsHelloMessageSchema.parse(reconnect)).toEqual(reconnect);
    expect(WsHelloMessageSchema.safeParse({ type: 'hello', lastEventId: 'nope' }).success).toBe(false);
  });

  it('rejects what the contract rejects (unknown type, non-decimal ids)', (): void => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(frame({ type: 'ping' }))).toBeNull();
    expect(parseServerMessage(frame({ type: 'gap', fromId: '4x', toId: '9' }))).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });

  it('the REST projection of an event job is a valid generated-client Job', (): void => {
    // Without optionals: the projection leaves them out entirely.
    const plain = jobFixture('j1', { state: 'running' });
    const wire = eventJobToWire({ type: 'event', id: '7', job: plain as JobEventMessage['job'] });
    expect(wire.id).toBe('j1');
    expect(wire.state).toBe('running');
    expect('progress' in wire).toBe(false);
    expect('error' in wire).toBe(false);
    // With optionals present, they are carried onto the wire projection.
    const rich = jobFixture('j2', { progress: { page: 2 }, error: 'x' });
    const richWire = eventJobToWire({ type: 'event', id: '8', job: rich as JobEventMessage['job'] });
    expect(richWire.progress).toEqual({ page: 2 });
    expect(richWire.error).toBe('x');
    // It feeds patchJobsPage directly (typed as the generated Job).
    expect(wire.type).toBe('download');
  });
});

describe('type-level drift pins (compile-time)', (): void => {
  it('client message types ARE the contract types (single source)', (): void => {
    expectTypeOf<JobEventMessage>().toEqualTypeOf<WsJobEventMessageT>();
    expectTypeOf<HelloMessage>().toEqualTypeOf<WsHelloMessageT>();
    expectTypeOf<WsServerMessage>().toEqualTypeOf<WsServerMessageT>();
    expectTypeOf<GapMessage['fromId']>().toEqualTypeOf<string>();
    // The event payload is the CONTRACT JobT (same zod source as REST),
    // and the projection targets the generated client's Job.
    expectTypeOf<JobEventMessage['job']>().toEqualTypeOf<JobT>();
    expectTypeOf<ReturnType<typeof eventJobToWire>>().toEqualTypeOf<JobWire>();
  });
});
