# Evidence — tsk-insular-tray-kicks (WS progress hub: bounded backfill, reconnect protocol, D21 slow-consumer policy)

Date: 2026-11-14T10:16Z · Environment: node v24, fastify 5.12, ws 8.23.0, zod 4.6.7, vitest 3.2.7 · Offline (loopback sockets only, per the §13 zero-network guard)

## Scope

`server/api/ws` per DESIGN §10 + D19: a WebSocket hub (`/ws`) broadcasting
job/progress/sync events as `{type:'event', id, job}` snapshots, a per-job
ring buffer (LAST 1000 events, 15-minute max age), the reconnect protocol
(`hello{lastEventId}` → exact replay of everything newer, or a `resync`
hint when the window is beyond buffer/age/epoch, then live), hub-global
monotonic event ids, and the documented+tested D21 slow-consumer policy
(drop-oldest with a contiguous `gap` marker). Message schemas are typed
and SHARED with the web client through the contract package
(`@fmd/contract` — the same zod source as the REST `Job` payloads).

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Backfill integration test: disconnect → N events emitted → reconnect with lastEventId → receives exactly the missing sequence then live events | `server/test/api/ws/ws.integration.test.ts` ("disconnect mid-job → events emitted → reconnect with lastEventId…"): REAL loopback WebSockets — session 1 receives events 1–3 live, `close()`s, the server emits 4–7 (interleaved across two jobs), session 2 reconnects with `lastEventId:'3'` and the test asserts the client's complete id sequence is **exactly ['1'..'8']** — the missing 4–7 replayed in id order with event 8 at the live seam (order-proof holds whichever side of the hello/publish race event 8 lands on: at the client the seam is indistinguishable, which is the property under test). Unit-level twins in `hub.test.ts` ("replays EXACTLY the buffered events above the cursor", "cursor exactly at the newest id → no replay", "re-hello ignored"). | met |
| Beyond-buffer reconnect receives the resync hint (buffer + age boundary tests) | Integration: **1001 events against the D19 constants** (`WS_RING_CAPACITY=1000`) → reconnect with cursor `'0'` receives `{type:'resync'}`; cursor `'1'` (the eviction watermark) replays exactly events 2..1001; epoch skew (cursor ahead of the newest id, restart semantics) → resync; **age boundary with the injected clock**: at `maxAge − 1 ms` the replay is exact, at exactly `15 min` the sweep evicts → resync. Unit: `ring-buffer.test.ts` (12 boundary tests — capacity exact-at/overflow/1001st-of-1000, age exactly-at vs 1 ms under, old-prefix-only sweeps, watermark = MAX across capacity AND age evictions, monotonic-id enforcement, capacity 1) and `hub.test.ts` ("resync at the buffer boundary: cursor below the eviction watermark" vs "cursor AT the watermark is reconstructable", "resync at the AGE boundary: exactly 15 min is beyond the buffer"). | met |
| Slow-consumer policy: drop-oldest + gap marker asserted under a stalled reader | `ws.integration.test.ts` ("drop-oldest + gap marker: received ∪ gap ranges covers every published id exactly once"): the client socket is PAUSED and the hub's pump gate reports backpressure (`canSend` seam — deterministic; kernels absorb writes for paused readers, which is why the seam is overridable), queueLimit 16, 200 events published → drops happen under the stall → reader resumes → the test asserts on the WIRE: exactly ONE contiguous `gap` marker, `droppedEvents + received == TOTAL`, **{received events} ∪ {gap range} covers ids 1..200 exactly once with no duplicates**, events strictly increasing. Unit: `hub.test.ts` D21 describe — drop-oldest keeps the newest and merges every drop into ONE contiguous marker across a 40-event overflow run; a dropped `resync` hint is re-emitted at the tail; the hello/replay phase is unbounded (a 50-event backfill survives queueLimit 4 with zero drops); the pump resumes when the stall ends; `close()`/`onClose()` lifecycle. **Documented**: hub.ts module doc + DESIGN.md §10 note + Decision Log **D21**. | met |
| Event schemas: shared zod types used by both server and (via package import) web client — type-drift test | `contract/schemas.ts` (NEW, in `@fmd/contract`): `JobSchema`/`TimestampSchema`/`JobStateSchema` (REST/WS-shared payloads — server/src/api/schemas.ts now **imports + re-exports instead of redefining**, so REST `/api/jobs*` and every WS event frame validate against ONE zod source) plus the WS protocol (`WsHelloMessageSchema`, `WsJobEventMessageSchema`, `WsGapMessageSchema`, `WsResyncMessageSchema`, discriminated unions, decimal `WsEventIdSchema`, D19 constants). Server consumers: hub (parse-before-send on every outbound frame — same discipline as the REST routes), attach layer, REST schemas. Web consumer: `web/src/state/ws-protocol.ts` re-exports the contract types (`@fmd/contract` workspace dep; hand-rolled bundle-light narrow in `ws-backfill.ts`). **Type-drift tests**: `server/test/api/ws/wire-drift.test.ts` converts the shared `JobSchema` with openapi.ts's exact recipe (same `z.globalRegistry` ids + `z.toJSONSchema` options) and deep-equals the **committed OpenAPI snapshot's `Job`/`Timestamp` components** (plus parse round-trips and decimal-id rejection) — chained with the existing `web/test/api-drift.test.ts` (snapshot ↔ generated client, byte-compare) and `web/test/ws-contract-drift.test.ts` (every contract-valid frame round-trips through the client parser; client-accepted frames satisfy the shared schema; `expectTypeOf` pins that the client aliases ARE the contract types and `eventJobToWire` targets the generated `Job`). A REST-side redefinition or snapshot regeneration that skips the shared schema fails the suite. | met |

## Implementation notes

- **Files**: `contract/schemas.ts` (shared zod source; `contract/types.ts` re-exports), `server/src/api/ws/{ring-buffer,hub,attach}.ts`, `server/src/api/{app,schemas}.ts` wiring, `server/src/runtime/{assembly,runtime-entry}.ts` (production: `attachWebSocketHub(rawServer, wsHub)` + drain closes WS clients first — upgraded sockets would hold `server.close()` open), `web/src/state/{ws-protocol,ws-backfill,use-jobs-feed}.ts`, tests ×4.
- **Event ids are hub-global and strictly increasing per publish** (hence per job) — decimal strings, the client's backfill cursor. The ring buffer is PER JOB (1000/15 min each); replay merges across jobs in id order (the `/ws` stream is the whole jobs feed, matching the SPA's single cursor).
- **Reconnect decision** (after an age sweep): no events ever, cursor ahead of the newest id (previous hub epoch — restart), or cursor below the global eviction watermark (`lastEvictedId` = MAX id ever evicted, capacity OR age) → `resync`; otherwise replay `(cursor, newest]` exactly. The replay + live registration happen in one synchronous step — no duplicate and no hole at the seam.
- **Hello semantics** (per the client-side contract comment, now honored server-side): a hello WITHOUT `lastEventId` replays the **full buffered tail**, then live — buffers absorb pre-hello publishes, so the tail is exact however the timing falls (this also removed the only nondeterminism the wire tests initially exposed). A malformed first frame (undecodable JSON, wrong shape, non-decimal cursor) answers `resync` — the client refetches instead of trusting an unhonorable cursor. One hello per connection; later frames ignored.
- **D21 (`canSend` seam)**: the pump gates on `socket.bufferedAmount < bufferedLimitBytes` (1 MiB default) but accepts a custom predicate — loopback kernels absorb writes for paused readers, so the wire drill injects a closed gate to stay deterministic; deployments behind proxies can supply a tighter policy. Queue depth 256 default; overflow drops the OLDEST entries and folds them (plus any prior marker) into ONE contiguous `gap` marker ahead of everything newer; dropped `resync` hints re-emerge at the tail.
- **Transport**: no @fastify/websocket — `WebSocketServer({ noServer: true })` behind a `server.on('upgrade')` hook (`attachWebSocketHub`), path-enforced (`/ws`, everything else gets a plain-HTTP 404), optional `authenticate(req)` gate for the §10 password mode. Non-JSON/binary frames ignored; send failures treated as dying sockets (the close handler cleans up).
- **Client updates** (`ws-backfill.ts`): `gap` handled exactly like `resync` (clear cursor + `onResync` refetch); `parseServerMessage` narrows the new union; `use-jobs-feed.ts` projects contract `JobT` → generated `JobWire` via `eventJobToWire` (same strip-undefined-optionals discipline as the server's REST `toJobWire`) so `exactOptionalPropertyTypes` composes across the zod/OpenAPI boundary.
- **Version pins**: `ws@8.23.0` + `@types/ws` (server deps), `zod@^4.6.7` (contract deps — the package now emits runtime schemas), `@fmd/contract: "*"` (web deps); lockfile updated via `npm install`.

## Verification

```
npx vitest run server/test/api/ws/ web/test/ws-contract-drift.test.ts
  → Test Files 4 passed · Tests 49 passed (12 ring-buffer + 19 hub + 10 integration
    + 3 wire-drift + 5 ws-contract-drift)
npx tsc -b tsconfig.json   → clean for all touched workspaces (pre-existing
  failures in server/test/jobs/download/* belong to the in-flight download-engine
  story: they import server/src/jobs/download/* which does not exist yet)
```

OpenAPI snapshot: unchanged (the shared `JobSchema` definition is byte-for-byte
the one the snapshot was generated from; `openapi.test.ts` and the drift tests
all stay green).
