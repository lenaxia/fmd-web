import type { ModuleId, NormalizationEngine, QueryEngine } from '@fmd/contract';
import type { CorpusCase } from './corpus-loader.js';
/**
 * Corpus replay runner (DESIGN.md §13.1) — replays corpus cases against
 * a pluggable {@link QueryEngine} (expression cases) and a pluggable
 * {@link NormalizationEngine} (§5.8 cases), and emits a versioned
 * report. Deterministic by construction: sorted module order, stable
 * case ids, no timestamps, integer-stable passRate.
 */
/** Bump when the report shape changes; golden test pins this value. */
export declare const REPORT_SCHEMA_VERSION = 1;
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
export interface RunCorpusOptions {
    /** §5.8 normalization engine; required to replay normalization cases. */
    readonly normalization?: NormalizationEngine;
}
/** Replay `cases` against `engine`; returns the versioned report. */
export declare function runCorpus(cases: readonly CorpusCase[], engine: QueryEngine, options?: RunCorpusOptions): CorpusReport;
//# sourceMappingURL=replay.d.ts.map