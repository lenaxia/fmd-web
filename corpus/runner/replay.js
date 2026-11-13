/**
 * Corpus replay runner (DESIGN.md §13.1) — replays corpus cases against
 * a pluggable {@link QueryEngine} (expression cases) and a pluggable
 * {@link NormalizationEngine} (§5.8 cases), and emits a versioned
 * report. Deterministic by construction: sorted module order, stable
 * case ids, no timestamps, integer-stable passRate.
 */
/** Bump when the report shape changes; golden test pins this value. */
export const REPORT_SCHEMA_VERSION = 1;
/** FNV-1a 32-bit — collision-averse parse-cache keying. */
function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
function compareExpression(expected, result) {
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
                ? expected.result
                : [];
            const pass = actual.length === expectedList.length &&
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
function canonical(value) {
    return JSON.stringify(value);
}
/** Replay `cases` against `engine`; returns the versioned report. */
export function runCorpus(cases, engine, options) {
    const normalizer = options?.normalization;
    const byModule = new Map();
    const normalizations = [];
    const parsed = new Map();
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
                ? c.input
                : {};
            const actual = normalizer.normalize('rawModuleOutput' in input && isRecord(input['rawModuleOutput'])
                ? input['rawModuleOutput']
                : input);
            const ok = canonical(actual) === canonical(c.expected);
            if (ok)
                passed++;
            else
                failed++;
            const result = {
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
        const outcome = compareExpression(c.expected, engine.evaluate(doc, c.expression));
        if (outcome.status === 'pass')
            passed++;
        else
            failed++;
        const entry = byModule.get(c.module) ?? {
            ids: new Set(),
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
    const modules = moduleNames.map((name) => {
        const entry = byModule.get(name);
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
            passRate: totalCases === 0
                ? 1
                : Math.round((passed / totalCases) * 10000) / 10000,
        },
        modules,
        normalizations: normalizations.sort((a, b) => a.fixtureId.localeCompare(b.fixtureId)),
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
