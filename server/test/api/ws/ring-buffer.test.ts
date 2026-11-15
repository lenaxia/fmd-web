/**
 * D19 ring buffer unit tests (DESIGN.md §10/D19): the boundary cases
 * the reconnect decision leans on — capacity eviction, the age bound
 * (exactly 15 min is evicted, 1 ms under is retained), the eviction
 * watermark, and replay slicing. The clock is injected, so every
 * boundary is exercised deterministically.
 */
import { describe, expect, it } from 'vitest';
import { JobEventRingBuffer } from '../../../src/api/ws/ring-buffer.js';

const CAPACITY = 4;
const MAX_AGE_MS = 15 * 60 * 1000;

function makeBuffer(now: () => number = () => 0): JobEventRingBuffer<string> {
  return new JobEventRingBuffer<string>({ capacity: CAPACITY, maxAgeMs: MAX_AGE_MS, now });
}

describe('JobEventRingBuffer', (): void => {
  it('retains up to capacity without eviction', (): void => {
    const ring = makeBuffer();
    for (let id = 1; id <= CAPACITY; id += 1) {
      ring.append(id, `e${String(id)}`);
    }
    expect(ring.size).toBe(CAPACITY);
    expect(ring.oldestId).toBe(1);
    expect(ring.newestId).toBe(CAPACITY);
    expect(ring.lastEvictedId).toBe(0);
  });

  it('evicts exactly the OLDEST entry at capacity overflow (drop-oldest)', (): void => {
    const ring = makeBuffer();
    for (let id = 1; id <= CAPACITY + 1; id += 1) {
      ring.append(id, `e${String(id)}`);
    }
    expect(ring.size).toBe(CAPACITY);
    expect(ring.oldestId).toBe(2);
    expect(ring.newestId).toBe(CAPACITY + 1);
    expect(ring.lastEvictedId).toBe(1);
  });

  it('keeps evicting oldest-first for large overflow (1001st of 1000)', (): void => {
    const ring = new JobEventRingBuffer<number>({ capacity: 1000, maxAgeMs: MAX_AGE_MS, now: () => 0 });
    for (let id = 1; id <= 1001; id += 1) {
      ring.append(id, id);
    }
    expect(ring.size).toBe(1000);
    expect(ring.oldestId).toBe(2);
    expect(ring.lastEvictedId).toBe(1);
  });

  it('age boundary: age == maxAgeMs is EVICTED (retention strictly under the bound)', (): void => {
    let now = 1000;
    const ring = makeBuffer(() => now);
    ring.append(1, 'old', 1000);
    // Exactly at the bound → evicted.
    now = 1000 + MAX_AGE_MS;
    expect(ring.sweep()).toBe(1);
    expect(ring.isEmpty).toBe(true);
    expect(ring.lastEvictedId).toBe(1);
  });

  it('age boundary: 1 ms under maxAgeMs is retained', (): void => {
    let now = 1000;
    const ring = makeBuffer(() => now);
    ring.append(1, 'fresh', 1000);
    now = 1000 + MAX_AGE_MS - 1;
    expect(ring.sweep()).toBe(0);
    expect(ring.size).toBe(1);
  });

  it('sweep evicts a contiguous OLD prefix, never younger entries', (): void => {
    let now = 0;
    const ring = makeBuffer(() => now);
    ring.append(1, 'a', 0);
    ring.append(2, 'b', 0);
    ring.append(3, 'c', MAX_AGE_MS - 1); // young
    now = MAX_AGE_MS;
    expect(ring.sweep()).toBe(2);
    expect([...ring.replay(0).map((e) => e.id)]).toEqual([3]);
    expect(ring.lastEvictedId).toBe(2);
  });

  it('sweep on an empty buffer is a no-op (watermark untouched)', (): void => {
    let now = 0;
    const ring = makeBuffer(() => now);
    expect(ring.sweep(MAX_AGE_MS * 10)).toBe(0);
    expect(ring.lastEvictedId).toBe(0);
    ring.append(1, 'x', 0);
    now = MAX_AGE_MS;
    expect(ring.sweep()).toBe(1);
    expect(ring.sweep(MAX_AGE_MS * 20)).toBe(0);
    expect(ring.lastEvictedId).toBe(1);
  });

  it('the eviction watermark is the MAX across capacity AND age evictions', (): void => {
    let now = 0;
    const ring = makeBuffer(() => now);
    for (let id = 1; id <= CAPACITY + 2; id += 1) {
      ring.append(id, `e${String(id)}`, 0);
    }
    // capacity evicted ids 1,2 → watermark 2
    expect(ring.lastEvictedId).toBe(2);
    now = MAX_AGE_MS + 5;
    ring.append(CAPACITY + 3, 'e7', now); // capacity evicts 3; age sweep evicts 4..6
    expect(ring.sweep()).toBe(3);
    expect(ring.lastEvictedId).toBe(6);
  });

  it('replay(afterId) returns strictly increasing ids > afterId only', (): void => {
    const ring = makeBuffer();
    for (let id = 1; id <= CAPACITY; id += 1) {
      ring.append(id, `e${String(id)}`);
    }
    expect(ring.replay(0).map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(ring.replay(2).map((e) => e.id)).toEqual([3, 4]);
    expect(ring.replay(4)).toEqual([]);
    expect(ring.replay(99)).toEqual([]);
    // Entries carry their payload unchanged.
    expect(ring.replay(2).map((e) => e.value)).toEqual(['e3', 'e4']);
  });

  it('rejects non-increasing ids (hub monotonicity is caller-enforced)', (): void => {
    const ring = makeBuffer();
    ring.append(1, 'a');
    expect(() => ring.append(1, 'dup')).toThrow(/increase strictly/);
    expect(() => ring.append(0, 'backwards')).toThrow(/increase strictly/);
    expect(ring.size).toBe(1);
  });

  it('capacity 1 keeps exactly the newest event', (): void => {
    const ring = new JobEventRingBuffer<string>({ capacity: 1, maxAgeMs: MAX_AGE_MS, now: () => 0 });
    ring.append(1, 'a');
    ring.append(2, 'b');
    expect(ring.size).toBe(1);
    expect(ring.replay(0).map((e) => e.value)).toEqual(['b']);
    expect(ring.lastEvictedId).toBe(1);
  });

  it('rejects invalid construction (capacity < 1, negative age)', (): void => {
    expect(() => new JobEventRingBuffer<string>({ capacity: 0, maxAgeMs: 1 })).toThrow(/capacity/);
    expect(() => new JobEventRingBuffer<string>({ capacity: 1, maxAgeMs: -1 })).toThrow(/maxAgeMs/);
  });
});
