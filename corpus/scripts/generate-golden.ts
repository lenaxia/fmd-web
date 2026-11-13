#!/usr/bin/env node
/**
 * Regenerate corpus/test/golden/report-v1.golden.json from the golden
 * corpus cases (corpus/runner/golden-corpus.ts). Run after an
 * INTENTIONAL report-shape change (bump REPORT_SCHEMA_VERSION too):
 *
 *   npx tsx corpus/scripts/generate-golden.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCorpus } from '../runner/replay.js';
import {
  GOLDEN_CASES,
  seededMock,
  seededNormalization,
} from '../runner/golden-corpus.js';

const report = runCorpus(GOLDEN_CASES, seededMock(), {
  normalization: seededNormalization(),
});
const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../test/golden/report-v1.golden.json',
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`golden report written: ${outPath}`);
