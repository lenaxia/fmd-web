import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ConstantBinding, ContractDocument, EventBinding, EventReturnKind } from '@fmd/contract';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_EVENT_BINDINGS,
  assertGeneratedBindingsSanity,
} from '../../../src/engine/events/bindings.generated.js';
import { EVENT_BINDINGS } from '../../../src/engine/events/bindings.js';
import {
  assertEventRowsSanity,
  collectGlobalNames,
  renderBindingsModule,
  toSanityRow,
  type SanityRow,
} from '../../../tools/render-bindings.js';

/**
 * Golden + drift tests for the GENERATED §5.2 binding table (DESIGN.md §5
 * implementation rule, §11): the committed bindings.generated.ts must be
 * byte-identical to what the generator emits from contract/contract.json,
 * and the table must satisfy the §5.2 sanity invariants. Any contract.json
 * change without regeneration fails here (CI contract drift check).
 */

const require = createRequire(import.meta.url);
const CONTRACT: ContractDocument = JSON.parse(
  readFileSync(require.resolve('@fmd/contract/contract.json'), 'utf8'),
) as ContractDocument;

const GENERATED_FILE = fileURLToPath(
  new URL('../../../src/engine/events/bindings.generated.ts', import.meta.url),
);

function normalizedContractRows(): EventBinding[] {
  return CONTRACT.events.map((row) => ({ ...row, pushOnly: row.pushOnly === true }));
}

describe('bindings golden (§5.2) — generated table equals contract.json', () => {
  it('the generated table is deep-equal to the contract.json event rows', () => {
    expect(GENERATED_EVENT_BINDINGS).toEqual(normalizedContractRows());
    expect(GENERATED_EVENT_BINDINGS.length).toBe(15);
  });

  it('renderer output drift check: regenerated text is byte-identical to the committed file', () => {
    const committed = readFileSync(GENERATED_FILE, 'utf8');
    const regenerated = renderBindingsModule(CONTRACT.events);
    expect(regenerated).toBe(committed);
  });

  it('the dispatcher default table IS the generated table', () => {
    expect(EVENT_BINDINGS).toBe(GENERATED_EVENT_BINDINGS);
  });

  it('the committed file passes its own sanity assertion', () => {
    expect(() => assertGeneratedBindingsSanity()).not.toThrow();
    expect(() =>
      assertEventRowsSanity(normalizedContractRows().map(toSanityRow)),
    ).not.toThrow();
  });

  it('global name union covers exactly the names the contract binds', () => {
    expect(collectGlobalNames(CONTRACT.events)).toEqual([
      'FILENAME', 'HTTP', 'LINKS', 'MANGAINFO', 'MODULE', 'NAMES',
      'PAGENUMBER', 'PATH', 'TASK', 'UPDATELIST', 'URL', 'WORKID', 'WORKPTR',
    ]);
    // URL is push-only (never read back); PAGENUMBER is the only read-back
    expect(GENERATED_EVENT_BINDINGS.filter((r) => r.readBack.length > 0)).toEqual([
      {
        event: 'GetDirectoryPageNumber',
        returns: 'code',
        globals: ['MODULE', 'HTTP', 'UPDATELIST', 'PAGENUMBER', 'WORKPTR'],
        readBack: ['PAGENUMBER'],
        pushOnly: false,
        constants: 'net-status',
      },
    ]);
    expect(GENERATED_EVENT_BINDINGS.find((r) => r.pushOnly)?.event).toBe(
      'BeforeDownloadImage',
    );
  });
});

describe('bindings sanity assertion catches corruption', () => {
  const base: SanityRow[] = normalizedContractRows().map(toSanityRow);

  /** Patch keys without `undefined` (exactOptionalPropertyTypes-safe). */
  type RowPatch = Partial<{
    event: string;
    returns: EventReturnKind;
    globals: readonly string[];
    readBack: readonly string[];
    pushOnly: boolean;
    constants: ConstantBinding;
  }>;

  function mutate(index: number, patch: RowPatch): SanityRow[] {
    const src = base[index];
    if (src === undefined) {
      throw new Error(`no base row at index ${String(index)}`);
    }
    const mutated: SanityRow = {
      event: patch.event ?? src.event,
      returns: patch.returns ?? src.returns,
      globals: patch.globals ?? src.globals,
      readBack: patch.readBack ?? src.readBack,
      pushOnly: patch.pushOnly ?? src.pushOnly,
      constants: patch.constants ?? src.constants,
    };
    const rows: SanityRow[] = base.map((r) => ({ ...r }));
    rows[index] = mutated;
    return rows;
  }

  it('rejects a row whose first global is not MODULE', () => {
    expect(() =>
      assertEventRowsSanity(mutate(5, { globals: ['TASK', 'MODULE'] })),
    ).toThrow(/MODULE must be bound first/);
  });

  it('rejects a duplicate event row', () => {
    const rows: SanityRow[] = base.map((r) => ({ ...r }));
    const src = rows[0];
    if (src === undefined) {
      throw new Error('base rows must not be empty');
    }
    rows[1] = { ...src };
    expect(() => assertEventRowsSanity(rows)).toThrow(/duplicate event row/);
  });

  it('rejects a readBack global that is not bound', () => {
    expect(() =>
      assertEventRowsSanity(mutate(0, { readBack: ['TASK'] })),
    ).toThrow(/readBack global TASK is not bound/);
  });

  it('rejects reading back anything but PAGENUMBER (§5.2: URL never read back)', () => {
    expect(() =>
      assertEventRowsSanity(
        mutate(0, {
          globals: ['MODULE', 'HTTP', 'UPDATELIST', 'URL', 'WORKPTR'],
          readBack: ['URL'],
        }),
      ),
    ).toThrow(/PAGENUMBER is the only read-back global/);
  });

  it('rejects pushOnly rows that read back', () => {
    expect(() =>
      assertEventRowsSanity(mutate(8, { pushOnly: true, readBack: ['URL'] })),
    ).toThrow(/pushOnly rows must not read anything back/);
  });

  it('rejects unknown constant bindings', () => {
    expect(() =>
      assertEventRowsSanity(
        mutate(0, { constants: 'both-status' as unknown as (typeof base)[number]['constants'] }),
      ),
    ).toThrow(/unknown constant binding/);
  });
});
