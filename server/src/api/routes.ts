import type { RouteSpec } from '@fmd/contract';

/**
 * The §10 API surface as data (placeholder — Fastify routes arrive in a
 * later story; this table is the contract-driven route inventory).
 */
export const API_ROUTES: readonly RouteSpec[] = [
  { method: 'GET', path: '/api/modules', description: 'capability + known-broken flags' },
  { method: 'PUT', path: '/api/modules/:id', description: 'enable/disable, options, cookies, per-module proxy override' },
  { method: 'GET', path: '/api/settings', description: 'global proxy config + §5.11 browser profile state' },
  { method: 'PUT', path: '/api/settings/proxy', description: 'replace the global proxy config (HTTP|SOCKS4|SOCKS5 + host/port/user/pass)' },
  { method: 'POST', path: '/api/auth/login', description: 'session login (rate-limited 10/min); 400 when no FMD_WEB_PASSWORD is set' },
  { method: 'POST', path: '/api/sync/modules', description: 'sync FMD2 lua/ tree (SHA pin + report)' },
  { method: 'POST', path: '/api/sync/catalog/:id', description: 'sync one FMD2-DB catalog' },
  { method: 'POST', path: '/api/sync/catalog/all', description: 'sync all FMD2-DB catalogs' },
  { method: 'GET', path: '/api/catalog/:id/latest', description: 'ordered by jdn DESC (§6.6); catalog-less modules serve the §6.8 live directory walk (§5.8-normalized, TTL-cached) — every response carries source: catalog|live' },
  { method: 'GET', path: '/api/catalog/:id/title', description: 'ordered by title (§6.6); §6.8 live fallback like /latest, source discriminator carried' },
  { method: 'GET', path: '/api/catalog/:id/search', description: 'FTS5 search, cursor pagination (§6.5); catalog-less modules search their §6.8 live snapshot in memory with the SAME cursor scheme, source discriminator carried' },
  { method: 'POST', path: '/api/info', description: 'live info (normalized §5.8), cached' },
  { method: 'POST', path: '/api/jobs/download', description: 'idempotent job create (replay => original while live; key reuse with different payload => 409; terminal original => chained re-enqueue)' },
  { method: 'GET', path: '/api/jobs', description: 'job list, state filter + cursor' },
  { method: 'GET', path: '/api/jobs/:id', description: 'one job snapshot' },
  { method: 'POST', path: '/api/jobs/:id/cancel', description: 'user cancel (queued/running/retry -> cancelled; markers persist for resume)' },
  { method: 'GET', path: '/api/library', description: 'finalized chapter artifacts (library listing, cursor pagination)' },
  { method: 'GET', path: '/api/library/:id/file', description: 'download the packed artifact' },
  { method: 'GET', path: '/api/accounts', description: 'module accounts (§8.6/D4; password never returned)' },
  { method: 'PUT', path: '/api/accounts/:moduleId', description: 'create/replace a module account (username + password/cookies sealed with FMD_WEB_SECRET; omitted credential fields keep the stored values)' },
  { method: 'DELETE', path: '/api/accounts/:moduleId', description: 'remove a module account' },
  { method: 'POST', path: '/api/accounts/:moduleId/login', description: 'run module OnLogin via the event runtime (account-status constants); status + cookies persisted' },
  { method: 'GET', path: '/api/favorites', description: 'favorites listing (new-chapter badges + auto-download flags)' },
  { method: 'POST', path: '/api/favorites', description: 'create a favorite (initial live check, §5.8-normalized)' },
  { method: 'POST', path: '/api/favorites/import', description: 'tag-100 transfer-favorite bulk-ingest (D4): all live chapters marked downloaded' },
  { method: 'GET', path: '/api/favorites/:id', description: 'one favorite' },
  { method: 'PUT', path: '/api/favorites/:id', description: 'title + auto-download toggle' },
  { method: 'DELETE', path: '/api/favorites/:id', description: 'delete a favorite (its downloaded_chapters row is NOT touched)' },
  { method: 'POST', path: '/api/favorites/:id/check', description: 'manual check-now: immediate DoCheck cycle (live info → diff → auto-download)' },
  { method: 'WS', path: '/ws', description: 'event stream; reconnect backfills lastEventId (D19)' },
  { method: 'GET', path: '/healthz', description: 'liveness' },
  { method: 'GET', path: '/readyz', description: 'readiness' },
  { method: 'GET', path: '/api/metrics', description: 'Prometheus exposition (§4/§15; mounted only with a registry bound)' },
];

export function findRoute(method: RouteSpec['method'], path: string): RouteSpec | undefined {
  return API_ROUTES.find((r): boolean => r.method === method && r.path === path);
}
