import type {
  NormalizationEngine,
  ParsedQueryDocument,
  QueryDocumentKind,
  QueryEngine,
  QueryEngineResult,
  QueryExpression,
} from '@fmd/contract';

/**
 * MockQueryEngine — deterministic query engine for offline runner tests
 * (DESIGN.md §13.1). Results are recorded per (document, expression)
 * pair; an unrecorded lookup is a deterministic `ok: false` error. No
 * parsing, no I/O, no randomness — replays are byte-stable.
 */

/** FNV-1a 32-bit — small deterministic document handle. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

interface MockHandle {
  readonly key: string;
  readonly kind: QueryDocumentKind;
}

export class MockQueryEngine implements QueryEngine {
  readonly name = 'mock';

  private readonly results = new Map<string, QueryEngineResult>();
  private readonly docs = new Map<string, number>();

  /** Register the deterministic result for (document, expression). */
  record(
    document: ParsedQueryDocument,
    expression: QueryExpression,
    result: QueryEngineResult,
  ): void {
    this.results.set(this.key(document, expression), result);
  }

  parse(kind: QueryDocumentKind, content: string): ParsedQueryDocument {
    const key = `${kind}:${fnv1a(content)}`;
    this.docs.set(key, (this.docs.get(key) ?? 0) + 1);
    const handle: MockHandle = { key, kind };
    return { kind, handle };
  }

  evaluate(
    document: ParsedQueryDocument,
    expression: QueryExpression,
  ): QueryEngineResult {
    const result = this.results.get(this.key(document, expression));
    if (result !== undefined) return result;
    return {
      ok: false,
      error: `mock: no recorded result for ${expression.expression}`,
    };
  }

  release(_document: ParsedQueryDocument): void {
    // Nothing to free; kept for the interface.
  }

  /** How many parsed-document instances share a content key (tests). */
  instances(key: string): number {
    return this.docs.get(key) ?? 0;
  }

  private key(
    document: ParsedQueryDocument,
    expression: QueryExpression,
  ): string {
    const handle = document.handle as MockHandle;
    return (
      `${handle.key}|${expression.language}|` +
      `${expression.output}|${expression.expression}`
    );
  }
}

/**
 * MockNormalizationEngine — deterministic §5.8 pipeline for offline
 * runner tests: replays are looked up by canonical input, unrecorded
 * inputs normalize to the input unchanged (deterministic identity).
 */
export class MockNormalizationEngine implements NormalizationEngine {
  readonly name = 'mock-normalize';

  private readonly recorded = new Map<string, Record<string, unknown>>();

  /** Register the deterministic output for one raw input. */
  record(
    input: Readonly<Record<string, unknown>>,
    output: Record<string, unknown>,
  ): void {
    this.recorded.set(JSON.stringify(input), output);
  }

  normalize(
    input: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const hit = this.recorded.get(JSON.stringify(input));
    if (hit !== undefined) return hit;
    return { ...input };
  }
}
