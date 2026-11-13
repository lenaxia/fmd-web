import type { EventBinding } from '@fmd/contract';
import {
  assertGeneratedBindingsSanity,
  GENERATED_EVENT_BINDINGS,
  type EventGlobalName,
  type GeneratedEventBindingRow,
} from './bindings.generated.js';

/**
 * §5.2 event-binding table (DESIGN.md §5 implementation rule, §11):
 * GENERATED from contract/contract.json by server/tools/generate-bindings.ts
 * — never hand-coded. See bindings.generated.ts (do not edit) and the
 * golden/drift tests in server/test/engine/events/bindings-golden.test.ts.
 */

export {
  assertGeneratedBindingsSanity,
  GENERATED_EVENT_BINDINGS,
  type EventGlobalName,
  type GeneratedEventBindingRow,
};

/** The generated table satisfies the §5.2 invariants at module load. */
assertGeneratedBindingsSanity();

/** The dispatcher's default binding source (§5.2 rows as generated data). */
export const EVENT_BINDINGS: readonly EventBinding[] = GENERATED_EVENT_BINDINGS;

/** Narrow an unknown value into the EventBinding shape without `any`. */
export function asEventBinding(value: unknown): EventBinding | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const event: unknown = rec['event'];
  const returns: unknown = rec['returns'];
  const globals: unknown = rec['globals'];
  const readBack: unknown = rec['readBack'];
  const constants: unknown = rec['constants'];
  if (
    typeof event !== 'string' ||
    (returns !== 'code' && returns !== 'boolean' && returns !== 'string') ||
    !Array.isArray(globals) ||
    !Array.isArray(readBack) ||
    (constants !== 'net-status' && constants !== 'account-status' && constants !== 'none')
  ) {
    return undefined;
  }
  return {
    event,
    returns,
    globals: globals.filter((g): g is string => typeof g === 'string'),
    readBack: readBack.filter((g): g is string => typeof g === 'string'),
    constants,
  };
}
