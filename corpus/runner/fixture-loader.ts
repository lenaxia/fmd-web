import { readFileSync } from 'node:fs';

/**
 * Corpus fixture loader (DESIGN.md §13.1) — offline ground-truth replay.
 *
 * A fixture is a TRIPLE: module input → expected FMD2 output, tagged by
 * kind and capture provenance. The runner validates the envelope shape
 * before any engine replays it, so malformed fixtures fail loudly.
 */

export type FixtureKind =
  | 'getinfo-normalization'
  | 'xpath'
  | 'json-node-tree'
  | 'list-fill'
  | 'css'
  | 'error-swallow';

export interface FixtureMeta {
  /** Recorded from FMD2 via the FPC harness (D1). */
  readonly captured: boolean;
  /** Authored from DESIGN.md semantics; must be replaced by a real capture. */
  readonly synthetic: boolean;
  readonly source?: string;
  readonly internettoolsCommit?: string | null;
}

export interface FixtureTriple {
  readonly id: string;
  /** 32-hex FMD2 module ID (join key everywhere, §2). */
  readonly moduleId: string;
  readonly kind: FixtureKind;
  readonly input: unknown;
  readonly expected: unknown;
  readonly meta: FixtureMeta;
}

const FIXTURE_KINDS: readonly FixtureKind[] = [
  'getinfo-normalization',
  'xpath',
  'json-node-tree',
  'list-fill',
  'css',
  'error-swallow',
];

const HEX_32 = /^[0-9a-f]{32}$/;

export function isFixtureTriple(value: unknown): value is FixtureTriple {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || rec['id'].length === 0) {
    return false;
  }
  if (typeof rec['moduleId'] !== 'string' || !HEX_32.test(rec['moduleId'])) {
    return false;
  }
  if (
    typeof rec['kind'] !== 'string' ||
    !(FIXTURE_KINDS as readonly string[]).includes(rec['kind'])
  ) {
    return false;
  }
  if (!('input' in rec) || !('expected' in rec)) {
    return false;
  }
  const meta: unknown = rec['meta'];
  if (typeof meta !== 'object' || meta === null) {
    return false;
  }
  const metaRec = meta as Record<string, unknown>;
  return (
    typeof metaRec['captured'] === 'boolean' &&
    typeof metaRec['synthetic'] === 'boolean'
  );
}

/** Load + validate one fixture file. Throws with a clear message offline. */
export function loadFixture(filePath: string): FixtureTriple {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!isFixtureTriple(parsed)) {
    throw new Error(`malformed fixture triple: ${filePath}`);
  }
  return parsed;
}
