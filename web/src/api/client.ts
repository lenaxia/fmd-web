/**
 * Typed API client — GENERATED surface only (DESIGN.md §10).
 *
 * `openapi.d.ts` is generated from the COMMITTED OpenAPI snapshot
 * (`server/src/api/openapi.snapshot.json`) by `npm run gen:api -w @fmd/web`
 * (openapi-typescript). No route, parameter or response type is ever
 * hand-written: every call site below is keyed by a path literal that
 * exists in `paths`, so a route rename/removal in the snapshot breaks
 * `tsc` here (and `web/test/api-drift.test.ts` fails when the snapshot
 * changes without regenerating).
 */
import createClient from 'openapi-fetch';
import type { paths } from './openapi';

/**
 * Same-origin API base (the server serves the SPA; §10 single
 * container). Computed lazily so the module also imports in Node
 * (drift test, ws tests) where no `location` exists.
 */
function defaultBaseUrl(): string {
  return globalThis.location?.origin ?? 'http://localhost';
}

export function createApiClient(fetchImpl?: typeof fetch): ReturnType<typeof createClient<paths>> {
  return createClient<paths>({
    baseUrl: defaultBaseUrl(),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });
}

/** Default client used by the app shell (tests inject their own). */
export type ApiClient = ReturnType<typeof createApiClient>;

/** WebSocket endpoint per §10 (`WS /ws`, D19 backfill). */
export function wsEndpointUrl(): string {
  const proto = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${globalThis.location.host}/ws`;
}
