import { createHash } from 'node:crypto';
import type { ConstantBinding, EventBinding, EventReturnKind } from '@fmd/contract';

/**
 * Binding-table codegen (DESIGN.md §5.2, §11): renders the §5.2 event rows
 * of `contract/contract.json` into the typed TS module
 * `server/src/engine/events/bindings.generated.ts`.
 *
 * NEVER hand-code a binding table: the only source of truth is
 * contract.json. The renderer is pure (document in, file text out) so the
 * golden/drift tests can run it in-process; `generate-bindings.ts` is the
 * CLI wrapper that asserts sanity and writes the file.
 */

/** Name of the generated file, relative to the server workspace root. */
export const GENERATED_BINDINGS_REL_PATH = 'src/engine/events/bindings.generated.ts';

/** Normalized row shape shared by contract rows and generated rows. */
export interface SanityRow {
  readonly event: string;
  readonly returns: EventReturnKind;
  readonly globals: readonly string[];
  readonly readBack: readonly string[];
  readonly pushOnly: boolean;
  readonly constants: ConstantBinding;
}

/** Normalize a contract row: absent `pushOnly` becomes false. */
export function toSanityRow(row: EventBinding): SanityRow {
  return { ...row, pushOnly: row.pushOnly === true };
}

function contractFingerprint(events: readonly EventBinding[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

/** Union of every global name bound by any row, sorted (stable output). */
export function collectGlobalNames(events: readonly EventBinding[]): readonly string[] {
  const names = new Set<string>();
  for (const row of events) {
    for (const name of row.globals) {
      names.add(name);
    }
    for (const name of row.readBack) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Sanity assertion for the §5.2 rows (the build-time gate): invariants the
 * dispatchers rely on. Throws with the first violated invariant.
 */
export function assertEventRowsSanity(rows: readonly SanityRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.event)) {
      throw new Error(`generated bindings: duplicate event row ${row.event}`);
    }
    seen.add(row.event);
    if (row.globals.length === 0 || row.globals[0] !== 'MODULE') {
      throw new Error(
        `generated bindings[${row.event}]: MODULE must be bound first for every event (LuaWebsiteModuleHandler.pas:47-49)`,
      );
    }
    if (row.pushOnly && row.readBack.length > 0) {
      throw new Error(
        `generated bindings[${row.event}]: pushOnly rows must not read anything back`,
      );
    }
    for (const name of row.readBack) {
      if (!row.globals.includes(name)) {
        throw new Error(
          `generated bindings[${row.event}]: readBack global ${name} is not bound in globals`,
        );
      }
      if (name !== 'PAGENUMBER') {
        throw new Error(
          `generated bindings[${row.event}]: PAGENUMBER is the only read-back global (got ${name})`,
        );
      }
    }
    if (
      row.constants !== 'net-status' &&
      row.constants !== 'account-status' &&
      row.constants !== 'none'
    ) {
      throw new Error(
        `generated bindings[${row.event}]: unknown constant binding ${String(row.constants)}`,
      );
    }
  }
}

function renderRow(row: SanityRow): string {
  const globals = row.globals.map((g) => `'${g}'`).join(', ');
  const readBack = row.readBack.map((g) => `'${g}'`).join(', ');
  return `  {
    event: '${row.event}',
    returns: '${row.returns}',
    globals: [${globals}],
    readBack: [${readBack}],
    pushOnly: ${row.pushOnly ? 'true' : 'false'},
    constants: '${row.constants}',
  },`;
}

/** Render the full generated module text for the contract's event rows. */
export function renderBindingsModule(events: readonly EventBinding[]): string {
  const sanity = events.map(toSanityRow);
  assertEventRowsSanity(sanity);
  const rows = sanity.map(renderRow).join('\n');
  const union = collectGlobalNames(events)
    .map((name) => `  | '${name}'`)
    .join('\n');
  const fingerprint = contractFingerprint(events);
  return `// -----------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source of truth: contract/contract.json (§5.2 event-binding rows).
// Generator:       server/tools/generate-bindings.ts
//                  (npm run gen:bindings -w @fmd/server)
//
// Events SHA-256: ${fingerprint}
//
// Any change to contract.json that alters the §5.2 rows MUST be applied by
// re-running the generator; server/test/engine/events/bindings-golden.test.ts
// fails when this file drifts from the contract document.
// -----------------------------------------------------------------------

import type { ConstantBinding, EventReturnKind } from '@fmd/contract';

/** Every global the contract binds for at least one event (§5.2). */
export type EventGlobalName =
${union};

/** One generated §5.2 event row (pushOnly normalized: absent = false). */
export interface GeneratedEventBindingRow {
  readonly event: string;
  readonly returns: EventReturnKind;
  readonly globals: readonly EventGlobalName[];
  readonly readBack: readonly EventGlobalName[];
  readonly pushOnly: boolean;
  readonly constants: ConstantBinding;
}

/**
 * The §5.2 event-binding table, GENERATED from contract.json — the
 * dispatcher binds exactly the row's globals, in row order (§5
 * implementation rule: contract.json is the source, never a hand-coded
 * table).
 */
export const GENERATED_EVENT_BINDINGS: readonly GeneratedEventBindingRow[] = [
${rows}
];

/**
 * Sanity assertion for the generated table (run by the golden test):
 * invariants the §5.2 dispatchers rely on. Throws with the first
 * violated invariant.
 */
export function assertGeneratedBindingsSanity(): void {
  const seen = new Set<string>();
  for (const row of GENERATED_EVENT_BINDINGS) {
    if (seen.has(row.event)) {
      throw new Error(\`generated bindings: duplicate event row \${row.event}\`);
    }
    seen.add(row.event);
    if (row.globals.length === 0 || row.globals[0] !== 'MODULE') {
      throw new Error(
        \`generated bindings[\${row.event}]: MODULE must be bound first for every event (LuaWebsiteModuleHandler.pas:47-49)\`,
      );
    }
    for (const name of row.readBack) {
      if (!row.globals.includes(name)) {
        throw new Error(
          \`generated bindings[\${row.event}]: readBack global \${name} is not bound in globals\`,
        );
      }
      if (name !== 'PAGENUMBER') {
        throw new Error(
          \`generated bindings[\${row.event}]: PAGENUMBER is the only read-back global (got \${name})\`,
        );
      }
    }
    if (row.pushOnly && row.readBack.length > 0) {
      throw new Error(
        \`generated bindings[\${row.event}]: pushOnly rows must not read anything back\`,
      );
    }
    if (
      row.constants !== 'net-status' &&
      row.constants !== 'account-status' &&
      row.constants !== 'none'
    ) {
      throw new Error(
        \`generated bindings[\${row.event}]: unknown constant binding \${String(row.constants)}\`,
      );
    }
  }
}
`;
}
