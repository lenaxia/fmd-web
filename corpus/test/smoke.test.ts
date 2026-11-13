import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isFixtureTriple,
  loadFixture,
  type FixtureTriple,
} from '../runner/fixture-loader.js';

const seedFixture = fileURLToPath(
  new URL('../fixtures/seed/getinfo-normalization-0001.json', import.meta.url),
);

describe('corpus runner (§13.1 — offline)', (): void => {
  it('loads and validates the §5.8 normalization seed fixture', (): void => {
    const fx: FixtureTriple = loadFixture(seedFixture);
    expect(fx.kind).toBe('getinfo-normalization');
    expect(fx.meta.captured).toBe(false);
    expect(fx.meta.synthetic).toBe(true);
    // Last-occurrence-wins dedupe (§5.8 step 4): 3 raw links, 2 survive.
    const links: unknown = (fx.expected as Record<string, unknown>)['postProcessed'];
    const post = (links as Record<string, unknown>)['chapterLinks'];
    expect(post).toEqual(['/manga/x/ch-1', '/manga/x/ch-2']);
    expect((links as Record<string, unknown>)['numChapter']).toBe(2);
  });

  it('rejects malformed triples loudly', (): void => {
    expect(isFixtureTriple('nope')).toBe(false);
    expect(isFixtureTriple(null)).toBe(false);
    expect(isFixtureTriple({ id: '', moduleId: 'x', kind: 'xpath' })).toBe(false);
    expect(
      isFixtureTriple({
        id: 'seed/x',
        moduleId: 'NOT-HEX',
        kind: 'xpath',
        input: {},
        expected: {},
        meta: { captured: true, synthetic: false },
      }),
    ).toBe(false);
    expect(
      isFixtureTriple({
        id: 'seed/x',
        moduleId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        kind: 'xpath',
        input: {},
        expected: {},
        meta: { captured: true },
      }),
    ).toBe(false);
  });
});
