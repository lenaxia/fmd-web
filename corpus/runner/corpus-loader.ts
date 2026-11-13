import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ModuleId,
  QueryDocumentKind,
  QueryExpression,
} from '@fmd/contract';

/**
 * Corpus loader (DESIGN.md §13.1) — turns recorded seed fixtures
 * (corpus/fixtures/seed/<Module>/) and FPC-oracle capture triples
 * (corpus/fixtures/capture/*.triples.json) into replayable corpus cases
 * for the runner. Everything is read from disk; nothing touches the
 * network.
 */

/**
 * Recorded response-body kinds. `html|json|xml` are query-replayable
 * (QueryDocumentKind); `protobuf|text` are provenance fixtures for
 * special-case modules (e.g. MangaPlus `pb.decode` payloads) — recorded,
 * validated, but not handed to the QueryEngine.
 */
export type SeedFixtureKind =
  | QueryDocumentKind
  | 'protobuf'
  | 'text';

/** One recorded HTTP response body for a seed module. */
export interface SeedEntry {
  /** Joins the entry to oracle triples (`seed/<Module>/<slug>`). */
  readonly fixtureId: string;
  /** File relative to the manifest directory. */
  readonly file: string;
  readonly kind: SeedFixtureKind;
  /** The live URL captured once at seed time (provenance only). */
  readonly url: string;
  readonly description?: string;
}

/** corpus/fixtures/seed/<Module>/manifest.json */
export interface SeedManifest {
  /** 32-hex FMD2 module id. */
  readonly moduleId: ModuleId;
  /** Module/template name (file stem). */
  readonly module: string;
  /** ISO-8601 capture stamp (provenance). */
  readonly capturedAt: string;
  readonly entries: readonly SeedEntry[];
  /** Template the module is built on (Madara, MangaThemesia, …). */
  readonly template?: string;
}

/** Parsed manifest plus its directory (entries resolve against it). */
export interface LoadedSeedModule {
  readonly dir: string;
  readonly manifest: SeedManifest;
}

/** FPC oracle output envelope (fmd_capture expression|normalize). */
export interface CaptureTriples {
  readonly generator: string;
  readonly mode: string;
  readonly moduleId?: ModuleId;
  readonly internettoolsCommit?: string;
  readonly triples: readonly Record<string, unknown>[];
}

const HEX_32 = /^[0-9a-f]{32}$/;
const DOC_KINDS: readonly SeedFixtureKind[] = [
  'html',
  'json',
  'xml',
  'protobuf',
  'text',
];
const QUERYABLE_KINDS: readonly QueryDocumentKind[] = ['html', 'json', 'xml'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Load + validate one seed manifest. Throws loudly when malformed. */
export function loadSeedManifest(dir: string): LoadedSeedModule {
  const raw: unknown = JSON.parse(
    readFileSync(join(dir, 'manifest.json'), 'utf8'),
  );
  if (!isRecord(raw)) {
    throw new Error(`malformed seed manifest (not an object): ${dir}`);
  }
  const moduleId = raw['moduleId'];
  const module = raw['module'];
  const capturedAt = raw['capturedAt'];
  const entries = raw['entries'];
  if (
    typeof moduleId !== 'string' ||
    !HEX_32.test(moduleId) ||
    typeof module !== 'string' ||
    module.length === 0 ||
    typeof capturedAt !== 'string' ||
    !Array.isArray(entries)
  ) {
    throw new Error(`malformed seed manifest: ${dir}/manifest.json`);
  }
  const parsedEntries: SeedEntry[] = entries.map((e, i): SeedEntry => {
    if (!isRecord(e)) {
      throw new Error(`malformed manifest entry #${i}: ${dir}`);
    }
    const fixtureId = e['fixtureId'];
    const file = e['file'];
    const kind = e['kind'];
    const url = e['url'];
    if (
      typeof fixtureId !== 'string' ||
      fixtureId.length === 0 ||
      typeof file !== 'string' ||
      file.length === 0 ||
      typeof kind !== 'string' ||
      !(DOC_KINDS as readonly string[]).includes(kind) ||
      typeof url !== 'string' ||
      url.length === 0
    ) {
      throw new Error(`malformed manifest entry #${i}: ${dir}`);
    }
    const description = e['description'];
    const entry: SeedEntry = {
      fixtureId,
      file,
      kind: kind as SeedFixtureKind,
      url,
      ...(typeof description === 'string' ? { description } : {}),
    };
    return entry;
  });
  const template = raw['template'];
  const manifest: SeedManifest = {
    moduleId,
    module,
    capturedAt,
    entries: parsedEntries,
    ...(typeof template === 'string' ? { template } : {}),
  };
  return { dir, manifest };
}

/** Read one entry's recorded document body. */
export function loadSeedDocument(
  loaded: LoadedSeedModule,
  entry: SeedEntry,
): string {
  return readFileSync(join(loaded.dir, entry.file), 'utf8');
}

/** Load an FPC-oracle triples file (expression or normalize mode). */
export function loadCaptureTriplesFile(path: string): CaptureTriples {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !isRecord(raw) ||
    typeof raw['generator'] !== 'string' ||
    typeof raw['mode'] !== 'string' ||
    !Array.isArray(raw['triples'])
  ) {
    throw new Error(`malformed capture triples: ${path}`);
  }
  const triples = raw['triples'] as Record<string, unknown>[];
  const out: CaptureTriples = {
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

/** A replayable corpus case (discriminated by `type`). */
export type CorpusCase =
  | {
      readonly type: 'expression';
      readonly fixtureId: string;
      readonly moduleId: ModuleId;
      /** Module/template name (file stem). */
      readonly module: string;
      readonly document: { readonly kind: QueryDocumentKind; readonly content: string };
      readonly expression: QueryExpression;
      /** Captured truth: resultKind ∈ scalar|list|count|empty. */
      readonly expected: {
        readonly resultKind: 'scalar' | 'list' | 'count' | 'empty';
        readonly result: unknown;
      };
    }
  | {
      readonly type: 'normalization';
      readonly fixtureId: string;
      readonly moduleId: ModuleId;
      readonly module: string;
      readonly input: unknown;
      readonly expected: unknown;
    };

/** Oracle `engine` value for a harvested/captured language. */
function oracleEngine(language: string): string {
  return language === 'css' ? 'css' : 'xpath';
}

/** Build corpus cases for one seed module directory. */
export function buildCorpusCases(dir: string): CorpusCase[] {
  const loaded = loadSeedManifest(dir);
  const module = loaded.manifest.module;
  const triplesPath = join(dir, 'triples.json');
  let hasTriples = false;
  try {
    statSync(triplesPath);
    hasTriples = true;
  } catch {
    hasTriples = false;
  }
  // No oracle triples recorded yet → no replayable cases from this dir.
  if (!hasTriples) return [];
  // A PRESENT but malformed triples file fails loudly (never silently).
  const triples = loadCaptureTriplesFile(triplesPath);
  const cases: CorpusCase[] = [];
  for (const triple of triples.triples) {
    const fixtureId = triple['fixtureId'];
    const entry = loaded.manifest.entries.find(
      (e) =>
        e.fixtureId === fixtureId &&
        (QUERYABLE_KINDS as readonly string[]).includes(e.kind),
    );
    if (entry === undefined) continue;
    // Expression-mode triple: {id, expression, engine, output, resultKind, result}
    if (
      typeof triple['expression'] === 'string' &&
      (typeof triple['resultKind'] === 'string')
    ) {
      const language = oracleEngine(triple['engine'] as string) === 'css'
        ? 'css'
        : (triple['expression'] as string).includes('json(') ||
            (triple['expression'] as string).startsWith('json')
          ? 'json'
          : 'xpath';
      cases.push({
        type: 'expression',
        fixtureId: `${fixtureId}#${String(triple['id'] ?? '')}`,
        moduleId: loaded.manifest.moduleId,
        module,
        document: {
          kind: entry.kind as QueryDocumentKind,
          content: loadSeedDocument(loaded, entry),
        },
        expression: {
          id: String(triple['id'] ?? ''),
          expression: triple['expression'] as string,
          language,
          output: (triple['output'] as QueryExpression['output'] ?? 'scalar'),
        },
        expected: {
          resultKind: triple['resultKind'] as 'scalar' | 'list' | 'count' | 'empty',
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
export function buildFullCorpus(
  seedRoot: string,
  captureDir: string,
): CorpusCase[] {
  const cases: CorpusCase[] = [];
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
    if (doc.mode !== 'normalize') continue;
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
