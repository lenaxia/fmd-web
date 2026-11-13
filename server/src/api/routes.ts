import type { RouteSpec } from '@fmd/contract';

/**
 * The §10 API surface as data (placeholder — Fastify routes arrive in a
 * later story; this table is the contract-driven route inventory).
 */
export const API_ROUTES: readonly RouteSpec[] = [
  { method: 'GET', path: '/api/modules', description: 'capability + known-broken flags' },
  { method: 'PUT', path: '/api/modules/:id', description: 'enable/disable, options, cookies' },
  { method: 'POST', path: '/api/sync/modules', description: 'sync FMD2 lua/ tree (SHA pin + report)' },
  { method: 'POST', path: '/api/sync/catalog/:id', description: 'sync one FMD2-DB catalog' },
  { method: 'POST', path: '/api/sync/catalog/all', description: 'sync all FMD2-DB catalogs' },
  { method: 'GET', path: '/api/catalog/:id/latest', description: 'ordered by jdn DESC (§6.6)' },
  { method: 'GET', path: '/api/catalog/:id/title', description: 'ordered by title (§6.6)' },
  { method: 'GET', path: '/api/catalog/:id/search', description: 'FTS5 search, cursor pagination' },
  { method: 'POST', path: '/api/info', description: 'live info (normalized §5.8), cached' },
  { method: 'POST', path: '/api/jobs/download', description: 'idempotent job create (replay => original; key reuse with different payload => 409)' },
  { method: 'GET', path: '/api/jobs', description: 'job list, state filter + cursor' },
  { method: 'WS', path: '/ws', description: 'event stream; reconnect backfills lastEventId (D19)' },
  { method: 'GET', path: '/healthz', description: 'liveness' },
  { method: 'GET', path: '/readyz', description: 'readiness' },
];

export function findRoute(method: RouteSpec['method'], path: string): RouteSpec | undefined {
  return API_ROUTES.find((r): boolean => r.method === method && r.path === path);
}
