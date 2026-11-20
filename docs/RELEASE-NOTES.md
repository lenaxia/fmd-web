# Release notes — fmd-web

## 0.3.2 — 2026-11-20

**Released:** 2026-11-20 · **Tag:** `v0.3.2` (annotated) · **Commits:**
`4836887` (live HTTPS egress, range base) → `62dcd4e` (search scope +
preferred sites) → `121ed33` (picker-star touch floor) → `83b7f0d`
(pipe health) → `1324e65` (visual-baseline close-out) → `98915be` (single webhook) → `1679ca6` (triage surface) → `22b4192`
(inbox home) → `790eebf` (inbox remediation) → `cbd8028` (e2e
phase-3 spec alignment — release-charter amendment 2) → `8cf8f8c`
(inbox-shell e2e remediation: visual baselines + a11y cycle + arrival
retarget — feature head) → the release-notes commit (release head);
46 commits over 0.3.1 (45 feature + the release-notes commit)

The "works for real" release. Where 0.3.1 fixed the registry and the
auth token, 0.3.2 makes the app actually work against live sites —
downloads end-to-end, a server that stays responsive when a site
hangs, real cover art — and adds the migration path from a desktop
FMD2 install, library file truth, dead-site visibility, and a
paste-URL front door. The pipe-with-an-inbox lanes land too: per-host
pacing, a single outbound webhook, an Attention triage screen, and an
inbox home for new chapters. One BREAKING change: password auth is
removed.

### BREAKING — token-only authentication (`52166e0`, `be654a4`, `f1bf8d5`)

The optional-password mode is removed. The single API token (0.3.1's
*arr semantics: generated on first boot, rotatable in Settings) is
now the app's **only** credential. User authentication belongs at the
edge — front the app with a reverse proxy (authelia / authentik /
PocketID) as the README's auth note describes. Deployments that set
`FMD_WEB_PASSWORD` must move authentication to the proxy; scripts and
automation use the token.

### Live sites work end-to-end (`4836887`, `513ddfb`, `0818ec2`, `eab3f1f`)

- **Real HTTPS egress.** The live module engine previously hard-refused
  https and non-loopback hosts — every live GetInfo, search, and
  download failed in every deployment while the offline suite stayed
  green. The transport now performs TLS-verified https with SNI
  directly and through HTTP-CONNECT and SOCKS tunnels.
- **The download pipeline works on real sites.** A fresh connection
  per request (CDN idle-timeout parity), Duktape `ExecJS` results
  marshaled exactly as FMD2's `duk_safe_to_string` renders them,
  `BeforeDownloadImage` module headers reaching hotlink-checking CDNs
  (the FanFox Referer), protocol-relative image URLs massaged, and
  enqueue canonicalizing the manga URL so the downloaded-chapters
  ledger matches `/api/info`. Proven live: FanFox chapter → packed
  file in the library, marker set.
- **One hung site no longer freezes the server.** Module dispatch ran
  on the main event loop, so a silent origin stalled the whole API —
  the Downloads page, even `/readyz` — for the full 15 s request
  budget per hop, with no download running at all. The engine
  substrate now lives on a persistent worker thread (the designed
  §5.12 topology): the API stays responsive, worker ops run to their
  budgets, a wedged worker is recycled. A follow-up fixed chapter
  hooks that take no task snapshot (FanFox's image path).

### Import from FMD2 (`d57f156`, review chain `ae5fb4d`–`3c6a8cf`)

Bring a desktop install over: upload `db.sqlite` + `config.json` (or
a zip of the whole data dir), preview exactly what maps — favorites,
downloaded chapters, accounts, settings — then apply. Unmapped sites
are listed, credentials are opt-in and never echoed back, re-import
is idempotent and merges case-insensitively, and FMD2's encrypted
stores are decrypted with the FMD2 key. Documented in the USER-GUIDE
("Bringing over a desktop install") with the not-imported list.

### Library file truth and the flat layout (`99c5edd`, `c7ee640`, `26318fa`)

- Every chapter file carries a stat-verified state — **downloaded**
  (ledger row and file present), **missing** (row, file gone),
  **orphan** (file, no row) — re-verified lazily when stale, with the
  verification age visible in the UI.
- **Rescan library** walks the downloads root and re-links files that
  moved within it (exact filename, or the app's own naming slot);
  ambiguous matches deliberately surface as an orphan+missing pair
  for the operator to resolve — never a guess. The diff report
  (re-linked with former paths, missing, orphans, counts) persists.
- A per-title **Files** section lists chapter, filename, size, date,
  state, and copy-path — metadata only; no endpoint serves file
  bytes, and every path is realpath-clamped to the library root.
  The Library page gains All / Missing / Orphans filter chips.
- Series folders are now flat — `<libraryRoot>/<manga>/<file>` — with
  a `[module]` suffix only on duplicate titles (first writer keeps
  the clean name); existing trees migrate once on boot.

### Site availability (`b8de66f`)

Dead sites (parked domains, Cloudflare 523, DNS gone) are identified
as a byproduct of normal traffic through one conservative
classification seam: transport-class failures and 5xx/523 write
`unreachable` with a reason; successful answers write `reachable`;
4xx (anti-bot) writes nothing. Settings→Websites shows a Last-check
status column with All / Reachable / Unreachable / Unknown filters
and a manual per-row Check; the site picker dims unreachable rows
while keeping them fully clickable, with a client-local
Hide-unavailable toggle. Batch probing is deliberately not built
(anti-bot risk) — documented deferral with a revisit trigger.

### Covers render — same-origin cover proxy (`70d67da`)

Module cover URLs are absolute CDN links a browser behind the strict
CSP can never load. A same-origin, module-validated `/api/cover`
proxy now fetches them with the module's own HTTP posture (Referer,
UA fallbacks), caches them on disk keyed by the token-free URL, and
serves them with CSP unchanged. The manga hero and the favorites grid
(which now stores and shows cover thumbnails) display real art; the
preview tunnel's manifest 401 is also mitigated.

### Favorites composite-id + PWA install fixes (`77b8dc7`)

Toggling auto-download on an existing favorite 404'd behind proxies
that decode `%2F` — both the encoded and decoded id shapes now
resolve. The web manifest is served as `application/manifest+json`
(browsers refused to parse `application/octet-stream`), so PWA
install works; a contract test pins the static/auth gate ordering.

### UX audit P1+P2 and the favorites rebuild

Back-navigation context restored after in-app navigation, honest
metadata nulls (no more "null" in the manga header), a jargon gate on
error copy, real library dates, Settings wayfinding; loading
skeletons and consistent chrome, mobile and a11y polish,
downloads/library file management, and the em-dash sweep. The
favorites page is rebuilt title-primary with one kebab action
column. (`0c306a8`, `343e95c`, `ae5fb4d`, `8684f2a`, `70762d7`,
`3c6a8cf`, `ac88d9a`, `ae4b1e1`, `f4b0ed8`)

### Paste-URL add — the universal front door (`4635bfc`)

Paste any series URL into the always-present box on the search home
(or use the command palette's "Add manga by URL"): it resolves to its
module, previews title / cover / alt titles, and follows with a
single decision — Follow, or Follow + auto-download. An
already-followed series shows "Already in your Favorites" instead of
re-asking; a racing conflict lands as the same friendly state.

### Search scope + preferred sites (`62dcd4e`, touch-floor fix-up `121ed33`)

- The search home's scope selector: **all sites** (answered entirely
  from the local FMD2-DB catalog index — zero network), **Preferred**
  (your starred sites, in your order), or an explicit multi-select.
  The scope lives on the URL (`?scope=`, `?picks=`) and survives
  back/forward navigation.
- Catalog-less sites under an explicit scope are scraped live with a
  concurrency-capped, cancellable fan-out (never a synchronized
  all-sites blast); per-site results stream in progressively and
  abort when you navigate or retype. Repeated queries hit a short TTL
  cache; a preferred-sites change invalidates it immediately.
- Star sites in the site picker to build the one global allowlist —
  persisted server-side (shared across devices), rendered as a pinned
  Preferred group in canonical order, with dead sites dimmed but
  never hidden. The star meets the 44px touch-target floor
  (`121ed33`, the release-gate audit's catch).

### Pipe health — pacing, retry backoff, missing-chapter check (`83b7f0d`)

- Favorites checks and download jobs that target the same site are
  spaced by a per-host pacer (a conservative fixed cadence), so a
  sweep over many favorites — or concurrent downloads — never arrives
  at one origin as a burst; different sites proceed fully in
  parallel.
- Failed downloads retry on an exponential backoff with jitter,
  capped at 24 h: the retry state stays visible for the whole wait,
  the queue slot is freed meanwhile so other work proceeds, and a
  cohort of failed jobs on one host cannot re-align into a burst.
- Each favorite's row menu gains **Check missing chapters** — the
  reverse of the new-chapter diff: a paced live check that reports
  which chapters you have downloaded but the site's current list no
  longer contains (FMD2's FCheckMissing). Report-only by
  construction — the downloaded ledger is never rewritten, and the
  report dialog offers no destructive action.

### Single outbound webhook (`98915be`, gate remediation `e6415a8`)

The pipe's push half: ONE generic JSON POST destination — configure
the url, an optional secret, and per-event-class toggles in Settings,
then verify with the test-send action. Event classes:
`chapter.downloaded` (individual, per finalized chapter),
`favorites.digest` (one summary per completed check sweep), and
`failure.digest` (per-site check failures coalesced into 15-minute
windows — a dead site with 50 favorites produces ONE entry, never 50).
With a secret, every attempt carries an `X-FMD-Signature`
HMAC-SHA256 header. Delivery is fire-and-forget with 2 retries then
drop — advisory and lossy-tolerated, the inbox remains the source of
truth. Bridge to chat/push services yourself; a grep gate keeps
per-channel adapter code out of the tree.

### Triage surface — one Attention screen (`1679ca6`)

Failed downloads grouped by cause, never per-chapter noise: four
groups in a fixed order — site down (joined onto the availability
record the pipe already observed, cross-linked into the Settings
registry), anti-bot / bypass-unavailable, rate limited, and other.
Each group carries a paced **Retry all** that funnels every row
through the same per-job retry path the downloads tab uses, so
per-host pacing applies to retries exactly as to fresh work.
Availability never gates an action: a dead site dims its rows and
explains itself while every retry stays clickable. A healthy state is
an explicit empty state that celebrates doing nothing. Reachable from
primary nav on desktop and mobile (the `Attention` tab).

### Inbox home — the new-chapters feed (`22b4192`, remediation `790eebf`)

Home becomes what the product identity says it must be: a
reverse-chronological feed of what arrived. One row per detected new
chapter (cover thumbnail, title, chapter label, site, arrival time)
with per-chapter seen state, one shared **Caught up** bulk action, and
an archive of acknowledged entries for a rolling 30 days. Seen state
is server-side — a single-user instance, so caught up once means
caught up everywhere; marking read on one device never replays on
another. Detection derives from the one check-engine path
(scheduler sweeps, manual check-now, batch checks); the feed
celebrates being caught up, `#/browse` keeps every existing deep link
working, and webhook notifications complement but never gate it.

### Diagnosability and ops

- `net_problem` failures now carry the upstream cause in the error —
  "(HTTP 500: timeout)" for a slow origin, "(HTTP 405: Method Not
  Allowed)" for a parked domain — instead of failing silently
  (`6beb4d5`).
- The global proxy editor is an inline-expand box in
  Settings→Websites — no more bottom drawer (`b83db04`).
- A weekly site-liveness workflow picks a random series per enabled
  site, downloads one chapter through the real pipeline, and flags
  sites that warn three weeks running (`a7635ef`).
- The post-0.3.2 product direction — "a pipe with an inbox" — is
  recorded as a decision record in `docs/DESIGN-NORTHSTAR.md`
  (`359c20a`).

### Version string

Matching 0.2.0/0.3.0/0.3.1 precedent, the workspace `package.json`
version remains `0.1.0`; release identity lives in the annotated git
tag and the GitHub release.

---

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
