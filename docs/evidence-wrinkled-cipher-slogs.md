# Evidence — tsk-wrinkled-cipher-slogs (server/api per DESIGN §10: Fastify + zod, auth, idempotency, cursor pagination, health, OpenAPI snapshot)

## Delivered

`server/src/api/` — the complete §10 API surface as a contract-based
Fastify application. **zod 4 is the single source of truth**: request
AND response types are inferred from the route schemas (`z.infer`,
never hand-duplicated), handlers receive narrowed bodies through
`parseOr400`, outgoing bodies are re-validated through the same
response schemas before send, and the OpenAPI 3.1 document is
GENERATED from those same schemas via zod's native JSON Schema output.
Fastify's AJV is deliberately unused so there is exactly one
validation implementation and no schema-copy drift (documented in
`app.ts` / `openapi.ts` headers, per the typebox-acceptable-if-documented
clause).

- **`schemas.ts`** — every §10 route's request/query/response zod
  schemas: module summaries (§5.10 capability + D3 known-broken flags,
  §5.1 options with combobox `items` — the STORED value is the item
  INDEX), sync outcomes (D9 sweep summary projection, §6.2–§6.3
  catalog results), catalog browse/search (§6.6, `CATALOG_PAGE_MAX`
  bounds), §5.8 normalized info, jobs (§7.1 states, §9 job columns,
  idempotencyKey), auth (login, session-cookie name), health
  boundaries, and the ONE typed error envelope
  (`{ error: { code, message, details? } }`).
- **`app.ts`** — `buildApp(services, options)`: all routes wired;
  central error handler (ApiError → envelope, anything else → 500
  internal_error); 404 envelope handler; info TTL cache; sync/catalog
  failure mapping (cursor-class store errors → 400, read failures →
  502 upstream_error). Fully deterministic + side-effect free, so
  `fastify.inject` tests and the real socket share one code path.
- **`services.ts`** — route→domain ports (`ModuleService`,
  `CatalogService` = the contract's `CatalogStore`,
  `InfoService`, `JobService`, `SyncService`) + documented in-memory
  stand-ins for app.db (same pattern as
  `InMemoryModuleRegistryPersistence`): jobs with numeric monotonic
  ids, §10 idempotency table (canonical-JSON sha256 payload
  fingerprints), keyset cursors; modules with the §5.1 option-value
  validation matrix (checkbox→boolean, edit→string, spinedit→integer,
  **combobox→integer item INDEX in range**) and §9 module_state.cookies.
- **`auth.ts`** — optional `FMD_WEB_PASSWORD`: unset → everything
  open (login = 400 auth_disabled); set → POST /api/auth/login mints
  an HttpOnly SameSite=Strict `fmd_session` cookie (randomBytes(32),
  timing-safe compare, 24 h TTL), login rate-limited **10/min per
  remote address** (429 + retryAfterSeconds details, fixed-window),
  and a Fastify `onRequest` gate: POST/PUT require a live session →
  else 401 envelope; GET routes and /healthz /readyz stay open (the
  SPA renders before login).
- **`openapi.ts` + `openapi.snapshot.json`** — OpenAPI 3.1 generated
  from the zod schemas (registry-shared components: ApiErrorEnvelope,
  ModuleSummary, ModuleOptionDescriptor, ModuleCapabilities,
  CatalogEntry, InfoRequest/Response, Job, Timestamp — refs rewritten
  to `#/components/schemas/...`), committed as a byte-stable snapshot
  (14 paths, 9 components, per-route 4xx/5xx envelopes, session-cookie
  security scheme on gated ops).
- **`errors.ts` / `cursor.ts`** — typed error envelope + opaque
  base64url cursors (garbage → 400 bad_request).
- **`main.ts`** — runtime entry bridged onto the Fastify app via
  `app.inject` (raw http → same app the tests exercise); keeps the
  Phase-0 exports (`SERVER_VERSION`, `startServer`, `respond`, …) so
  the Docker healthcheck and existing smoke tests hold;
  `createDefaultServices()` = placeholder adapters until the
  db/engine runtime stories wire SQLite.
- **`routes.ts`** — route inventory extended with /api/auth/login
  (cross-checked against the OpenAPI doc by test).

Dependencies: `fastify ^5.12.8`, `zod ^4.6.7` (server workspace).
**Fastify 5.12.8: `fastify.inject` runs without sockets → offline by
construction.**

## Tests — `server/test/api/` (66 tests, all offline via inject)

- **`modules.test.ts`** — GET/PUT happy paths, combobox INDEX
  semantics (item TEXT / out-of-range / negative / fractional → 400
  with INDEX message), kind matrix, unknown option 400, bad id /
  wrong body types / empty patch 400, unknown module 404,
  cookies-only update (§9 module_state.cookies).
- **`auth.test.ts`** — disabled mode (all open; login 400), login
  success (cookie flags asserted, password never in the cookie),
  wrong password 401, login body validation, **the gate**: all six
  state-changing routes 401 without a session while every GET stays
  open; forged cookie 401; expired session 401; **rate limit**: 10
  attempts pass, 11th is 429 with retryAfterSeconds, per-IP isolation,
  window expiry resets.
- **`catalog.test.ts`** — latest (jdn DESC, page/limit, page 2),
  title (title ASC), search (q + status + genre filters, total),
  cursor walk collects every match exactly once, **cursor query
  binding** (rebound cursor → 400, never silently re-paged), garbage
  cursor → 400, page/limit/id validation, unknown catalog 404,
  install-then-read seam.
- **`info.test.ts`** — normalized §5.8 body, **response caching**
  (same key → served from cache, service called once; different url →
  miss; TTL expiry → service again; validation runs before the
  service), unknown module → typed 404, engine failure → 502
  upstream_error.
- **`jobs.test.ts`** — idempotency: create 201; **identical-key
  replay → the ORIGINAL job with 200** (no second row);
  canonical-JSON fingerprints (reordered keys still replay, one
  changed field → **409**); different key same payload → new job;
  no key → always fresh; validation failures; listing newest-first,
  state filter, cursor walk, bad limit/cursor envelopes.
- **`pagination.test.ts`** — **cursor stability across concurrent
  inserts**: seed 6, take page 1 + cursor, inject 4 more jobs while
  the walk is in flight, continue via cursor → exactly the remaining
  original jobs in order, no drift/duplicates/no new-job leakage;
  fresh listings DO surface the new jobs (page 1 of a new walk only);
  service-seam keyset property (boundary = id, exact end = no
  trailing cursor).
- **`openapi.test.ts`** — **snapshot test**: generated document is
  byte-equal to the committed `openapi.snapshot.json` (determinism
  asserted too) — any unintended API drift fails; regeneration is
  explicit (`npm run api:snapshot`, committed intentionally); route
  inventory ↔ document cross-check (every non-WS §10 route documented,
  no extras); all `$ref`s resolve; shared components present;
  idempotency semantics (200 original / 201 create / 409) documented
  on the download route.
- **`health.test.ts`** — healthz/readyz bodies, readiness probe seam,
  main.ts raw-http → app bridge over a real loopback socket
  (healthcheck parity + envelope 404s + auth-disabled login through
  the socket).

## Verification

```
npm run typecheck   → clean
npm run lint        → clean
npm test            → 840 tests / 76 files pass (full repo suite, offline)
server/test/api     → 66 tests, 8 files, all fastify.inject (no sockets)
```

## Notes for the next stories

- SQLite adapters implement the SAME ports (`services.ts`) — routes
  untouched; the idempotency table and keyset cursor belong in the
  `job` row source.
- `/ws` (event stream, D19 backfill) is intentionally NOT part of
  this story (WS upgrade channel, not a JSON operation); it is absent
  from both the OpenAPI doc and its cross-check test.
- API drift is a deliberate act: change schemas, run
  `npm run api:snapshot`, commit the snapshot with the change.
