import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
const HEX_32 = /^[0-9a-f]{32}$/;
const DOC_KINDS = [
    'html',
    'json',
    'xml',
    'protobuf',
    'text',
];
const QUERYABLE_KINDS = ['html', 'json', 'xml'];
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/** Load + validate one seed manifest. Throws loudly when malformed. */
export function loadSeedManifest(dir) {
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    if (!isRecord(raw)) {
        throw new Error(`malformed seed manifest (not an object): ${dir}`);
    }
    const moduleId = raw['moduleId'];
    const module = raw['module'];
    const capturedAt = raw['capturedAt'];
    const entries = raw['entries'];
    if (typeof moduleId !== 'string' ||
        !HEX_32.test(moduleId) ||
        typeof module !== 'string' ||
        module.length === 0 ||
        typeof capturedAt !== 'string' ||
        !Array.isArray(entries)) {
        throw new Error(`malformed seed manifest: ${dir}/manifest.json`);
    }
    const parsedEntries = entries.map((e, i) => {
        if (!isRecord(e)) {
            throw new Error(`malformed manifest entry #${i}: ${dir}`);
        }
        const fixtureId = e['fixtureId'];
        const file = e['file'];
        const kind = e['kind'];
        const url = e['url'];
        if (typeof fixtureId !== 'string' ||
            fixtureId.length === 0 ||
            typeof file !== 'string' ||
            file.length === 0 ||
            typeof kind !== 'string' ||
            !DOC_KINDS.includes(kind) ||
            typeof url !== 'string' ||
            url.length === 0) {
            throw new Error(`malformed manifest entry #${i}: ${dir}`);
        }
        const description = e['description'];
        const entry = {
            fixtureId,
            file,
            kind: kind,
            url,
            ...(typeof description === 'string' ? { description } : {}),
        };
        return entry;
    });
    const template = raw['template'];
    const manifest = {
        moduleId,
        module,
        capturedAt,
        entries: parsedEntries,
        ...(typeof template === 'string' ? { template } : {}),
    };
    return { dir, manifest };
}
/** Read one entry's recorded document body. */
export function loadSeedDocument(loaded, entry) {
    return readFileSync(join(loaded.dir, entry.file), 'utf8');
}
/** Load an FPC-oracle triples file (expression or normalize mode). */
export function loadCaptureTriplesFile(path) {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(raw) ||
        typeof raw['generator'] !== 'string' ||
        typeof raw['mode'] !== 'string' ||
        !Array.isArray(raw['triples'])) {
        throw new Error(`malformed capture triples: ${path}`);
    }
    const triples = raw['triples'];
    const out = {
        generator: raw['generator'],
        mode: raw['mode'],
        triples,
        ...(typeof raw['moduleId'] === 'string'
            ? { moduleId: raw['moduleId'] }
            : {}),
        ...(typeof raw['internettoolsCommit'] === 'string'
            ? { internettoolsCommit: raw['internettoolsCommit'] }
            : {}),
    };
    return out;
}
/** Oracle `engine` value for a harvested/captured language. */
function oracleEngine(language) {
    return language === 'css' ? 'css' : 'xpath';
}
/** Build corpus cases for one seed module directory. */
export function buildCorpusCases(dir) {
    const loaded = loadSeedManifest(dir);
    const module = loaded.manifest.module;
    const triplesPath = join(dir, 'triples.json');
    let hasTriples = false;
    try {
        statSync(triplesPath);
        hasTriples = true;
    }
    catch {
        hasTriples = false;
    }
    // No oracle triples recorded yet → no replayable cases from this dir.
    if (!hasTriples)
        return [];
    // A PRESENT but malformed triples file fails loudly (never silently).
    const triples = loadCaptureTriplesFile(triplesPath);
    const cases = [];
    for (const triple of triples.triples) {
        const fixtureId = triple['fixtureId'];
        const entry = loaded.manifest.entries.find((e) => e.fixtureId === fixtureId &&
            QUERYABLE_KINDS.includes(e.kind));
        if (entry === undefined)
            continue;
        // Expression-mode triple: {id, expression, engine, output, resultKind, result}
        if (typeof triple['expression'] === 'string' &&
            (typeof triple['resultKind'] === 'string')) {
            const language = oracleEngine(triple['engine']) === 'css'
                ? 'css'
                : triple['expression'].includes('json(') ||
                    triple['expression'].startsWith('json')
                    ? 'json'
                    : 'xpath';
            cases.push({
                type: 'expression',
                fixtureId: `${fixtureId}#${String(triple['id'] ?? '')}`,
                moduleId: loaded.manifest.moduleId,
                module,
                document: {
                    kind: entry.kind,
                    content: loadSeedDocument(loaded, entry),
                },
                expression: {
                    id: String(triple['id'] ?? ''),
                    expression: triple['expression'],
                    language,
                    output: (triple['output'] ?? 'scalar'),
                },
                expected: {
                    resultKind: triple['resultKind'],
                    result: triple['result'],
                },
            });
        }
    }
    return cases;
}
/**
 * Build corpus cases for every seed module under `root`, plus all
 * normalization capture triples under `captureDir` (mode=normalize
 * files). Deterministic order: modules sorted by name, then fixture
 * order within each.
 */
export function buildFullCorpus(seedRoot, captureDir) {
    const cases = [];
    const dirs = readdirSync(seedRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    for (const name of dirs) {
        cases.push(...buildCorpusCases(join(seedRoot, name)));
    }
    const normFiles = readdirSync(captureDir)
        .filter((f) => f.endsWith('.triples.json'))
        .sort();
    for (const f of normFiles) {
        const doc = loadCaptureTriplesFile(join(captureDir, f));
        if (doc.mode !== 'normalize')
            continue;
        for (const triple of doc.triples) {
            cases.push({
                type: 'normalization',
                fixtureId: String(triple['fixtureId'] ?? basename(f, '.triples.json')),
                moduleId: String(triple['moduleId'] ?? doc.moduleId ?? ''),
                module: 'uData',
                input: triple['input'],
                expected: triple['normalized'],
            });
        }
    }
    return cases;
}
