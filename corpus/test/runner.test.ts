import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockNormalizationEngine } from '../runner/mock-engine.js';
import { REPORT_SCHEMA_VERSION, runCorpus } from '../runner/replay.js';
import {
  GOLDEN_CASES,
  seededMock,
  seededNormalization,
} from '../runner/golden-corpus.js';

describe('MockQueryEngine', (): void => {
  it('returns recorded results keyed by document + expression', (): void => {
    const mock = seededMock();
    const doc = mock.parse('html', '<html></html>');
    const r = mock.evaluate(doc, {
      id: 'title',
      expression: 'string(//h1[@class="title"])',
      language: 'xpath',
      output: 'scalar',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no recorded result');
  });

  it('is deterministic across instances', (): void => {
    const docHtml = '<html><h1>T</h1></html>';
    const expr = {
      id: 't',
      expression: 'string(//h1)',
      language: 'xpath' as const,
      output: 'scalar' as const,
    };
    const a = seededMock();
    const b = seededMock();
    const da = a.parse('html', docHtml);
    const db = b.parse('html', docHtml);
    a.record(da, expr, { ok: true, scalar: 'T', list: [], count: 0 });
    b.record(db, expr, { ok: true, scalar: 'T', list: [], count: 0 });
    expect(a.evaluate(da, expr)).toEqual(b.evaluate(db, expr));
    // A different document (same length) must NOT collide.
    const other = a.parse('html', '<html><h1>U</h1></html>');
    expect(a.evaluate(other, expr).ok).toBe(false);
  });

  it('MockNormalizationEngine replays recorded pipelines deterministically', (): void => {
    const norm = seededNormalization();
    expect(
      norm.normalize({ title: '  Padded  ', chapterLinks: ['https://h/x/1'] }),
    ).toEqual({ title: 'Padded', chapterLinks: ['/x/1'], numChapter: 1 });
    // Unrecorded input → deterministic identity.
    expect(norm.normalize({ title: 'X' })).toEqual({ title: 'X' });
    const engine: MockNormalizationEngine = new MockNormalizationEngine();
    expect(engine.name).toBe('mock-normalize');
  });
});

describe('runner — replay + versioned report', (): void => {
  it('replays a corpus deterministically (identical reports)', (): void => {
    const a = runCorpus(GOLDEN_CASES, seededMock(), {
      normalization: seededNormalization(),
    });
    const b = runCorpus(GOLDEN_CASES, seededMock(), {
      normalization: seededNormalization(),
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('scores pass/fail per module and per expression', (): void => {
    const report = runCorpus(GOLDEN_CASES, seededMock(), {
      normalization: seededNormalization(),
    });
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.engine).toBe('mock');
    expect(report.normalization).toBe('mock-normalize');
    expect(report.summary.cases).toBe(5);
    expect(report.summary.passed).toBe(5);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passRate).toBe(1);
    expect(report.modules.map((m) => m.module)).toEqual(['GoldenSite']);
    expect(report.normalizations).toHaveLength(1);
    expect(report.normalizations[0]?.status).toBe('pass');
  });

  it('marks mismatches with expected vs actual detail', (): void => {
    const mock = seededMock();
    const doc = mock.parse(
      'html',
      '<html><h1 class="title">Golden</h1>' +
        '<div class="ch"><a href="/c/1">One</a><a href="/c/2">Two</a></div></html>',
    );
    mock.record(doc, {
      id: 'links',
      expression: '//div[@class="ch"]/a/@href',
      language: 'xpath',
      output: 'list',
    }, { ok: true, scalar: '', list: ['/c/1'], count: 1 });
    const report = runCorpus(GOLDEN_CASES, mock, {
      normalization: seededNormalization(),
    });
    expect(report.summary.failed).toBe(1);
    const mod = report.modules[0]!;
    const failedCase = mod.cases.find((c) => c.status !== 'pass');
    expect(failedCase?.status).toBe('fail');
    expect(failedCase?.mismatch).toEqual({
      field: 'list',
      expected: ['/c/1', '/c/2'],
      actual: ['/c/1'],
    });
  });

  it('normalization cases fail loudly without a normalization engine', (): void => {
    const report = runCorpus(GOLDEN_CASES, seededMock());
    expect(report.normalization).toBe('none');
    expect(report.summary.failed).toBe(1);
    expect(report.normalizations[0]?.status).toBe('error');
    expect(report.normalizations[0]?.mismatch?.actual).toContain(
      'no normalization engine',
    );
  });
});

describe('runner — golden report (schema v1)', (): void => {
  const goldenPath = fileURLToPath(
    new URL('./golden/report-v1.golden.json', import.meta.url),
  );

  it('matches the committed golden report exactly', (): void => {
    const report = runCorpus(GOLDEN_CASES, seededMock(), {
      normalization: seededNormalization(),
    });
    const golden: unknown = JSON.parse(readFileSync(goldenPath, 'utf8'));
    expect(report).toEqual(golden);
  });

  it('validates against the report JSON schema (ajv)', async (): Promise<void> => {
    const { default: Ajv } = (await import('ajv')) as unknown as {
      default: new (opts?: object) => {
        validate(schema: object, data: unknown): boolean;
        errors: unknown;
      };
    };
    const schemaPath = fileURLToPath(
      new URL('../runner/report.schema.json', import.meta.url),
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
    const report = runCorpus(GOLDEN_CASES, seededMock(), {
      normalization: seededNormalization(),
    });
    const ajv = new Ajv({ allErrors: true, strict: false });
    const valid = ajv.validate(schema, report);
    expect(valid, JSON.stringify(ajv.errors)).toBe(true);
  });

  it('rejects a report whose schemaVersion drifted', async (): Promise<void> => {
    const { default: Ajv } = (await import('ajv')) as unknown as {
      default: new (opts?: object) => {
        validate(schema: object, data: unknown): boolean;
        errors: unknown;
      };
    };
    const schemaPath = fileURLToPath(
      new URL('../runner/report.schema.json', import.meta.url),
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
    const report = runCorpus(GOLDEN_CASES, seededMock(), {
      normalization: seededNormalization(),
    });
    const drifted = { ...report, schemaVersion: 99 };
    const ajv = new Ajv({ allErrors: true, strict: false });
    expect(ajv.validate(schema, drifted)).toBe(false);
  });
});
