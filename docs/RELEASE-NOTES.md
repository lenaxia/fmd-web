# Release notes — fmd-web

## 0.3.1 — 2026-11-18

**Released:** 2026-11-18 · **Tag:** `v0.3.1` (annotated) · **Commits:**
`ee88e78` (websites-rebuild) → `7442b5f` (hotfix, release head)

A hotfix release on top of 0.3.0, carrying the Settings→Websites
registry rebuild that landed underneath it.

### Hotfix — search, /api/info, and API-token auth (`7442b5f`)

- **Union search survives upstream typos.** All-sites union search
  returned HTTP 500 when any module in the sweep shipped an invalid
  catalog id (a real upstream occurrence). Invalid-catalog-id modules
  are now gracefully excluded from the union instead of failing the
  whole request.
- **`/api/info` resolves host-relative catalog links.** Catalog results
  may carry links without a scheme/host; the API now joins them against
  the module's `RootURL` — FMD2 `MaybeFillHost` parity — fixing series
  pages that failed to load when reached from search or catalog
  listings.
- **API token decoupled from password auth (*arr semantics).** The
  single app-wide API token is auto-generated on first boot and rotates
  whenever password auth is switched off; the credential gate keys on
  the password only; the websocket is open when password auth is off.
  Reverse-proxy deployments (authelia, authentik) are first-class:
  authenticate at the edge, script against the token.
- **UI fixes.** Settings→API always renders (previously could fail to
  render before first token generation); Accounts lists enabled sites
  only.
- **Test seam closed.** A real-server/real-client contract test now
  covers `/api/info`, closing the drift seam left by the mocked e2e.
- **Docs.** Runbook §API-token and `docs/API.md` updated for the
  token/auth split.

### Settings→Websites rebuild (`ee88e78`)

- Faceted module registry: language chips (with `-Scanlation`
  collapsed), H-status, and needs-setup / AccountSupport filters, each
  with live counts.
- Global enable-all/disable-all scoped to the active filter.
- Proxy editor collapsed into a drawer.
- Language distribution visible at a glance.
- Union-spec race fix (union search spec vs. registry provisioning).

### Version string

Matching 0.2.0/0.3.0 precedent, the workspace `package.json` version
remains `0.1.0`; release identity lives in the annotated git tag and
the GitHub release.

---

## 0.1.0 — 2026-11-15

**Released:** 2026-11-15 · **Version:** 0.1.0 · **Image:** `fmd-web:0.1.0`
(build: `FMD_WEB_IMAGE_TAG=0.1.0 docker compose -f docker/compose.yml build app`;
the image carries `org.opencontainers.image.version=0.1.0`)

fmd-web is a Dockerized web rebuild of FMD2 (Free Manga Downloader 2)
that runs FMD2's Lua site-module ecosystem and the FMD2-DB catalogs
**unchanged** (DESIGN.md v5). This is the first release (Phase-0 →
Phase-5 complete).

Release documents:

| Artifact | Where |
|---|---|
| Changelog | `CHANGELOG.md` |
| Design (v5) + D-decisions | `DESIGN.md` |
| Per-binding compat tracker (gate-regenerated) | `docs/COMPAT.md` |
| Corpus machine report (golden-pinned) | `docs/corpus-report.json` |
| Release CI gate log (full, both e2e phases) | `docs/ci-gate-0.1.0.log` |
| Operations runbook | `docs/runbook.md` |
| Base-image digest pinning | `docs/docker-pinning.md` |
| Design reviews (v1→v5) | `docs/REVIEW-001..004-design-review.md`, `docs/REVIEW-velvet-pulley-prosper.md` |

---

### 1. Release CI gate — final status

`scripts/ci.sh` (full release gate) — **exit 0**; committed output:
`docs/ci-gate-0.1.0.log`.

| Step | Scope | Result |
|---|---|---|
| `contract:check` | Pascal extractors vs `contract.json` vs generated bindings (incl. all 22 binding rows, `BINDING_ROWS` gate) | PASS |
| `lint` | typescript-eslint strict, zero warnings policy | PASS |
| `typecheck` | `tsc -b` strict monorepo | PASS |
| `test` | unit + integration — one offline suite (DESIGN.md §13): **1597 tests / 149 files** | PASS |
| `corpus` | full seed replay vs FPC oracle: **912/912 (100%)** across 65 modules, floor ≥99%, zero undocumented mismatches; `docs/COMPAT.md` + `docs/corpus-report.json` byte-stable vs committed | PASS |
| e2e **phase-2** | compose stack (docker) or process twin: `docker compose config` render asserts (vendored pinned CLI — daemon-less), bootstrap-watch (D20 banner), wait-on `/readyz`, browse → search → live info → dry-run → Downloads; evidence: mock request log (zipball/commits/catalog/site — the ONLY upstream traffic), non-root uid 1000, digest/SBOM record. Ran in **process mode** (no docker daemon in the release environment; documented twin, same fixtures/mock/entry/specs) — drains 39 ms | PASS |
| e2e **phase-3** | + download gate: enqueue → WS progress → pack → library listing → artifact zip central-directory validation → slow-image cancel/resume (mock request-count asserted) → injected-500 retry recovery; SIGTERM drain ≤30 s with flush logs, clean exit 0 — drain 71 ms, all 3 phase3 scenarios green in both runs | PASS |
| `--live` smoke | optional (explicit flag only; never unattended) — nightly rotating sample harness, `server/tools/smoke/run.ts` | not part of this gate (by design) |

No gate item is red. One release-gate fix landed during this sweep:
`p256GenerateKeyPair` zero-pads the private scalar when node returns the
minimal-BIGNUM encoding (leading-zero key, ~1/256 of generations) —
previously a non-deterministic `false` return vs the Pascal 32-byte raw
contract; now covered by a 128-generation regression sweep
(`server/test/engine/shims/crypto-ciphers.test.ts`).

---

### 2. D1–D21 decision implementation status

Final sweep: every DESIGN.md decision is **implemented** unless marked
**deviated** (with reason). Source of truth: `DESIGN.md` §"Decisions"
table; per-binding details in `docs/COMPAT.md`.

| # | Decision | Status | Evidence |
|---|---|---|---|
| D1 | Corpus ground truth via FPC console harness (internettools + FLRE linked, desktop capture cross-check) | implemented | `corpus/harness/` (Makefile `harness`), fixtures for all seed families incl. MangaPlus protobuf + EHentai account modules |
| D2 | Anti-bot: stub default + known-broken flags; opt-in `browser` profile; global antibot serialization | implemented | `docker/compose.yml` `--profile browser` (digest-pinned FlareSolverr + healthcheck, `scripts/compose-check.sh` asserts); AntiBotInterceptor single-flight + cookie persistence (`server/test/engine/state/antibot*.test.ts`, real FMD2 bypass scripts integration-tested) |
| D3 | v1-broken sites acceptable, published via capability flags; ≥95% register target | implemented | **98.8% register rate** (412/417 files, 454 modules) with per-file isolation; flags in `/api/modules` + Settings badges (`server/src/engine/registry/capabilities.ts`) |
| D4 | Desktop data compatibility: one-shot import commands (modules.json, downloadedchapters.db, EncryptString migration) | implemented | favorites/modules import API (`server/src/api/routes.ts`, `schemas.ts`), account-store EncryptString-compat crypto (`server/src/accounts/account-store.ts`); `docs/evidence-config-switches.md` |
| D5 | Filename/path semantics: deliberate Windows-desktop parity + `--normalize-paths` opt-out | implemented | single `applyFileNamePolicy` choke point in `@fmd/contract`; byte-identical goldens with flag unset (`server/test/jobs/library/filenames.golden.test.ts`, 41 golden cases) |
| D6 | Wasmoon OOM policy: quarantine → rebuild → retry once → `engine_oom` | implemented | engine supervisor + `engine_oom` terminal job error (`server/src/engine/events/supervisor.test.ts`) |
| D7 | Catalog write policy: read-only ATTACH; FTS sidecar keyed by `db_sha`, double-buffered | implemented | catalog service (`server/src/catalog/`), FTS keyed by db SHA (`server/test/catalog/`) |
| D8 | Favorites: `uFavoritesManager.TFavoriteThread.DoCheck` parity (live GetInfo, set-difference, dual-write) | implemented | favorites engine + scheduler (`server/src/jobs/favorites/`, merge/filename goldens) |
| D9 | Upstream trust: pins bump via PR + module-diff report; CI smoke on candidate pin; auto-bump disabled | implemented | SHA-gated sync (`server/src/sync/modules/`), `module-diff.golden.test.ts`; bump = deployment act (runbook) |
| D10 | `SelectedLanguage` fixed 'en' (captions only) | implemented | `fmd.env` shim (`server/src/engine/shims/lua-require.ts:97`) |
| D11 | Dropped-units cost accounting: deferrals recorded with module counts | implemented | `docs/COMPAT.md` deferred rows carry cost + phase (uFavoritesManager → Phase-4, uDownloadsManager → Phase-3 — both since implemented; remaining deferrals are scope-outs, not silent drops) |
| D12 | Same-module concurrency: shared per-module state service, per-worker engines | implemented | shared-state service + SHA-gated `module_state` persistence (`server/src/engine/registry/`, `capabilities.ts`) |
| D13 | zstd: omit from `Accept-Encoding` by default (advertise only what we decode) | implemented | `Reset`/`ResetBasic`/`AcceptImage` header sets (`server/test/engine/shims/http-headers.test.ts`) |
| D14 | "Popular" → `/latest` (jdn DESC) + `/title`; no popularity data exists | implemented | API routes + OpenAPI snapshot test |
| D15 | `DoCheckMissing` out of v1; favorites-import covers transfer-favorite | **deviated → by design (scope-out)** | DESIGN.md §1 non-goals; transfer-favorite case ships via D4 import command |
| D16 | PDF/memory packing: streaming/append writers, disk-backed, 512 MB/job budget, retryable `pack` failure | implemented | `server/src/jobs/packers/` + library goldens |
| D17 | `pb` (lua-protobuf): protobufjs-backed preload shim, `load` = (ret, pos) | implemented | `server/src/engine/shims/pb-protoc.integration.test.ts` (real `utils/protoc.lua` + MangaPlus.proto end-to-end), `docs/evidence-pb-fidelity.md` |
| D18 | zstd add-on trigger: nightly smoke auto-detects undecoded bodies; ≥2 affected modules/week flips it on | implemented (as policy + harness) | smoke harness detects body/content-type mismatch (`server/tools/smoke/`); trigger procedure in `docs/runbook.md` |
| D19 | WS backfill bound: ring 1000 events/job, 15 min age; older → resync hint | implemented | `server/src/api/ws/` ring buffer (`ring-buffer.test.ts`), SPA backfill state machine (`web/test/ws-backfill.test.ts`) |
| D20 | First-run bootstrap: auto module+catalog sync on empty data dir; disable via env; explicit empty-state UI | implemented | runtime assembly bootstrap stages (`server/src/runtime/`), `FMD_BOOTSTRAP_DISABLE=1` short-circuit, bootstrap-watch e2e + banner tests |
| D21 | WS slow consumers: per-subscriber bounded queue, drop-oldest + contiguous `gap` marker | implemented | `server/src/api/ws/hub.ts` gap markers (`web/test/ws-contract-drift.test.ts`) |

**Summary: 20 implemented, 1 deviated (D15 — the designed v1 scope-out,
documented in DESIGN.md §1 non-goals; its user-facing replacement, the
favorites-import command (D4), is implemented).**

---

### 3. Known-broken modules (published in-app + here)

The D2/D3 known-broken set is surfaced at runtime: `GET /api/modules`
carries `known_broken_flags` per module, and the web Settings page
renders per-module capability badges. At release, **83 of 454 modules**
carry a known-broken flag, in 3 groups:

| Flag | Cause | Modules | Count |
|---|---|---|---|
| `madara.run_html_load` | Madara-template `run_html_load` flow requires browser-side execution the stub cannot perform | see list below | 76 |
| `fmd.subprocess` | module shells out to external programs (FMD2 parity would require a subprocess surface — D2 stub) | Comix, Raijin Scans, The Blank | 3 |
| `webdriver.bypass` | anti-bot bypass drives a real WebDriver | HDoujin Galleries, MangaDotNet, OniSaga, Schale Network | 4 |

`madara.run_html_load` (76): 3asq, AllPornComic, Apoll Comics, Aqua
Manga, Bokugen Translation, Borat Scans, BrainRotComics, CartoonPorn,
DoujinHentai, Dragon Tea, DragonTranslation, EmperorScan, Ero18x,
GDScans, Gourmet Scans, Hades Scans, Ichi the Witch, InfraFandub,
Inventario Oculto, KS Scans, KissMangaIN, KlikManga, KomikUp,
LHTranslation, Lector KNS, LectorManga, LeerManga, Lily Manga, MGKomik,
MadaraDex, Manga District, Manga18FX, Manga1st, MangaForFreeCom,
MangaForFreeNet, MangaGG, MangaLivre, MangaOwl, MangaRead, MangaSushi,
Manhastro, ManhuaPlus, Manhuaus, Manhwa Toon, Manhwa Toons, Manhwa18Cc,
Manhwa68, ManhwaClub, ManhwaHub, ManhwaTop, ManhwaZ, Milftoon, Mundo
Manhwa, Niji Translations, Porn Comic, Ragnarok Scanlation, S2Manga,
SleepyTranslations, SpiderScans, TaurusManga, TempleScanEsp, ToonGod,
Toonily, TopComicPorno, Traducciones Amistosas, UpKomik, WeAreHunger,
Webdex Scans, WebtoonXYZ, WuxiaWorld, Xmanhwa, YakshaComics, YakshaScans,
ZinManga, شبكة كونان العربية (detectiveconanar), مانجا ليك (Lekmanga).

Mitigations: the §5.11 `browser` profile (FlareSolverr sidecar,
`docker compose --profile browser up`) satisfies the bypass-family
flags for deployments that opt in; the madara flag remains
run-flow-bound (D2 documented limitation). Machine-readable source:
`server/test/engine/registry/registration-summary.json`
(`d3KnownBroken`).

Additionally, 5 of 417 lua files fail to register (per-file isolation,
**98.8%** register rate) — their errors are logged at sweep time and
gated by the ≥95% D3 target; they are not silently dropped (D11).

---

### 4. COMPAT.md summary

`docs/COMPAT.md` is the per-binding-unit tracker, **regenerated by the
corpus gate** (byte-stable; a stale artifact fails CI):

- Binding statuses use the gate vocabulary; **zero `unknown`** statuses
  at release (final-sweep assertion, this document §6).
- Corpus replay: **912/912 expressions pass (100%)** vs the FPC
  oracle across the seed modules (plain XPath, JSON-API, Madara,
  Duktape, imagepuzzle, bypass, MangaPlus protobuf/`pb`, account
  modules, fill-list collectors). Gate floor: ≥99% + zero undocumented
  mismatches.
- Documented behavioral divergences (v0 section): known FMD2 quirks
  reproduced rather than "fixed", each with the FMD2 source line —
  e.g. EHentai `.x` unknown-field read erroring identically via
  LuaClass `__index` semantics.
- Shims with full-surface notes: `fmd.crypto` (X25519/P-256/
  SecretStream/AES), HTTP (§5.4: cookies, redirects, SOCKS, per-host
  gates, egress policy), `fmd.gzip`, `fmd.pcre2`, `fmd.logger`, `pb`.

---

### 5. Compose hardening verification

Verified by the release gate's compose leg (`scripts/compose-check.sh`,
real `docker compose config` render + assertions) and the e2e evidence
artifacts; runbook procedures: `docs/runbook.md`.

| Hardening item | Implementation | Verification |
|---|---|---|
| Non-root | `USER node` (uid 1000) after setup; `/app/data` chowned; runtime entry runs as `node` | Dockerfile contract grep (compose-check) + e2e asserts `id -u != 0` inside the container (`non-root-id.txt` artifact; process twin asserts the server uid) |
| Digest-pinned base image | `library/node:22.14.0-bookworm-slim` (exact minor; CI swaps the resolved `@sha256:` digest — recorded + registry-freshness-checked) and `flaresolverr:v3.3.21@sha256:f104…` in the browser profile; e2e mock pinned by digest | `docs/docker-pinning.md` (digests + resolution dates); compose-check asserts the mock pin AND the flaresolverr pin; registry digest re-checked at gate time (fresh 2026-11-15) |
| Healthcheck | Dockerfile `HEALTHCHECK` against `/healthz` (liveness); compose e2e gates test startup on `/readyz` (readiness, D20-aware) | Dockerfile contract grep + `wait-on /readyz` step green in both e2e phases |
| SIGTERM drain drill | bounded drain ≤30 s (`stop_grace_period: 30s`): stop-accepting → queued-job flush logs → catalog close → engine dispose → **exit 0** | Drill executed per e2e run (both phases, 39 ms / 71 ms): millisecond-timed drain, all five flush log lines asserted, clean exit 0 recorded (`drain-ms.txt`, `app-exit.txt` artifacts) |
| Volume permission notes | named volume `app-data:/app/data`; the image pre-creates + chowns `/app/data` so the named volume inherits `node` ownership on first use; bind-mount deployments must `chown 1000:1000` the host dir (runbook "Volumes & permissions") | runbook procedure + Dockerfile `chown node:node /app/data` |

---

### 6. Final sweep checklist (recorded)

- [x] All D1–D21 decisions marked implemented / deviated-with-reason (§2)
- [x] `docs/COMPAT.md` binding statuses contain zero `unknown` (§4;
      vocabulary: implemented / partial-gap-documented / deferred)
- [x] Known-broken list published **in-app** (`/api/modules` capability
      flags + Settings badges) **and** in these release notes (§3)
- [x] Full CI gate exit 0, all suites incl. both e2e phases (1597 unit +
      integration tests; 912/912 corpus; Playwright bootstrap-watch,
      main, and all 3 phase-3 scenarios green ×2) — log committed as
      `docs/ci-gate-0.1.0.log` (§1); no red gate items
- [x] Compose hardening verified + recorded (§5)
- [x] Version 0.1.0 stamped: `package.json` (+ all 4 workspace
      packages), Dockerfile `LABEL org.opencontainers.image.version`,
      release image tag mechanism (`FMD_WEB_IMAGE_TAG`), `fmd.env`
      Lua `Version` surface, `CHANGELOG.md` entry (§1/§5)
- [x] Docs complete and current: README (quickstart, screenshots
      placeholder, REVIEW-001..004 + REVIEW-velvet-pulley-prosper
      referenced), `docs/runbook.md`, `docs/COMPAT.md` (gate-current),
      `DESIGN.md` revision log updated for this release
