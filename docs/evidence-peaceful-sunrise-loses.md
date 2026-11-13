# Evidence — tsk-peaceful-sunrise-loses (Full 417-module Init sweep + capability/known-broken registry)

Date: 2026-11-13T19:15Z · Environment: node v24.20.0, vitest 3.2.7, wasmoon 1.16, linux — offline (§13 no-network guard active for every test)

## Scope

`server/src/engine/registry/` — the startup registry that wires the
ModuleSyncService (§2 lua/ sync consumer) + the LuaHost Init pass (§5.1)
into ONE SHA-gated boot (§9/§10). Per-file ERROR ISOLATION: one broken
module file is captured per file and never breaks the sweep. Full
registration over the REAL `/workspace/FMD2/lua/modules` tree (417
`.lua` files). Persistence = the module_state REGISTRY columns (§9:
`module_state(id PK, options JSON, name, root_url, category, file,
last_seen, …)`; the runtime cookies/ua columns stay with the §5.3 state
service boundary in `state/persistence.ts`).

New files:
`registry/capabilities.ts` (static require-graph detection + the §5.10
flag vocabulary), `registry/persistence.ts` (PersistedRegistry boundary +
in-memory store), `registry/module-sync.ts` (ModuleSyncService — sweep,
per-file isolation, deterministic summary), `registry/startup.ts`
(StartupRegistryService — sweep vs cached boot, byId/knownBroken query
surface). Tests: `server/test/engine/registry/` (28 tests).

## Acceptance criteria → evidence

All in `server/test/engine/registry/` — 28 tests green
(`npx vitest run server/test/engine/registry` → `28 passed (28)`); the
full workspace suite stays green outside the OTHER in-flight story's
untracked `server/test/sync/` files; eslint + tsc clean for the registry
tree (strict flags per tsconfig.base).

| Criterion | Evidence | Status |
|---|---|---|
| Sweep over the real 417-file tree: ≥95 % registered; per-file errors isolated (corrupted-file test proves no cascade) | `sweep.test.ts` "full-tree sweep": `totalFiles === 417` (the real tree), **411/417 files register = 98.6 % ≥ 95 %** (D3 target), 452 module registrations; the 6 failures (FanFox `fmd.mangafoxwatermark` not found; JapScan/Shakai/acqqcom/dm5 `luaL_loadbufferx … failed: 3` = LUA_ERRSYNTAX; MangaPlus `protoc.lua load descriptor msg failed`) each carry a non-empty per-file error, and files sorting AFTER the first failure still registered (no cascade, asserted). `isolation.test.ts` corrupted-file proof over a temp tree (4 real modules + 4 corruptions): Lua syntax error / `error('deliberate init boom')` in Init / require of a missing library / registration dropped for missing ID — every good file registers, every corruption captured INDIVIDUALLY with its own error (`/deliberate init boom/`, `/syntax\|unexpected\|near/`, …), sweep never throws, summary consistent. | met |
| Capability flags correct for all named special cases (TheBlank/RaijinScans/Comix/Madara-family/EHentai account) | `sweep.test.ts` §5.10 describe: `requires_subprocess` = EXACTLY `{Comix.lua, RaijinScans.lua, TheBlank.lua}` (utils.nodejs closure → `utils/nodejs.lua:41 RunCommandHide` → `fmd.subprocess`); `requires_browser` = EXACTLY the static `templates.Madara` require set (**76 ≤ 76**, `templates/Madara.lua:169 run_html_load`), each flagged `madara.run_html_load` with `requires_subprocess === false` (§5.10 Round-4: run_html_load ONLY — the template's own utils.nodejs use never leaks onto dependents; unit-proven with chunk maps in `capabilities.test.ts`); `bypass_python_gated` = `{HDoujin, MangaDotNet, OniSaga, SchaleNetwork}` (the `Cloudflare workaround is required` sentinel + manual-clearance option — the `websitebypass/cloudflare.lua:166-206` python/webdriver executor path); EHentai: 2 registrations — ExHentai `accountSupport === true` + `OnLogin` event + combobox option INDEX default, E-Hentai `accountSupport === false`. Event coverage from Init-declared On\* props: all 12 events × 452 modules reconcile (`OnGetInfo` 452/452, `OnLogin` 28), every key `On*`. Flag vocabulary pinned to contract.json ids (`fmd.subprocess`, `madara.run_html_load`, `webdriver.bypass`). | met |
| module_state persisted (restart → same registry without re-Init; re-Init on lua SHA change) | `persistence.test.ts` over a temp tree + `InMemoryModuleRegistryPersistence` (the SQLite adapter stays the db story's): first boot sweeps + persists rows (id/name/root_url/category/options schema/file/capabilities) with the tree SHA; a RESTARTED service over the SAME store boots `source: 'cache'` with `sweepCount === 0` (CountingSync detector — the Init pass never re-ran) and a deep-equal registry (`modules`, `byId`, `knownBroken`); `boot()` memoized per instance; editing one module file (comment touch → SHA change) → next boot `source: 'sweep'`, new SHA persisted, same registry content, and a third boot caches again. Tree SHA = SHA-256 over sorted `file\0sha256(source)` lines (`module-sync.ts treeSha`). | met |
| Registration summary JSON artifact committed | `server/test/engine/registry/registration-summary.json` — deterministic (no timestamps/durations; canonical (file, name) ordering; `treeSha` pins the FMD2 tree state): counts (`417/411/6/452`, `98.6 %`), the D3 `knownBroken` sets, per-event coverage, the 6 captured failures with errors, and the specialCases projections. `sweep.test.ts` byte-checks a fresh sweep against the committed file every run (`UPDATE_REGISTRATION_SUMMARY=1` regenerates — same pattern as the init-pass golden). | met |

## Implementation notes

- **Isolation mechanics**: the Init pass itself already converts a file's
  Lua failure into the FMD2 log shape `LUA>DoInit("<file>")> <error>`;
  ModuleSyncService attributes those records per file (records-before
  watermark), treats 0 registrations as a failure, and wraps each file in
  its own try/catch for JS-side throws (bridge/shim install) — three
  capture paths, one per-file result, zero cross-file effect. Every Init
  engine is offline: empty `RecordedResponseResolver` (§13).
- **Detection = static require-graph analysis** over the synced tree
  (`utils/*` closure → subprocess; `templates/*` closure → run_html_load;
  own-source signals → python-gated bypass) — offline, deterministic, and
  computed from the same sources the Init pass compiles. NOT runtime
  behavior: a module that would only `require` inside an event handler
  still counts (the flag describes the module's needs, published via
  /api/modules per §5.10/§10).
- **Real-tree id reality**: FMD2 enforces nothing on `m.ID` — the sweep
  preserved ids of length 30/32/33 incl. mixed-alphabet ones
  (`K042a85566244b7e836679491ce67ot0`); the registry contract is
  non-empty string (FMD2's own rule is only "ID and Name must be set").
- **`On*` restoration**: the descriptor binding table strips the `On`
  prefix (§5.2 rows); the registry publishes the Init-DECLARED prop names
  (`OnGetInfo`, `OnLogin`, …).
- **Known-broken failures are D3 content, not defects**: the 6 failures
  map 1:1 to published/known gaps (fmd.mangafoxwatermark shim lands with
  the §5.7 sharp-port story; 4 files carry genuine Lua-5.4 syntax errors
  in upstream FMD2; MangaPlus Init-time protoc load needs the pb
  descriptor story) — captured per file, published in the artifact.
