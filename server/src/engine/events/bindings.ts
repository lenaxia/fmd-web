import type { EventBinding } from '@fmd/contract';

/**
 * Event-binding table placeholder (DESIGN.md §11 engine/events).
 *
 * The production table is GENERATED from contract/contract.json and
 * CI-cross-checked against a fresh parse of the Pascal Do* dispatchers
 * (§5 implementation rule, §13.5). Until generation lands, consumers
 * must treat this module as scaffolding only.
 */

export const BINDINGS_ARE_GENERATED: boolean = false;

export function generationNote(): string {
  return 'binding tables are generated from contract/contract.json in a later story (§5.2 as data)';
}

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
  if (
    typeof event !== 'string' ||
    (returns !== 'code' && returns !== 'boolean' && returns !== 'string') ||
    !Array.isArray(globals) ||
    !Array.isArray(readBack)
  ) {
    return undefined;
  }
  return {
    event,
    returns,
    globals: globals.filter((g): g is string => typeof g === 'string'),
    readBack: readBack.filter((g): g is string => typeof g === 'string'),
  };
}
