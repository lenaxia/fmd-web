/**
 * Opaque pagination cursors (DESIGN.md §10): base64url of a small JSON
 * record. The API layer treats cursor CONTENTS as the owning service's
 * business — this module only encodes/decodes and bounds-checks payload
 * size, so each service keeps its own stable pagination semantics (the
 * job list uses keyset cursors, FTS search uses the store's
 * query-bound cursors).
 */
import { ApiError } from './errors.js';

/** Decode `cursor` into its JSON record; garbage → 400 bad_request. */
export function decodeCursor(cursor: string): Record<string, unknown> {
  let json: string;
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ApiError(400, 'bad_request', 'invalid cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new ApiError(400, 'bad_request', 'invalid cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'bad_request', 'invalid cursor');
  }
  return parsed as Record<string, unknown>;
}

/** Encode a record into an opaque, URL-safe cursor. */
export function encodeCursor(record: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
}
