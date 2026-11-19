# Changelog

All notable changes to fmd-web are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
semver (0.x = pre-1.0 development line).

## [Unreleased]

- **Outbound webhook notifications — ONE, generic, zero adapters**
  ([azure-moonlight-plumbs]): the pipe's push half lands per D1 §3
  ("at most one webhook, zero channel adapters"). Configure one JSON
  POST destination (`PUT /api/settings/webhook`: url + optional
  secret + per-event-class toggles; `''` = off) and verify it with
  the test-send action (`POST /api/settings/webhook/test` — one
  awaited delivery with an honest report). Event classes:
  `chapter.downloaded` (individual, per finalized chapter),
  `favorites.digest` (one summary per completed check sweep) and
  `failure.digest` (per-site coalesced check failures — a dead site
  with 50 favorites produces ONE entry per 15-minute window, never
  50). With a secret, every attempt carries
  `X-FMD-Signature: sha256=<hex>` (HMAC-SHA256 over the exact body).
  Delivery is fire-and-forget with 2 retries then drop (logged);
  advisory and lossy-tolerated — the inbox remains the source of
  truth. Bridging to chat/push services is the receiving operator's
  business; a grep gate keeps per-channel adapter code out of the
  tree.

- **Triage surface: one Attention screen** ([granite-crown-orders]):
  the D1 §2 TRIAGE answer to "what needs me" — failed downloads
  GROUPED BY CAUSE, never per-chapter noise. Four groups (fixed
  order, stable shape): site down (the [site-availability] record
  join — exactly "the pipe already observed origin trouble";
  cross-links into the Settings registry availability column),
  anti-bot / bypass-unavailable (failure-text vocabulary — HTTP 4xx
  writes no availability verdict), rate limited (HTTP 429; wire
  token `throttled` — the quoted `'rate_limited'` string is banned
  by the auth-removal grep gate), and other (pack/engine faults,
  worker stalls, unclassified net). Each group carries a paced
  Retry all that funnels every row through the SAME per-job retry
  path the downloads tab uses, so per-host pacing applies to
  retries exactly as to fresh work (same-host retries space at
  least the pacing interval apart — never a burst; pinned by test
  over the real download lane). Availability NEVER gates an action:
  a dead site dims its rows and explains itself while every retry
  stays clickable. Failed rows superseded by a live retry-chain
  successor drop out of the surface (back in the pipe). Healthy
  state is an explicit empty state that celebrates doing nothing.
  Reachable from primary nav on desktop AND mobile (the `Attention`
  tab). `GET /api/triage` + `POST /api/triage/retry`; failed job
  rows now carry the typed §4/§7.3 `failureKind` on the wire
  (additive); OpenAPI snapshot + web client types regenerated.

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
