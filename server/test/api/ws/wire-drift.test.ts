/**
 * Wire drift test (acceptance: "shared zod types used by both server
 * and web client — type-drift test"): the CONTRACT package's `JobSchema`
 * — the zod source the WS hub serializes event snapshots from — must
 * stay semantically identical to the committed OpenAPI snapshot's `Job`
 * component that generated the SPA's typed REST client. A REST-side
 * shape change that does not go through the shared schema, or a
 * snapshot regenerated against a locally redefined schema, fails here.
 *
 * Reproduces openapi.ts's exact conversion (same globalRegistry ids +
 * `z.toJSONSchema` options) against the committed snapshot.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  JobSchema,
  TimestampSchema,
  WsHelloMessageSchema,
  WsServerMessageSchema,
  type JobT,
  type WsServerMessageT,
} from '@fmd/contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(HERE, '../../../src/api/openapi.snapshot.json');
const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
  components: { schemas: Record<string, unknown> };
};

// Identical to openapi.ts REGISTRY — same ids so `$defs` keys match.
z.globalRegistry.add(JobSchema, { id: 'Job' });
z.globalRegistry.add(TimestampSchema, { id: 'Timestamp' });

/** openapi.ts convertSchema + REGISTRY-component extraction replica
 * (io 'input' for registry components; the root def IS the component). */
function convertToComponent(schema: z.ZodType, id: string): {
  component: Record<string, unknown>;
  defs: Record<string, Record<string, unknown>>;
} {
  const converted = z.toJSONSchema(schema, {
    io: 'input',
    reused: 'ref',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete converted['$schema'];
  rewriteRefs(converted, new Set<unknown>());
  const defs = (converted['$defs'] ?? {}) as Record<string, Record<string, unknown>>;
  const self = defs[id];
  const component = self !== undefined ? self : converted;
  return { component, defs };
}

/** Rewrite `#/$defs/X` refs to `#/components/schemas/X` (recursive). */
function rewriteRefs(node: unknown, seen: Set<unknown>): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) {
    return;
  }
  seen.add(node);
  const record = node as Record<string, unknown>;
  if (typeof record['$ref'] === 'string' && record['$ref'].startsWith('#/$defs/')) {
    record['$ref'] = `#/components/schemas/${record['$ref'].slice('#/$defs/'.length)}`;
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === 'object') {
      rewriteRefs(value, seen);
    }
  }
}

function sampleJob(): JobT {
  return {
    id: '17',
    type: 'download',
    moduleId: 'a'.repeat(32),
    payload: { moduleId: 'a'.repeat(32), mangaUrl: 'https://ex.org/m', chapterLink: 'ch/1' },
    state: 'running',
    priority: 0,
    progress: { page: 3 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('contract wire schemas vs the committed OpenAPI snapshot', (): void => {
  it('shared JobSchema converts EXACTLY to the snapshot Job component', (): void => {
    const { component, defs } = convertToComponent(JobSchema, 'Job');
    expect(component).toEqual(snapshot.components.schemas['Job']);
    expect(defs['Timestamp']).toEqual(snapshot.components.schemas['Timestamp']);
  });

  it('a snapshot job body parses through the shared schema (both directions agree)', (): void => {
    const wire = sampleJob() as unknown as Record<string, unknown>;
    // The snapshot shape (from the generated client fixtures) is valid.
    expect(JobSchema.safeParse(wire).success).toBe(true);
    // …and the parsed value round-trips onto the REST response type.
    expect(JobSchema.parse(wire)).toEqual(wire);
  });

  it('WS frames validate through the shared message schemas', (): void => {
    const event: WsServerMessageT = { type: 'event', id: '42', job: JobSchema.parse(sampleJob()) };
    expect(WsServerMessageSchema.parse(event)).toEqual(event);
    expect(WsServerMessageSchema.parse({ type: 'resync' })).toEqual({ type: 'resync' });
    expect(WsServerMessageSchema.parse({ type: 'gap', fromId: '7', toId: '9' })).toEqual({
      type: 'gap',
      fromId: '7',
      toId: '9',
    });
    // Cursor discipline is part of the schema (decimal ids only).
    expect(() => WsServerMessageSchema.parse({ type: 'event', id: 'e42', job: event.job })).toThrow();
    expect(WsHelloMessageSchema.safeParse({ type: 'hello', lastEventId: '41' }).success).toBe(true);
    expect(WsHelloMessageSchema.safeParse({ type: 'hello', lastEventId: '41x' }).success).toBe(false);
  });
});
