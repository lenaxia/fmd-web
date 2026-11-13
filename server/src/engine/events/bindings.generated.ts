// -----------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source of truth: contract/contract.json (§5.2 event-binding rows).
// Generator:       server/tools/generate-bindings.ts
//                  (npm run gen:bindings -w @fmd/server)
//
// Events SHA-256: 140d6c99c872abeec5c83a7068665e08eca1b911cc30aa749a306373fb3fa899
//
// Any change to contract.json that alters the §5.2 rows MUST be applied by
// re-running the generator; server/test/engine/events/bindings-golden.test.ts
// fails when this file drifts from the contract document.
// -----------------------------------------------------------------------

import type { ConstantBinding, EventReturnKind } from '@fmd/contract';

/** Every global the contract binds for at least one event (§5.2). */
export type EventGlobalName =
  | 'FILENAME'
  | 'HTTP'
  | 'LINKS'
  | 'MANGAINFO'
  | 'MODULE'
  | 'NAMES'
  | 'PAGENUMBER'
  | 'PATH'
  | 'TASK'
  | 'UPDATELIST'
  | 'URL'
  | 'WORKID'
  | 'WORKPTR';

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
  {
    event: 'GetDirectoryPageNumber',
    returns: 'code',
    globals: ['MODULE', 'HTTP', 'UPDATELIST', 'PAGENUMBER', 'WORKPTR'],
    readBack: ['PAGENUMBER'],
    pushOnly: false,
    constants: 'net-status',
  },
  {
    event: 'GetNameAndLink',
    returns: 'code',
    globals: ['MODULE', 'HTTP', 'NAMES', 'LINKS', 'UPDATELIST', 'URL'],
    readBack: [],
    pushOnly: false,
    constants: 'net-status',
  },
  {
    event: 'GetInfo',
    returns: 'code',
    globals: ['MODULE', 'MANGAINFO', 'HTTP', 'URL'],
    readBack: [],
    pushOnly: false,
    constants: 'net-status',
  },
  {
    event: 'BeforeUpdateList',
    returns: 'boolean',
    globals: ['MODULE', 'UPDATELIST'],
    readBack: [],
    pushOnly: false,
    constants: 'none',
  },
  {
    event: 'AfterUpdateList',
    returns: 'boolean',
    globals: ['MODULE', 'UPDATELIST'],
    readBack: [],
    pushOnly: false,
    constants: 'none',
  },
  {
    event: 'TaskStart',
    returns: 'boolean',
    globals: ['MODULE', 'TASK'],
    readBack: [],
    pushOnly: false,
    constants: 'none',
  },
  {
    event: 'GetPageNumber',
    returns: 'boolean',
    globals: ['MODULE', 'TASK', 'HTTP', 'URL'],
    readBack: [],
    pushOnly: false,
    constants: 'none',
  },
  {
    event: 'GetImageURL',
    returns: 'boolean',
    globals: ['MODULE', 'TASK', 'HTTP', 'WORKID', 'URL'],
    readBack: [],
    pushOnly: false,
    constants: 'none',
  },
  {
    event: 'BeforeDownloadImage',
    returns: 'boolean',
    globals: ['MODULE', 'TASK', 'HTTP', 'WORKID', 'URL'],
    readBack: [],
    pushOnly: true,
    constants: 'none',
  },
  {
    event: 'DownloadImage',
    returns: 'boolean',
    globals: ['MODULE', 'TASK', 'HTTP', 'WORKID', 'URL'],
    readBack: [],
    pushOnly: false,
    constants: 'none',
  },
  {
    event: 'SaveImage',
    returns: 'string',
    globals: ['MODULE', 'HTTP', 'PATH', 'FILENAME'],
    readBack: [],
    pushOnly: false,
    constants: 'none',
  },
  {
    event: 'AfterImageSaved',
    returns: 'boolean',
    globals: ['MODULE', 'FILENAME'],
    readBack: [],
    pushOnly: false,
    constants: 'none',
  },
  {
    event: 'Login',
    returns: 'boolean',
    globals: ['MODULE', 'HTTP'],
    readBack: [],
    pushOnly: false,
    constants: 'account-status',
  },
  {
    event: 'AccountState',
    returns: 'boolean',
    globals: ['MODULE'],
    readBack: [],
    pushOnly: false,
    constants: 'account-status',
  },
  {
    event: 'CheckSite',
    returns: 'boolean',
    globals: ['MODULE'],
    readBack: [],
    pushOnly: false,
    constants: 'account-status',
  },
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
      throw new Error(`generated bindings: duplicate event row ${row.event}`);
    }
    seen.add(row.event);
    if (row.globals.length === 0 || row.globals[0] !== 'MODULE') {
      throw new Error(
        `generated bindings[${row.event}]: MODULE must be bound first for every event (LuaWebsiteModuleHandler.pas:47-49)`,
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
    if (row.pushOnly && row.readBack.length > 0) {
      throw new Error(
        `generated bindings[${row.event}]: pushOnly rows must not read anything back`,
      );
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
