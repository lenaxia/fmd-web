#!/usr/bin/env node
// Validate fmd_capture triples output files (schema check, offline).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'capture');
const KINDS = new Set(['scalar', 'list', 'count', 'empty']);
let failures = 0;
let files = 0;
let triples = 0;

for (const name of readdirSync(dir).filter((f) => f.endsWith('.triples.json'))) {
  files += 1;
  const path = join(dir, name);
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.log(`FAIL ${name}: not valid JSON: ${e.message}`);
    failures += 1;
    continue;
  }
  const problems = [];
  if (doc.generator !== 'fmd_capture') problems.push('generator');
  if (!['expression', 'normalize'].includes(doc.mode)) problems.push('mode');
  if (typeof doc.internettoolsCommit !== 'string' || doc.internettoolsCommit.length !== 40)
    problems.push('internettoolsCommit');
  if (typeof doc.fpcVersion !== 'string' || doc.fpcVersion.length === 0) problems.push('fpcVersion');
  if (!Array.isArray(doc.triples)) problems.push('triples');
  else {
    for (const [i, t] of doc.triples.entries()) {
      triples += 1;
      if (typeof t.fixtureId !== 'string' || t.fixtureId.length === 0) problems.push(`triples[${i}].fixtureId`);
      if (doc.mode === 'expression') {
        if (typeof t.expression !== 'string' || t.expression.length === 0) problems.push(`triples[${i}].expression`);
        if (!KINDS.has(t.resultKind)) {
          problems.push(`triples[${i}].resultKind=${t.resultKind}`);
        } else if (t.resultKind === 'list') {
          if (!Array.isArray(t.result)) problems.push(`triples[${i}].result not array`);
        } else if (t.resultKind === 'count') {
          if (!Number.isInteger(t.result)) problems.push(`triples[${i}].result not int`);
        } else if (t.resultKind === 'empty') {
          // empty carries the natural empty value: [] for list output, '' otherwise
          const wantList = t.output === 'list';
          if (wantList && !Array.isArray(t.result)) problems.push(`triples[${i}].result not []`);
          if (!wantList && typeof t.result !== 'string') problems.push(`triples[${i}].result not string`);
        } else if (typeof t.result !== 'string') {
          problems.push(`triples[${i}].result not string`);
        }
      } else if (doc.mode === 'normalize') {
        const n = t.normalized;
        if (typeof n !== 'object' || n === null) problems.push(`triples[${i}].normalized`);
        else if (!Array.isArray(n.chapterLinks) || !Array.isArray(n.chapterNames))
          problems.push(`triples[${i}].normalized chapter arrays`);
        else if (n.chapterLinks.length !== n.chapterNames.length)
          problems.push(`triples[${i}].normalized link/name length mismatch`);
        else if (!Number.isInteger(n.numChapter) || n.numChapter !== n.chapterLinks.length)
          problems.push(`triples[${i}].normalized numChapter`);
        else if (t.input === undefined) problems.push(`triples[${i}].input`);
      }
    }
  }
  if (problems.length > 0) {
    failures += 1;
    console.log(`FAIL ${name}: ${problems.join(', ')}`);
  } else {
    console.log(`OK   ${name} (${doc.triples.length} triples)`);
  }
}
console.log(`\nvalidated ${files} files, ${triples} triples, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
