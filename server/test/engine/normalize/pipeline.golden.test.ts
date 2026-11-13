import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeMangaInfo, type NormalizeFlags } from '../../../src/engine/normalize/udata.js';

/**
 * §5.8 GetInfo post-processing golden tests (DESIGN.md §5.8, uData.pas:85-207):
 * every `mode: "normalize"` capture triples file in corpus/fixtures/capture
 * carries FPC-oracle ground truth (corpus/harness/fmdnormalize.pas — the
 * statement-by-statement replication of the FMD2 pipeline, built with FPC
 * 3.2.2 + pinned vendor commits, see corpus/meta.json). The TypeScript port
 * must reproduce the `normalized` payload BYTE-EQUAL — exact field values
 * (whitespace/line-breaks/entities) and the oracle's field emit order, hence
 * the JSON.stringify comparison instead of deepEqual.
 */

const CAPTURE_DIR = join(process.cwd(), 'corpus/fixtures/capture');

interface NormalizeTriple {
  readonly fixtureId: string;
  readonly input: Record<string, unknown>;
  readonly normalized: Record<string, unknown>;
}

interface NormalizeTriplesFile {
  readonly mode: string;
  readonly flags: Record<string, unknown>;
  readonly triples: readonly NormalizeTriple[];
}

function loadNormalizeTriples(): { file: string; flags: NormalizeFlags; triples: NormalizeTriple[] }[] {
  const files = readdirSync(CAPTURE_DIR)
    .filter((f) => f.endsWith('.triples.json'))
    .sort();
  const out: { file: string; flags: NormalizeFlags; triples: NormalizeTriple[] }[] = [];
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(CAPTURE_DIR, f), 'utf8')) as NormalizeTriplesFile;
    if (doc.mode !== 'normalize') continue;
    out.push({
      file: f,
      flags: {
        isRemoveHostFromChapterLinks:
          doc.flags['removeHostFromChapterLinks'] !== undefined
            ? (doc.flags['removeHostFromChapterLinks'] as boolean)
            : true, // uData ctor default (fmdnormalize.pas DefaultNormalizeFlags)
        OptionRemoveMangaNameFromChapter:
          doc.flags['optionRemoveMangaNameFromChapter'] !== undefined
            ? (doc.flags['optionRemoveMangaNameFromChapter'] as boolean)
            : false, // FMDOptions.pas:168 default
      },
      triples: doc.triples as NormalizeTriple[],
    });
  }
  return out;
}

const ALL = loadNormalizeTriples();
const TOTAL = ALL.reduce((n, f) => n + f.triples.length, 0);

describe('§5.8 post-processing golden tests (FPC-oracle byte equality)', () => {
  it('has ≥20 fixture manga-infos of ground truth (incl. the two captured pre-port fixtures)', () => {
    expect(TOTAL).toBeGreaterThanOrEqual(20);
    expect(ALL.length).toBeGreaterThanOrEqual(20);
  });

  for (const { file, flags, triples } of ALL) {
    for (const triple of triples) {
      it(`${file}#${triple.fixtureId} byte-equals the FPC oracle`, () => {
        const raw = triple.input as Record<string, unknown>;
        const actual = normalizeMangaInfo(raw, flags);
        // Byte equality: exact values AND the oracle's field emit order.
        expect(JSON.stringify(actual)).toBe(JSON.stringify(triple.normalized));
      });
    }
  }
});
