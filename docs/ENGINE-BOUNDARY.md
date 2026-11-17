# ENGINE-BOUNDARY — the hermetic engine boundary

*Story: tsk-linear-varnish-restricts (Gap Closure — post-audit). Design refs: DESIGN.md §5, §11.*

The module engine's Lua substrate (wasmoon hosts, shims, dispatch) must be
replaceable — a different runtime, native bindings, even a wholly different
module substrate — **without touching anything outside `server/src/engine`**.
This document defines the boundary, the machine checks that enforce it, and
the existence proof that it is real.

## The two doors

```
server/src/engine/facade.ts   the WASMOON-FREE domain surface
server/src/engine/index.ts    the PRODUCTION door: facade + the wasmoon-backed
                              default substrate + engine extras (worker pool,
                              shim table, event bindings, supervisor)
```

App layers (`api`, `jobs`, `runtime`, `sync`, `catalog`, `web`) and the
top-level entry files (`main.ts`, `index.ts`, `runtime-entry.ts`) import the
engine **only** through one of the two doors (or `@fmd/contract` for genuine
cross-boundary domain types). Everything else under `server/src` (accounts,
observability, db, tools) reaches the engine through the facade as well.

Why two doors:

- **facade.ts** re-exports only *domain-shaped* artifacts, and its runtime
  value graph is **wasmoon-free** (classes whose modules transitively import
  the shim installer — the sweep, the staged validator, the host drivers —
  are re-exported as **types only**; type-only re-exports never evaluate
  their source module). This is what lets the stub-substrate boot test
  import the whole app without wasmoon ever being evaluated.
- **index.ts** adds `createModuleRuntime()` (the wasmoon-backed default
  substrate) and the engine extras the package surface re-exports for
  tools/tests. The assembly loads it **lazily**
  (`await import('../engine/index.js')`) so a substituted runtime never
  evaluates wasmoon at all.

## Allowed dependency graph

```
                      ┌────────────────────────────────────────────────┐
                      │                @fmd/contract                   │
                      │  domain wire types + ApiError + NormalizedInfo │
                      │  + HostLogger/HostLogRecord + QueryEngine      │
                      └──────────────▲─────────────────────────────────┘
                                     │ (everyone may import contract)
 ┌──────────┐ ┌──────┐ ┌──────────┐ │  ┌────────┐ ┌──────┐ ┌──────────┐
 │ web (SPA)│ │ api  │ │   jobs   │ │  │  sync  │ │catalog│ │ runtime  │
 └────┬─────┘ └──┬───┘ └────┬─────┘ │  └───┬────┘ └──┬───┘ └────┬─────┘
      │           │           │       │      │         │         │
      └───────────┴───────────┴───────┼──────┴─────────┴─────────┘
                          facade TYPES + wasmoon-free provider VALUES
                                     │  (+ LAZY `await import(engine/index.js)`
                                     │   ONLY in the composition root /
                                     │   lazy construction sites)
                                     ▼
              ┌──────────────── server/src/engine ────────────────┐
              │  facade.ts (door 1: wasmoon-free domain surface)  │
              │  index.ts (door 2: + default substrate + extras)  │
              │                                                  │
              │  services/    module-info, download-hooks,        │
              │               account-session, directory-walk,    │
              │               download-ports, image-fetch,        │
              │               module-runtime (the substrate)      │
              │  registry/    sweep, startup, persistence,        │
              │               capabilities, staged-validation      │
              │  lua/ shims/ events/ state/ pipeline/ normalize/  │
              │  sidecar/     (the substrate mechanism)           │
              │                                                  │
              │  engine → contract + engine internals +           │
              │           node builtins + vetted leaf libs        │
              │           (wasmoon, linkedom, fontoxpath, undici, │
              │           socks-proxy-agent, aes-js)              │
              │  NEVER → api / jobs / runtime / sync / catalog /   │
              │          accounts / observability / db / web      │
              └──────────────────────────────────────────────────┘

  Designed exception (one edge, D4): engine/shims/install.ts imports
  tools/import/fmd2-crypto.js — the FMD2 EncryptString key holder the
  key-isolation design (D4) pins to the migration module. That edge is
  itself machine-checked by server/test/tools/import/fmd2-key-isolation.test.ts
  (literal-holder allowlist + importer whitelist + eslint rule).
```

## The CI gates

`scripts/engine-boundary-gate.sh` (wired into `scripts/ci.sh` right after
`typecheck`) scans non-test `server/src` and fails the build on four rules:

| rule | scope | violation |
|---|---|---|
| `facade-only` | app layers + top-level entries | any import resolving into `engine/*` other than the two doors |
| `no-lua-outside` | everything outside `engine/` | an import of `wasmoon`; a deep engine-submodule import; any imported binding named `Lua*`/`Wasmoon*` (mechanism types stay inside the engine — app code names them through facade domain aliases) |
| `engine-inward` | inside `engine/` | a relative import escaping into an app layer (dependencies point inward: engine → contract + engine internals + node builtins) |
| `facade-hygiene` | `engine/facade.ts` | a wasmoon import, or an exported binding named `Lua*`/`Wasmoon*` (the public surface is domain-shaped; alias mechanism types) |

`scripts/engine-boundary-mutate.sh` (also in `ci.sh`, immediately after the
gate) is the negative half: it plants one violation per rule — an app-layer
deep import, a wasmoon import outside the engine, a Lua-named type import,
an engine→app import, a Lua-named facade export — and asserts the gate
**fails citing that rule**. A rule that cannot fire proves nothing.

The eslint `no-restricted-imports` boundary (the earlier wasmoon gate from
tsk-able-steeple-tints) remains as a second, editor-visible layer: wasmoon
and `lua/host|engine` are importable only inside the host implementation and
the substrate factory.

## The stub-substrate swap proof (existence half)

`server/test/runtime/stub-substrate.test.ts` boots the FULL production
assembly (`buildRuntime`) on `StubModuleRuntime` — a test-only
implementation of the facade's `ModuleRuntime` interface with canned
registry rows (`initialModules`), a scripted info result, scripted download
hooks and login sessions, and stub sweep/walker. It asserts:

- `/healthz` + `/readyz` pass (D20 bootstrap disabled — the substrate
  vouches for the registry, nothing is fetched);
- `/api/modules` serves the stub registry rows;
- `/api/info` round-trips the scripted `NormalizedInfo` verbatim (the stub
  records the exact call);
- a download-job enqueue (`paused: true` hold) + `POST /api/jobs/:id/cancel`
  round-trips to `cancelled`;
- the opaque host factory is never called, and the stub's lifecycle
  (`dispose`) is respected on drain.

The proof has teeth two ways:

1. **The wasmoon canary.** The test registers
   `vi.mock('wasmoon', () => { throw … })` before importing anything. If any
   module on the booted app's import graph evaluates wasmoon, the suite dies
   with `wasmoon was evaluated on the stub-substrate boot path`. (Verified
   live: importing the production door under the same mock fires the
   canary — the mock is not decorative.)
2. **Interface completeness.** If the app secretly needed the Lua substrate
   anywhere outside `engine/`, this test could not be written — the
   substrate override would not typecheck (`ModuleRuntime` is the whole
   construction surface) or the boot would fall through to the real engine
   and trip the canary / the host-factory assertion.

The gates alone prove no *type* leaks; the stub alone proves the interfaces
*compile*. Together they prove replaceability.

## API-response hygiene (verified, no change)

API error/result envelopes carry **typed domain reasons**: failures cross
the engine→api boundary as the contract's `ApiError` (`{status, code:
ApiErrorCode, message, details?}` — the §10 envelope), results as contract
domain shapes (`NormalizedInfo`, the job failure taxonomy
`JobFailureKind = worker_stalled | engine_oom | net | pack`,
`EventDispatchResult`). One hygiene note for future readers: **engine-log
tails embedded in failure detail messages are log TEXT, not Lua values** —
e.g. the download hooks append the last three host log lines to a
`GetPageNumber failed: …` message; those lines are the module's `print`
output routed through `HostLogRecord`, already stringified. No Lua object,
table, or value ever crosses the boundary in an API response.

## The substrate-swap playbook

To replace the Lua substrate in the future (different runtime, native
bindings, a wholly different module substrate):

1. Implement `ModuleRuntime` (`server/src/engine/services/module-runtime.ts`
   — domain-shaped, facade-exported): the host factory (opaque), the sweep,
   info/login/download-hooks/walk services, and optionally `initialModules`
   when the new substrate owns its registry.
2. Provide any new port types **through the facade as domain types** — the
   gate refuses a widening "just for this one import" outside the door.
3. Wire it in the composition root (`buildRuntime`'s `substrate` option).
   Nothing outside `server/src/engine` moves; the CI gates + the stub proof
   (updated to the new stub) hold the line while you work.

Mechanism types (`LuaHost`, `LuaEngine`, chunks, facade bridges) live in
`server/src/engine/contract.ts` — engine-internal, never imported by name
outside the engine. The domain aliases the app sees (`ModuleHostFactory`,
`ModuleDescriptor`, `ModuleRegistry`, `EventDispatcher`, `QueryEngine`, …)
are declared in `engine/facade.ts`.
