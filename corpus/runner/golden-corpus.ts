import {
  MockNormalizationEngine,
  MockQueryEngine,
} from './mock-engine.js';
import type { CorpusCase } from './corpus-loader.js';

/**
 * Golden corpus (§13.1) — the fixed, fully-offline case set the golden
 * report test replays. Shared by corpus/test/runner.test.ts and
 * corpus/scripts/generate-golden.ts so they cannot drift.
 */

const DOC_HTML =
  '<html><h1 class="title">Golden</h1>' +
  '<div class="ch"><a href="/c/1">One</a><a href="/c/2">Two</a></div></html>';
const DOC_JSON = '{"total": 3, "items": [{"url": "/i/1"}, {"url": "/i/2"}]}';

export const GOLDEN_CASES: CorpusCase[] = [
  {
    type: 'expression',
    fixtureId: 'golden/site/page#title',
    moduleId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    module: 'GoldenSite',
    document: { kind: 'html', content: DOC_HTML },
    expression: {
      id: 'title',
      expression: 'string(//h1[@class="title"])',
      language: 'xpath',
      output: 'scalar',
    },
    expected: { resultKind: 'scalar', result: 'Golden' },
  },
  {
    type: 'expression',
    fixtureId: 'golden/site/page#links',
    moduleId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    module: 'GoldenSite',
    document: { kind: 'html', content: DOC_HTML },
    expression: {
      id: 'links',
      expression: '//div[@class="ch"]/a/@href',
      language: 'xpath',
      output: 'list',
    },
    expected: { resultKind: 'list', result: ['/c/1', '/c/2'] },
  },
  {
    type: 'expression',
    fixtureId: 'golden/site/api#count',
    moduleId: 'b2c3d4e5f60718293a4b5c6d7e8f90a1',
    module: 'GoldenSite',
    document: { kind: 'json', content: DOC_JSON },
    expression: {
      id: 'count',
      expression: 'json(*).items().url',
      language: 'json',
      output: 'scalar',
    },
    expected: { resultKind: 'scalar', result: '/i/1' },
  },
  {
    type: 'expression',
    fixtureId: 'golden/site/api#swallowed',
    moduleId: 'b2c3d4e5f60718293a4b5c6d7e8f90a1',
    module: 'GoldenSite',
    document: { kind: 'json', content: DOC_JSON },
    expression: {
      id: 'swallowed',
      expression: '///broken(((',
      language: 'xpath',
      output: 'scalar',
    },
    expected: { resultKind: 'empty', result: '' },
  },
  {
    type: 'normalization',
    fixtureId: 'golden/normalize-0001',
    moduleId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    module: 'GoldenSite',
    input: { title: '  Padded  ', chapterLinks: ['https://h/x/1'] },
    expected: { title: 'Padded', chapterLinks: ['/x/1'], numChapter: 1 },
  },
];

export function seededMock(): MockQueryEngine {
  const mock = new MockQueryEngine();
  const html = mock.parse('html', DOC_HTML);
  const json = mock.parse('json', DOC_JSON);
  mock.record(html, {
    id: 'title',
    expression: 'string(//h1[@class="title"])',
    language: 'xpath',
    output: 'scalar',
  }, { ok: true, scalar: 'Golden', list: [], count: 0 });
  mock.record(html, {
    id: 'links',
    expression: '//div[@class="ch"]/a/@href',
    language: 'xpath',
    output: 'list',
  }, { ok: true, scalar: '/c/1', list: ['/c/1', '/c/2'], count: 2 });
  mock.record(json, {
    id: 'count',
    expression: 'json(*).items().url',
    language: 'json',
    output: 'scalar',
  }, { ok: true, scalar: '/i/1', list: ['/i/1'], count: 1 });
  // '///broken(((' is deliberately NOT recorded → mock error path.
  return mock;
}

export function seededNormalization(): MockNormalizationEngine {
  const norm = new MockNormalizationEngine();
  norm.record(
    { title: '  Padded  ', chapterLinks: ['https://h/x/1'] },
    { title: 'Padded', chapterLinks: ['/x/1'], numChapter: 1 },
  );
  return norm;
}
