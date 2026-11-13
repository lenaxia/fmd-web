import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCorpusCases,
  loadCaptureTriplesFile,
  loadSeedDocument,
  loadSeedManifest,
  type CorpusCase,
} from '../runner/corpus-loader.js';

const MODULE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('corpus loader — seed manifests (§13.1)', (): void => {
  const root = mkdtempSync(join(tmpdir(), 'fmd-corpus-'));

  beforeAll((): void => {
    const dir = join(root, 'TestSite');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'page.html'),
      '<html><h1 class="title">T</h1></html>',
    );
    writeFileSync(
      join(dir, 'api.json'),
      '{"data":[{"url":"/c/1","title":"C1"}]}',
    );
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        moduleId: MODULE_ID,
        module: 'TestSite',
        capturedAt: '2026-11-13T00:00:00Z',
        entries: [
          {
            fixtureId: 'seed/TestSite/page',
            file: 'page.html',
            kind: 'html',
            url: 'https://testsite.example/latest',
          },
          {
            fixtureId: 'seed/TestSite/api',
            file: 'api.json',
            kind: 'json',
            url: 'https://testsite.example/api/latest',
          },
        ],
      }),
    );
    // Oracle triples over both entries.
    writeFileSync(
      join(dir, 'triples.json'),
      JSON.stringify({
        generator: 'fmd_capture',
        mode: 'expression',
        moduleId: MODULE_ID,
        internettoolsCommit: '2724779c4287547137141ec9ec2a6df0af0f82af',
        triples: [
          {
            fixtureId: 'seed/TestSite/page',
            id: 'title',
            expression: 'string(//h1[@class="title"])',
            engine: 'xpath',
            output: 'scalar',
            resultKind: 'scalar',
            result: 'T',
          },
          {
            fixtureId: 'seed/TestSite/api',
            id: 'links',
            expression: 'json(*).data()',
            engine: 'xpath',
            output: 'list',
            resultKind: 'list',
            result: ['/c/1'],
          },
        ],
      }),
    );
  });

  afterAll((): void => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads and validates a seed manifest', (): void => {
    const loaded = loadSeedManifest(join(root, 'TestSite'));
    expect(loaded.manifest.module).toBe('TestSite');
    expect(loaded.manifest.entries).toHaveLength(2);
    expect(loaded.dir).toBe(join(root, 'TestSite'));
  });

  it('rejects malformed manifests loudly', (): void => {
    const bad = join(root, 'Missing');
    expect(() => loadSeedManifest(bad)).toThrow();
    const badDir = join(root, 'Bad');
    mkdirSync(badDir);
    writeFileSync(join(badDir, 'manifest.json'), '{"moduleId":"nope"}');
    expect(() => loadSeedManifest(badDir)).toThrow(/manifest/);
  });

  it('reads entry documents relative to the manifest dir', (): void => {
    const loaded = loadSeedManifest(join(root, 'TestSite'));
    const html = loadSeedDocument(loaded, loaded.manifest.entries[0]!);
    expect(html).toContain('<h1');
    const json = loadSeedDocument(loaded, loaded.manifest.entries[1]!);
    expect(JSON.parse(json)).toHaveProperty('data');
  });

  it('builds expression + normalization corpus cases from triples', (): void => {
    const cases: CorpusCase[] = buildCorpusCases(join(root, 'TestSite'));
    expect(cases).toHaveLength(2);
    const expr = cases[0];
    expect(expr?.type).toBe('expression');
    if (expr?.type === 'expression') {
      expect(expr.moduleId).toBe(MODULE_ID);
      expect(expr.expression.expression).toBe('string(//h1[@class="title"])');
      expect(expr.document.kind).toBe('html');
      expect(expr.expected).toEqual({
        resultKind: 'scalar',
        result: 'T',
      });
    }
    const list = cases[1];
    if (list?.type === 'expression') {
      expect(list.document.kind).toBe('json');
      expect(list.expected).toEqual({ resultKind: 'list', result: ['/c/1'] });
    }
  });
});

describe('corpus loader — capture triples (FPC oracle)', (): void => {
  it('loads the committed html-basic capture with validation', (): void => {
    const path = fileURLToPath(
      new URL('../fixtures/capture/html-basic-0001.triples.json', import.meta.url),
    );
    const doc = loadCaptureTriplesFile(path);
    expect(doc.mode).toBe('expression');
    expect(doc.triples.length).toBeGreaterThan(10);
    // The broken-syntax triple pins FMD2's swallow semantics.
    const broken = doc.triples.find((t) => t['id'] === 'broken-syntax');
    expect(broken?.['resultKind']).toBe('empty');
  });

  it('loads a normalization capture triple set', (): void => {
    const path = fileURLToPath(
      new URL(
        '../fixtures/capture/getinfo-normalization-0003.triples.json',
        import.meta.url,
      ),
    );
    const doc = loadCaptureTriplesFile(path);
    expect(doc.mode).toBe('normalize');
    const first = doc.triples[0] as Record<string, unknown>;
    expect(first['normalized']).toHaveProperty('numChapter');
  });
});
