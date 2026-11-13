import type { ModuleId, QueryDocumentKind, QueryExpression } from '@fmd/contract';
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
export type SeedFixtureKind = QueryDocumentKind | 'protobuf' | 'text';
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
/** Load + validate one seed manifest. Throws loudly when malformed. */
export declare function loadSeedManifest(dir: string): LoadedSeedModule;
/** Read one entry's recorded document body. */
export declare function loadSeedDocument(loaded: LoadedSeedModule, entry: SeedEntry): string;
/** Load an FPC-oracle triples file (expression or normalize mode). */
export declare function loadCaptureTriplesFile(path: string): CaptureTriples;
/** A replayable corpus case (discriminated by `type`). */
export type CorpusCase = {
    readonly type: 'expression';
    readonly fixtureId: string;
    readonly moduleId: ModuleId;
    /** Module/template name (file stem). */
    readonly module: string;
    readonly document: {
        readonly kind: QueryDocumentKind;
        readonly content: string;
    };
    readonly expression: QueryExpression;
    /** Captured truth: resultKind ∈ scalar|list|count|empty. */
    readonly expected: {
        readonly resultKind: 'scalar' | 'list' | 'count' | 'empty';
        readonly result: unknown;
    };
} | {
    readonly type: 'normalization';
    readonly fixtureId: string;
    readonly moduleId: ModuleId;
    readonly module: string;
    readonly input: unknown;
    readonly expected: unknown;
};
/** Build corpus cases for one seed module directory. */
export declare function buildCorpusCases(dir: string): CorpusCase[];
/**
 * Build corpus cases for every seed module under `root`, plus all
 * normalization capture triples under `captureDir` (mode=normalize
 * files). Deterministic order: modules sorted by name, then fixture
 * order within each.
 */
export declare function buildFullCorpus(seedRoot: string, captureDir: string): CorpusCase[];
//# sourceMappingURL=corpus-loader.d.ts.map