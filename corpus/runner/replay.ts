import type {
  ModuleId,
  NormalizationEngine,
  QueryEngine,
  QueryEngineResult,
} from '@fmd/contract';
import type { CorpusCase } from './corpus-loader.js';

/**
 * Corpus replay runner (DESIGN.md §13.1) — replays corpus cases against
 * a pluggable {@link QueryEngine} (expression cases) and a pluggable
 * {@link NormalizationEngine} (§5.8 cases), and emits a versioned
 * report. Deterministic by construction: sorted module order, stable
 * case ids, no timestamps, integer-stable passRate.
 */

/** Bump when the report shape changes; golden test pins this value. */
export const REPORT_SCHEMA_VERSION = 1;

export type ExpressionCaseStatus = 'pass' | 'fail' | 'error';

/** Per-expression result with mismatch detail. */
export interface ExpressionCaseResult {
  readonly fixtureId: string;
  readonly expression: {
    readonly id: string;
    readonly expression: string;
    readonly language: string;
    readonly output: string;
  };
  readonly status: ExpressionCaseStatus;
  readonly expected: unknown;
  readonly actual: unknown;
  /** Present exactly when status ≠ pass. */
  readonly mismatch?: {
    readonly field: 'scalar' | 'list' | 'count' | 'error';
    readonly expected: unknown;
    readonly actual: unknown;
  };
}

/** Per-module rollup (expression cases only). */
export interface CorpusModuleResult {
  readonly module: string;
  readonly modules: readonly ModuleId[];
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly ExpressionCaseResult[];
}

/** Normalization (uData §5.8) case result. */
export interface NormalizationCaseResult {
  readonly fixtureId: string;
  readonly moduleId: ModuleId;
  readonly status: ExpressionCaseStatus;
  readonly expected: unknown;
  readonly actual: unknown;
  /** Present exactly when status ≠ pass. */
  readonly mismatch?: {
    readonly expected: unknown;
    readonly actual: unknown;
  };
}

/** Versioned replay report (validated by report.schema.json). */
export interface CorpusReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly engine: string;
  /** Normalization engine identity ('none' when not supplied). */
  readonly normalization: string;
  readonly summary: {
    readonly cases: number;
    readonly passed: number;
    readonly failed: number;
    /** passed/cases in [0,1], 4-decimal rounded; 1 when no cases. */
    readonly passRate: number;
  };
  /** Expression cases grouped by module, sorted by module name. */
  readonly modules: readonly CorpusModuleResult[];
  /** Normalization cases, sorted by fixtureId. */
  readonly normalizations: readonly NormalizationCaseResult[];
}

/** FNV-1a 32-bit — collision-averse parse-cache keying. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

interface ExpressionExpected {
  readonly resultKind: string;
  readonly result: unknown;
}

function compareExpression(
  expected: ExpressionExpected,
  result: QueryEngineResult,
): {
  status: ExpressionCaseStatus;
  actual: unknown;
  mismatch?: ExpressionCaseResult['mismatch'];
} {
  if (!result.ok) {
    // FMD2 swallow semantics: the oracle records "empty" for BOTH
    // swallowed errors and genuinely empty sequences.
    if (expected.resultKind === 'empty') {
      return { status: 'pass', actual: { error: result.error } };
    }
    return {
      status: 'error',
      actual: { error: result.error },
      mismatch: {
        field: 'error',
        expected: expected.result,
        actual: result.error,
      },
    };
  }
  switch (expected.resultKind) {
    case 'empty': {
      const empty = result.scalar === '' && result.list.length === 0;
      return empty
        ? { status: 'pass', actual: '' }
        : {
            status: 'fail',
            actual: result.scalar,
            mismatch: {
              field: 'scalar',
              expected: '',
              actual: result.scalar,
            },
          };
    }
    case 'scalar': {
      const pass = result.scalar === expected.result;
      return pass
        ? { status: 'pass', actual: result.scalar }
        : {
            status: 'fail',
            actual: result.scalar,
            mismatch: {
              field: 'scalar',
              expected: expected.result,
              actual: result.scalar,
            },
          };
    }
    case 'list': {
      const actual = [...result.list];
      const expectedList = Array.isArray(expected.result)
        ? (expected.result as unknown[])
        : [];
      const pass =
        actual.length === expectedList.length &&
        actual.every((v, i) => v === expectedList[i]);
      return pass
        ? { status: 'pass', actual }
        : {
            status: 'fail',
            actual,
            mismatch: { field: 'list', expected: expected.result, actual },
          };
    }
    case 'count': {
      const pass = result.count === expected.result;
      return pass
        ? { status: 'pass', actual: result.count }
        : {
            status: 'fail',
            actual: result.count,
            mismatch: {
              field: 'count',
              expected: expected.result,
              actual: result.count,
            },
          };
    }
    default:
      return {
        status: 'error',
        actual: null,
        mismatch: {
          field: 'error',
          expected: expected.result,
          actual: `unknown resultKind ${String(expected.resultKind)}`,
        },
      };
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

export interface RunCorpusOptions {
  /** §5.8 normalization engine; required to replay normalization cases. */
  readonly normalization?: NormalizationEngine;
}

/** Replay `cases` against `engine`; returns the versioned report. */
export function runCorpus(
  cases: readonly CorpusCase[],
  engine: QueryEngine,
  options?: RunCorpusOptions,
): CorpusReport {
  const normalizer = options?.normalization;
  const byModule = new Map<
    string,
    { ids: Set<ModuleId>; cases: ExpressionCaseResult[] }
  >();
  const normalizations: NormalizationCaseResult[] = [];
  const parsed = new Map<string, ReturnType<QueryEngine['parse']>>();
  let passed = 0;
  let failed = 0;

  for (const c of cases) {
    if (c.type === 'normalization') {
      if (normalizer === undefined) {
        failed++;
        normalizations.push({
          fixtureId: c.fixtureId,
          moduleId: c.moduleId,
          status: 'error',
          expected: c.expected,
          actual: null,
          mismatch: {
            expected: c.expected,
            actual: 'no normalization engine supplied',
          },
        });
        continue;
      }
      const input = isRecord(c.input)
        ? (c.input as Record<string, unknown>)
        : {};
      const actual =
        'rawModuleOutput' in input && isRecord(input['rawModuleOutput'])
          ? normalizer.normalize(
              input['rawModuleOutput'] as Record<string, unknown>,
              c.flags,
            )
          : normalizer.normalize(input, c.flags);
      const ok = canonical(actual) === canonical(c.expected);
      if (ok) passed++;
      else failed++;
      const result: NormalizationCaseResult = {
        fixtureId: c.fixtureId,
        moduleId: c.moduleId,
        status: ok ? 'pass' : 'fail',
        expected: c.expected,
        actual,
        ...(ok
          ? {}
          : { mismatch: { expected: c.expected, actual } }),
      };
      normalizations.push(result);
      continue;
    }

    const docKey = `${c.document.kind}:${fnv1a(c.document.content)}`;
    let doc = parsed.get(docKey);
    if (doc === undefined) {
      doc = engine.parse(c.document.kind, c.document.content);
      parsed.set(docKey, doc);
    }
    const outcome = compareExpression(
      c.expected,
      engine.evaluate(doc, c.expression),
    );
    if (outcome.status === 'pass') passed++;
    else failed++;
    const entry = byModule.get(c.module) ?? {
      ids: new Set<ModuleId>(),
      cases: [],
    };
    entry.ids.add(c.moduleId);
    entry.cases.push({
      fixtureId: c.fixtureId,
      expression: {
        id: c.expression.id,
        expression: c.expression.expression,
        language: c.expression.language,
        output: c.expression.output,
      },
      status: outcome.status,
      expected: c.expected.result,
      actual: outcome.actual,
      ...(outcome.mismatch !== undefined
        ? { mismatch: outcome.mismatch }
        : {}),
    });
    byModule.set(c.module, entry);
  }

  const moduleNames = [...byModule.keys()].sort();
  const totalCases = passed + failed;
  const modules: CorpusModuleResult[] = moduleNames.map((name) => {
    const entry = byModule.get(name)!;
    const modPassed = entry.cases.filter((c) => c.status === 'pass').length;
    return {
      module: name,
      modules: [...entry.ids].sort(),
      passed: modPassed,
      failed: entry.cases.length - modPassed,
      cases: entry.cases,
    };
  });

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    engine: engine.name,
    normalization: normalizer?.name ?? 'none',
    summary: {
      cases: totalCases,
      passed,
      failed,
      passRate:
        totalCases === 0
          ? 1
          : Math.round((passed / totalCases) * 10000) / 10000,
    },
    modules,
    normalizations: normalizations.sort((a, b) =>
      a.fixtureId.localeCompare(b.fixtureId),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
