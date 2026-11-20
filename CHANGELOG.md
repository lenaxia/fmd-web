# Changelog

All notable changes to fmd-web are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
semver (0.x = pre-1.0 development line).

## [0.3.2] — 2026-11-20

The "works for real" release: live-site downloads end-to-end, FMD2
import, library file truth, site availability, covers that render, and
a paste-URL front door — plus per-host pacing, one outbound webhook,
an Attention triage screen, an inbox home for new chapters, and one
BREAKING auth change.

- **BREAKING — token-only auth** (`52166e0`, fix-ups `be654a4`,
  `f1bf8d5`): the optional-password mode is removed; the single API
  token (0.3.1's *arr semantics) is the app's only credential. Front
  the app with a reverse proxy for user authentication; scripts use
  the token. Deployments relying on `FMD_WEB_PASSWORD` must move
  authentication to the edge.
- **Live sites work end-to-end** (`4836887`, `513ddfb`): real HTTPS
  egress for the module engine (the live path previously refused
  public hosts — every live info/search/download failed in every
  deployment), a fresh connection per request (CDN idle-timeout
  parity), Duktape `ExecJS` ToString marshaling, `BeforeDownloadImage`
  module headers for hotlink-protected CDNs, and enqueue URL
  canonicalization. Proven live: a FanFox chapter downloads through
  the real pipeline to a packed file in the library with the
  downloaded marker set.
- **One hung site no longer freezes the server** (`eab3f1f`,
  `0818ec2`): module dispatch moved off the main event loop onto a
  persistent engine worker thread — a silent origin used to stall the
  whole API (Downloads page, `/readyz`) for the full 15 s request
  budget per hop; the API now stays responsive while module HTTP runs
  to its budget on the worker, and a wedged worker is recycled.
- **Import from FMD2** (`d57f156` + the `ae5fb4d` review chain):
  bring a desktop install over — upload `db.sqlite` + `config.json`
  (or a zip of the data dir), preview what maps (favorites,
  downloaded chapters, accounts, settings), then apply. Credentials
  are opt-in and never echoed back; re-import is idempotent and
  merges case-insensitively; FMD2's encrypted stores are decrypted
  with the FMD2 key.
- **Library file truth** (`99c5edd`, `26318fa`): every chapter file
  carries a stat-verified state — downloaded / missing / orphan —
  with lazy re-verification (stale entries re-check on open or
  refresh), a manual Rescan that re-links files moved within the
  library root (conservative: ambiguity surfaces as an orphan+missing
  pair for the operator, never a guess), a per-title Files listing
  (metadata only — no file contents over HTTP), and All / Missing /
  Orphans filters on the Library page.
- **Flat library layout** (`c7ee640`): series folders sit directly
  under the library root — `<manga>/<file>` — with a `[module]`
  suffix only when two sites share a title; first writer keeps the
  clean name; one-time migration for existing trees.
- **Site availability** (`b8de66f`): dead sites (parked domains,
  Cloudflare 523, DNS gone) are identified as a byproduct of real
  traffic and surfaced in Settings→Websites (Last-check status,
  filters, per-row Check) and dimmed — but never gated — in the site
  picker. No batch probing (anti-bot risk; documented deferral with a
  revisit trigger).
- **Covers render** (`70d67da`): a same-origin, module-validated
  cover proxy (CSP unchanged) with an on-disk cache — the manga hero
  and favorites (which now store and show cover thumbnails) display
  real cover art instead of the No-cover fallback.
- **Favorites composite-id + PWA install fixes** (`77b8dc7`):
  toggling auto-download on an existing favorite no longer 404s behind
  URL-decoding proxies; the web manifest is served as
  `application/manifest+json` so PWA install works.
- **UX audit P1+P2 and the favorites rebuild** (`0c306a8`,
  `ac88d9a`, `ae4b1e1`, `f4b0ed8` and their review addenda):
  back-navigation context, honest metadata nulls, a jargon gate,
  library dates, Settings wayfinding; loading skeletons, mobile and
  a11y polish, downloads/library file management; the favorites page
  rebuilt title-primary with one kebab action column.
- **Paste-URL add — the universal front door** (`4635bfc`): paste any
  series URL into the always-present box on the search home (or the
  command palette) — it resolves to its module, previews title and
  cover, and follows with a single decision (Follow, or Follow +
  auto-download); an already-followed series says so instead of
  re-asking.
- **Search scope + preferred sites** (`62dcd4e`, touch-floor fix-up
  `121ed33`): the search home
  gains a three-way scope selector — all sites (answered from the
  local catalog index with zero network), Preferred (your starred
  sites, in your order), or an explicit multi-select; catalog-less
  scoped sites are scraped live with a capped, cancellable fan-out
  and results stream in progressively; repeated queries hit a short
  TTL cache. Star sites in the picker to build the allowlist — the
  state is persisted server-side and shared.
- **Komga/Kavita scan target** (`168787c`): packed chapters carry a
  `ComicInfo.xml` (metadata written into the archive for scanners —
  never parsed or displayed by the app), the chapter filename
  template is frozen to the numbering-first form, and a release gate
  bans guessing comic numbers from titles; the library is a clean
  scan target by construction.
- **Pipe health — pacing, retry backoff, missing-chapter check**
  (`83b7f0d`): favorites checks and download jobs against the same
  site are spaced by a per-host pacer (concurrent work never bursts
  one origin; different sites proceed in parallel); failed downloads
  retry on an exponential backoff with jitter, capped at 24 h — the
  retry state stays visible while the queue slot is freed for other
  work; and each favorite's menu gains "Check missing chapters", a
  report of chapters you have downloaded that the live site list no
  longer contains (FMD2's FCheckMissing parity; report-only — the
  downloaded ledger is never rewritten).
- **Single outbound webhook** (`98915be`, gate remediation `e6415a8`):
  the pipe's push half — ONE generic JSON POST destination (url +
  optional secret + per-event-class toggles, verified with a
  test-send action). Event classes: `chapter.downloaded` (per
  finalized chapter), `favorites.digest` (one summary per completed
  check sweep), and `failure.digest` (per-site check failures
  coalesced into 15-minute windows — a dead site with 50 favorites
  produces ONE entry, never 50). With a secret, every attempt carries
  an `X-FMD-Signature` HMAC-SHA256 header; delivery is fire-and-forget
  with 2 retries then drop — advisory, the inbox stays the source of
  truth. Bridge to chat/push services yourself; a grep gate keeps
  per-channel adapter code out of the tree.
- **Triage surface: one Attention screen** (`1679ca6`): failed
  downloads grouped by cause — site down (the availability record
  join), anti-bot, rate limited, other — never per-chapter noise, each
  group with a paced Retry all that funnels through the same per-job
  retry path the downloads tab uses (per-host pacing applies to
  retries exactly as to fresh work). Availability dims and explains
  but never gates an action; a healthy state celebrates doing nothing.
  Reachable from primary nav on desktop and mobile (`GET /api/triage`,
  `POST /api/triage/retry`; failed rows carry a typed `failureKind`).
- **Inbox home: the new-chapters feed** (`22b4192`, remediation
  `790eebf`): Home becomes a reverse-chronological feed of what
  arrived — one row per detected new chapter with per-chapter seen
  state, one shared caught-up action, and a rolling 30-day archive.
  Seen state is server-side (single-user instance): caught up once,
  caught up everywhere. `#/browse` keeps every existing deep link
  working (`GET /api/inbox`, `POST /api/inbox/ack`,
  `POST /api/inbox/caught-up`).
- **Diagnosability and ops** (`6beb4d5`, `b83db04`, `a7635ef`,
  `359c20a`): `net_problem` errors now name the upstream cause (a
  timeout, a parked domain's 405) instead of failing silently; the
  global proxy editor is an inline-expand box in Settings→Websites; a
  weekly site-liveness workflow downloads one chapter per site and
  flags three-warn sites; the post-0.3.2 product direction is
  recorded in `docs/DESIGN-NORTHSTAR.md`.

Version string: like 0.2.0/0.3.0/0.3.1, the workspace `package.json`
version stays at `0.1.0` — release identity lives in the annotated git
tag and the GitHub release.

[0.3.2]: docs/RELEASE-NOTES.md

## [0.3.1] — 2026-11-18

Hotfix plus websites-registry polish on top of 0.3.0. Two stories:

- **v0.3.1 hotfix** (`7442b5f`): all-sites union search no longer 500s
  when an upstream module ships a typo'd catalog id — offending modules
  are gracefully excluded from the union; `/api/info` accepts
  host-relative catalog links, joining them against the module
  `RootURL` (FMD2 `MaybeFillHost` parity) — fixes series pages failing
  to load when reached from search/catalog; the API token is fully
  decoupled from password auth with *arr semantics — auto-generated on
  first boot, rotates whenever auth is switched off, credential gate
  keys on the password only, websocket open when password auth is off,
  making reverse-proxy (authelia/authentik) deployments first-class;
  Settings→API always renders; Accounts lists enabled sites only; a
  real-server/real-client contract test covers `/api/info` (closing
  the mocked-e2e drift seam); runbook §API-token and `docs/API.md`
  updated.
- **Settings→Websites rebuild** (`ee88e78`): faceted module registry —
  language chips (with `-Scanlation` collapsed), H-status, and
  needs-setup / AccountSupport filters with live counts; global
  enable-all/disable-all scoped to the active filter; proxy editor
  collapsed into a drawer; language distribution visible at a glance;
  union-spec race fix.

Version string: like 0.2.0/0.3.0, the workspace `package.json` version
stays at `0.1.0` — release identity lives in the annotated git tag and
the GitHub release. Releases 0.2.0 and 0.3.0 are documented in their
GitHub release notes and annotated tags.

[0.3.1]: docs/RELEASE-NOTES.md

## [0.1.0] — 2026-11-15

First release: a Dockerized web rebuild of FMD2 that runs FMD2's Lua
site-module ecosystem and FMD2-DB catalogs unchanged (DESIGN.md v5).

Highlights:

- **Module engine**: Lua 5.4 via wasmoon, one engine per worker thread;
  417-file FMD2 `lua/` tree sweeps at a **98.8% register rate** (454
  modules) with per-file error isolation and SHA-gated module-state
  persistence.
- **Corpus parity**: 912/912 (100%) seed-corpus replay pass rate vs the
  FPC ground-truth oracle; the gate floor is ≥99% with zero
  undocumented mismatches (`docs/COMPAT.md` is gate-regenerated and
  byte-stable).
- **Shims**: full §5.4 HTTP surface (cookies, SOCKS, compression,
  rate limits), TXQuery §5.6 (incl. fill-a-list overloads + chained
  member steps), crypto (libsodium X25519/SecretStream + node P-256 +
  AES suite), Duktape `ExecJS` with jailed CommonJS loader, protobuf
  `pb` shim (MangaPlus), PCRE2, gzip, imagepuzzle, protoc.
- **Web app**: React SPA (Browse/Latest/Search, Manga detail with live
  info, Downloads with WS progress, Favorites, Settings incl. proxies,
  bootstrap banner and per-module capability badges) served by the
  Fastify API server; OpenAPI snapshot-drift gated.
- **Download pipeline**: lane-limited job engine (SQLite-backed queue),
  per-site limiters, chapter pipeline → streaming packers (ZIP/CBZ,
  D16 disk-backed 512 MB/job budget), library with FMD2-faithful
  filename semantics (D5 Windows-desktop parity + `FMD_NORMALIZE_PATHS`
  opt-out), downloaded-chapters dedupe parity.
- **Ops**: non-root container, digest-pinned base images
  (`docs/docker-pinning.md`), `/healthz` + `/readyz` healthcheck,
  SIGTERM bounded drain (≤30 s, flush-logged, exit 0), D20 first-run
  bootstrap (auto module+catalog sync, `FMD_BOOTSTRAP_DISABLE=1` opt
  out), §5.11 opt-in browser sidecar profile (FlareSolverr),
  WS backfill ring (D19) + slow-consumer gap markers (D21).

Quality gates at release:

- `scripts/ci.sh` full gate green: contract:check → lint → typecheck →
  test (1597 unit+integration) → corpus 100% → e2e phase-2 → e2e
  phase-3 (recorded: `docs/ci-gate-0.1.0.log`,
  summary: `docs/RELEASE-NOTES.md`).
- Known-broken set published in-app (`/api/modules` capability flags +
  Settings badges) and in the release notes (83 modules across 3 flag
  groups).

Details, decision-by-decision implementation status (D1–D21), and the
full known-broken list: `docs/RELEASE-NOTES.md`.

[0.1.0]: docs/RELEASE-NOTES.md
