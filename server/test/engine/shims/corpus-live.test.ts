import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildFullCorpus } from '@fmd/corpus/corpus-loader';
import { runCorpus, serializeCorpusReport } from '@fmd/corpus';
import type { NormalizationEngine } from '@fmd/contract';
import { normalizeMangaInfo } from '../../../src/engine/normalize/udata.js';
import { FontoXPathQueryEngine } from '../../../src/engine/shims/txquery-shim.js';

/**
 * Live corpus replay (DESIGN.md §13.1, acceptance criterion): the seed
 * corpus replays through the REAL query engine (FontoXPath + linkedom
 * behind the InternetTools dialect transform) and the FPC-oracle ground
 * truth. The versioned report is committed as golden evidence
 * (expected vs actual per expression); ≥99% result-equality or a
 * per-failure root cause in docs/COMPAT.md.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SEED_DIR = join(ROOT, 'corpus', 'fixtures', 'seed');
const CAPTURE_DIR = join(ROOT, 'corpus', 'fixtures', 'capture');
const GOLDEN_PATH = join(ROOT, 'server', 'test', 'engine', 'golden', 'seed-corpus-live-report.golden.json');

describe('live corpus replay (§13.1 FontoXPath engine vs FPC oracle)', () => {
  const cases = buildFullCorpus(SEED_DIR, CAPTURE_DIR);
  // §5.8 normalization engine adapter (uData.pas:85-207 pipeline): the
  // oracle's capture flag names map onto NormalizeFlags; absent keys
  // keep the uData defaults.
  const normalization: NormalizationEngine = {
    name: 'udata-normalize',
    normalize: (input, flags) =>
      normalizeMangaInfo(input, {
        isRemoveHostFromChapterLinks: flags?.['removeHostFromChapterLinks'] ?? true,
        OptionRemoveMangaNameFromChapter:
          flags?.['optionRemoveMangaNameFromChapter'] ?? false,
      }) as unknown as Record<string, unknown>,
  };
  const report = runCorpus(cases, new FontoXPathQueryEngine(null), { normalization });

  it('replayed a non-trivial corpus', () => {
    expect(report.summary.cases).toBeGreaterThan(100);
  });

  it('reaches ≥99% result-equality (each miss carries a COMPAT.md root cause)', () => {
    const rate = report.summary.passRate;
    const failed = report.modules.flatMap((m) => m.cases.filter((c) => c.status !== 'pass'));
    // Every failure must be documented in docs/COMPAT.md's gap table;
    // the generation script asserts exactly this set.
    const compat = readFileSync(join(ROOT, 'docs', 'COMPAT.md'), 'utf8');
    for (const f of failed) {
      const needle = f.expression.id;
      expect(compat, `failure ${f.fixtureId}#${needle} must be documented in COMPAT.md`).toContain(needle);
    }
    if (rate < 0.99) {
      expect(failed.length, `passRate ${rate} below 0.99 with ${failed.length} undocumented failures`).toBe(0);
    }
    expect(rate).toBeGreaterThanOrEqual(0.99);
  });

  it('matches the committed golden report (expected vs actual evidence)', () => {
    const actual = serializeCorpusReport(report);
    if (process.env['UPDATE_GOLDEN'] === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, actual);
      return;
    }
    const expected = readFileSync(GOLDEN_PATH, 'utf8');
    expect(actual).toBe(expected);
  });

  it('docs/corpus-report.json is byte-stable on replay (committed gate artifact)', () => {
    const actual = serializeCorpusReport(report);
    const reportPath = join(ROOT, 'docs', 'corpus-report.json');
    if (process.env['UPDATE_GOLDEN'] === '1') {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, actual);
      return;
    }
    // Same bytes the corpus gate writes (serializeCorpusReport), pinned
    // against the committed artifact — a replay that would drift the
    // committed report fails here, before ci.sh's staleness diff.
    const expected = readFileSync(reportPath, 'utf8');
    expect(actual).toBe(expected);
  });
});
