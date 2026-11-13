import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MockNormalizationEngine,
  MockQueryEngine,
} from '../runner/mock-engine.js';
import { REPORT_SCHEMA_VERSION, runCorpus } from '../runner/replay.js';
import {
  buildFullCorpus,
  loadSeedManifest,
  type CorpusCase,
  type SeedEntry,
} from '../runner/corpus-loader.js';
import type {
  ParsedQueryDocument,
  QueryEngineResult,
  QueryExpression,
} from '@fmd/contract';

/**
 * Seed-corpus integration (§13.1): the ≥50 recorded seed modules
 * replay through the loader + MockQueryEngine fully offline with
 * deterministic results, and the report validates against the
 * versioned schema.
 */

const seedRoot = fileURLToPath(new URL('../fixtures/seed', import.meta.url));

const NAMED_SEEDS = [
  'ComicK', 'MangaPlus', 'Madara', 'EHentai', 'Tapas',
  'Hentai2Read', 'MangaDex', '18Comic', 'MangaGo', 'AsuraScans',
] as const;

function seedDirs(): string[] {
  return readdirSync(seedRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(seedRoot, d.name))
    .sort();
}

/** Full corpus: all seed expression cases + capture normalization cases. */
function fullCorpus(): CorpusCase[] {
  const captureDir = fileURLToPath(
    new URL('../fixtures/capture', import.meta.url),
  );
  return buildFullCorpus(seedRoot, captureDir);
}

/** Seed the mock engine with every case's captured truth. */
function seededMockFor(cases: readonly CorpusCase[]): MockQueryEngine {
  const mock = new MockQueryEngine();
  const docs = new Map<string, ParsedQueryDocument>();
  for (const c of cases) {
    if (c.type !== 'expression') continue;
    const key = `${c.document.kind}:${c.document.content}`;
    let doc = docs.get(key);
    if (doc === undefined) {
      doc = mock.parse(c.document.kind, c.document.content);
      docs.set(key, doc);
    }
    const expr: QueryExpression = c.expression;
    let result: QueryEngineResult;
    switch (c.expected.resultKind) {
      case 'scalar':
        result = {
          ok: true,
          scalar: c.expected.result as string,
          list: [],
          count: 0,
        };
        break;
      case 'list': {
        const list = c.expected.result as string[];
        result = {
          ok: true,
          scalar: list[0] ?? '',
          list,
          count: list.length,
        };
        break;
      }
      case 'count':
        result = {
          ok: true,
          scalar: '',
          list: [],
          count: c.expected.result as number,
        };
        break;
      default:
        // 'empty' — swallow semantics: record nothing; the mock's
        // error path IS the expected behavior.
        continue;
    }
    mock.record(doc, expr, result);
  }
  return mock;
}

function seededNormalizationFor(
  cases: readonly CorpusCase[],
): MockNormalizationEngine {
  const norm = new MockNormalizationEngine();
  for (const c of cases) {
    if (c.type !== 'normalization') continue;
    const input = c.input as Record<string, unknown>;
    const raw =
      typeof input === 'object' &&
      input !== null &&
      'rawModuleOutput' in input
        ? (input['rawModuleOutput'] as Record<string, unknown>)
        : input;
    norm.record(
      raw,
      c.expected as Record<string, unknown>,
    );
  }
  return norm;
}

describe('seed corpus — coverage (§13.1)', (): void => {
  it('has ≥50 seed modules, all 10 named special cases present', (): void => {
    const dirs = seedDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(50);
    const names = new Set(dirs.map((d) => d.split('/').pop()));
    for (const must of NAMED_SEEDS) {
      expect(names.has(must), `missing seed ${must}`).toBe(true);
    }
  });

  it('every seed dir has a valid manifest and triples file', (): void => {
    for (const dir of seedDirs()) {
      const loaded = loadSeedManifest(dir); // throws when malformed
      expect(loaded.manifest.entries.length).toBeGreaterThan(0);
      for (const entry of loaded.manifest.entries) {
        expect(existsSync(join(dir, entry.file)), entry.file).toBe(true);
      }
      expect(existsSync(join(dir, 'triples.json')), dir).toBe(true);
    }
  });

  it('named special-case modules carry real recorded fixtures', (): void => {
    // MangaPlus is protobuf provenance (pb.decode); the rest must
    // contribute queryable documents and oracle triples.
    for (const name of NAMED_SEEDS) {
      const dir = join(seedRoot, name);
      const manifest = loadSeedManifest(dir).manifest;
      expect(manifest.entries[0]?.url).toMatch(/^https?:\/\//);
      const size = statSync(join(dir, manifest.entries[0]!.file)).size;
      expect(size, `${name} fixture too small to be real`).toBeGreaterThan(300);
    }
  });

  it('special-case module coverage mix: JSON API, protobuf, templates, account, list-fill', (): void => {
    const kindOf = (name: string): SeedEntry['kind'] =>
      loadSeedManifest(join(seedRoot, name)).manifest.entries[0]!.kind;
    expect(kindOf('ComicK')).toBe('json');
    expect(kindOf('MangaPlus')).toBe('protobuf');
    expect(kindOf('MangaDex')).toBe('json');
    expect(kindOf('Madara')).toBe('html');
    expect(kindOf('EHentai')).toBe('html');
    expect(kindOf('Hentai2Read')).toBe('html');
    // Template-family seeds recorded with their template tag.
    const madaraManifest = loadSeedManifest(join(seedRoot, 'Madara')).manifest;
    expect(madaraManifest.template).toBe('Madara');
  });
});

describe('seed corpus — offline replay (MockQueryEngine)', (): void => {
  it('replays the FULL corpus with 100% pass and deterministic reports', (): void => {
    const cases = fullCorpus();
    // The corpus must be substantial: every seed module's oracle triples
    // plus the FPC normalization captures.
    expect(cases.length).toBeGreaterThan(500);

    const run = (): string => {
      const report = runCorpus(cases, seededMockFor(cases), {
        normalization: seededNormalizationFor(cases),
      });
      return JSON.stringify(report);
    };
    const a = run();
    const b = run();
    expect(a).toBe(b);

    const report = JSON.parse(a) as {
      schemaVersion: number;
      summary: { cases: number; passed: number; failed: number; passRate: number };
      modules: { module: string; cases: unknown[] }[];
    };
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passRate).toBe(1);
    expect(report.summary.cases).toBe(cases.length);
    // ≥50 modules contribute expression cases to the report.
    expect(report.modules.length).toBeGreaterThanOrEqual(50);
  });

  it('a corrupted truth flips exactly its own case to fail with detail', (): void => {
    const cases = fullCorpus();
    const mock = seededMockFor(cases);
    const victim = cases.find(
      (c) => c.type === 'expression' && c.expected.resultKind === 'scalar',
    );
    expect(victim).toBeDefined();
    if (victim?.type !== 'expression') return;
    // Break one recording: append junk to that expression's result.
    const doc = mock.parse(
      victim.document.kind,
      victim.document.content,
    );
    const truth = victim.expected.result as string;
    mock.record(doc, victim.expression, {
      ok: true,
      scalar: truth + '!!MUTATED!!',
      list: [],
      count: 0,
    });
    const report = runCorpus(mock ? cases : [], mock, {
      normalization: seededNormalizationFor(cases),
    });
    expect(report.summary.failed).toBe(1);
    const mod = report.modules.find((m) => m.module === victim.module);
    const failedCase = mod?.cases.find((c) => c.status !== 'pass');
    expect(failedCase?.fixtureId).toBe(victim.fixtureId);
    expect(failedCase?.mismatch?.field).toBe('scalar');
  });

  it('every seed module with queryable fixtures contributes report cases', (): void => {
    const cases = fullCorpus();
    const caseModules = new Set(
      cases.filter((c) => c.type === 'expression').map((c) => c.module),
    );
    // MangaPlus (protobuf) and manifest-only stubs contribute 0 —
    // everything else with html/json fixtures must appear.
    for (const name of NAMED_SEEDS) {
      const manifest = loadSeedManifest(join(seedRoot, name)).manifest;
      const queryable = manifest.entries.some(
        (e) => e.kind === 'html' || e.kind === 'json' || e.kind === 'xml',
      );
      if (!queryable) continue;
      const triples = JSON.parse(
        readFileSync(join(seedRoot, name, 'triples.json'), 'utf8'),
      ) as { triples: { expression?: string }[] };
      const hasExpressions = triples.triples.some((t) => t.expression);
      if (hasExpressions) {
        expect(
          caseModules.has(name),
          `no report cases for ${name}`,
        ).toBe(true);
      }
    }
  });
});
