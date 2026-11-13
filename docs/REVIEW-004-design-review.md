# REVIEW-004 — Adversarial Design Review, Round 4 — Convergence Check (of DESIGN.md v4)

Reviewer: independent skeptical-architect agent. Scope: verify the nine
v4 deltas, then a final corpus sweep for remaining Majors. Status:
**accepted** — the two Majors and five minors are fixed in DESIGN.md v5;
the reviewer's own recommendation was "proceed to implementation" with
exactly these amendments applied.

---

## Convergence verdict

**Architecture converged; contract surface complete after v5.** All nine
v4 deltas verified correct against source (first round with zero
misstatements). No Critical findings. Two Majors remained, both §5
contract-surface completions (no architectural change), fixed in v5.

## v4 delta verification (all correct)

`pb` row (corpus-wide: only `pb.decode/load/encode` used; no
`pb.option/setdefault/loadfile`) ✅ · §5.8 dedup last-occurrence-wins
(`uData.pas:165–166`) ✅ · bypass single-flight fallthrough
(`LuaWebsiteBypass.pas:161, 197–200, 177, 184–188, 94–115/159`) ✅ ·
Storage facade (`LuaStringsStorage.pas:150–159`) ✅ · unknown-property
tolerance (`LuaClass.pas:94–169`; `luaclass_caseinsensitive` never
defined) ✅ · require names (11 `AddLib` sites, `LuaPackage.pas:23,71–91`;
census of 417 modules + templates maps 1:1 onto §5.7) ✅ · D17–D20 sane ✅ ·
citations (`:717`, `:749–755`, `:838–874`) ✅.

## New findings (fixed in v5)

### M1 — `fmd.duktape` JS-side CommonJS `require` (77 modules)
`ExecJS` initializes Duktape's module system (`duk_module_duktape_init` +
`Duktape.modSearch`, `Duktape.pas:88–89, 73`; file resolution
`loadModuleFile`, `:106–147`). In-JS `require` is load-bearing for
`templates/Madara.lua:178–179` (`require("utils/crypto-js.min.js")` inside
the chapter-protector decryption — the **default flow**, distinct from the
already-gated `run_html_load` at `:169`) and `MangaGo.lua:206`. An
"ExecJS + Duktape.enc/dec" shim as v4 specified fails these with
"module not found". Fix: CommonJS `module`/`exports` loader with
per-context caching, jailed to the synced `lua/` tree.

### M2 — `ParseHTML` is a 1-arg instance method, not a constructor
`LuaXQuery.pas:45–56, 193`: exactly one argument (string or stream),
returns nothing (mutates in place). v4's "`ParseHTML(html[, url])`
constructor" was fabricated; breakage class: nil-call in MangaDemon:42,
dm5:79, InManga, TonarinoYoungJump, MangaEsp template, etc. Fix:
re-listed as instance method; §13.5 CI cross-check extended to facade
method tables so this class is caught mechanically.

## Minor findings (fixed in v5)

1. `debug.getinfo` (read-only) must stay exposed — `MangaPlus.lua:106`.
2. `io` jail covers the whole namespace (`io.lines/output/write`,
   `MangaDex.lua:159–183`); relative `userdata/…` paths map to a
   persistent per-module state dir.
3. `ExecJS` error ⇒ **nil** (not exception, `LuaDuktape.pas:18–24`); JS
   `print` → host log (`Duktape.pas:90`).
4. imagepuzzle API enumerated (`LuaImagePuzzle.pas:73–99`: New/Create,
   HorBlock/VerBlock, Matrix/Flips/Multiply, DeScramble; in-place calls,
   non-square grids).
5. `pb.load` returns `(ret, pos)` — `protoc.lua:1176,1183` bind both.
6. Madara capability flag = `run_html_load` only (Duktape path is
   default-flow).

## Final risk posture per subsystem

| Subsystem | Residual risk | Basis |
|---|---|---|
| Contract fidelity | low (post-v5) | 4 rounds; every finding fixed with file:line grounding; CI drift check now covers dispatchers **and** facade tables |
| Catalog pipeline | low | read-only attach + FTS sidecar + jdn ordering verified rounds 2–3 |
| Downloads | low | dedup direction provably matches `uData.pas`; 'W'/'D' resume, streaming pack, truncation grounded |
| Favorites | low | DoCheck parity + dual-write verified round 2 |
| Security | low-medium | boundary model sound; jail scope now enumerated (io namespace, JS require, debug, userdata mapping) |
| Ops/deployability | low | D18–D20 concrete and testable; pinning/SBOM discipline |

## Recommendation

**Proceed to implementation.** Conditions (all satisfied by v5): §5.7
Duktape `require` amendment, §5.6 ParseHTML amendment, jail notes, and
the extended §13.5 CI check. Four rounds produced no Critical findings
since round 2, and remaining findings were enumerable surface
completions, not design flaws.
