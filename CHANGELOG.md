# Changelog

All notable changes to fmd-web are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
semver (0.x = pre-1.0 development line).

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
