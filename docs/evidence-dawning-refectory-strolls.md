# Evidence — tsk-dawning-refectory-strolls (FMD2-DB catalog sync: commits-API check, ETag budget, 7z atomic extract, read-only attach, FTS sidecar)

## Delivered

`server/src/sync/db/` — the DESIGN.md §6 catalog pipeline (write side
`CatalogSync` + read side `CatalogFileStore`), with the boundary
interfaces `CatalogSyncService` + `CatalogStore` (+ `CatalogEntry`,
`CatalogPage`, `CatalogBrowseQuery`, `CatalogSearchQuery`,
`CatalogMeta`, `CatalogUpdateCheck`, `CatalogSyncResult`) added to
`contract/types.ts`. FMD2 parity anchors: `GitHubRepoV3.pas` (work file
+ 1-call update check), `DBUpdater.pas` (7z fetch→extract→open),
`DBDataProcess.pas:137-153` (catalog schema), `uBaseUnit.pas:2740-2765`
(JDN helpers).

- **`jdn.ts`** — §6.7 shared JDN helper: exact `DateToJDN`/`JDNToDate`
  parity (a/y/m Gregorian algorithm), ISO date conversions. Anchored on
  externally known values: Pascal epoch 1899-12-30 → 2415019, J2000
  2000-01-01 → 2451545, Unix epoch 1970-01-01 → 2440588, leap-year
  matrix (1900 not leap, 1904/2000/2024 leap, 2100 not leap).
- **`rate-budget.ts`** — §6.1 token bucket: 10 req/s sustained, burst
  50, continuous lazy refill, FIFO-gated `acquire` over an injectable
  `SyncClock` (`systemClock` or the deterministic `FakeClock` whose
  `advance()` resolves timers in deadline order and drains their
  continuations).
- **`http-client.ts`** — budgeted transport: every request passes the
  bucket; commits-API JSON GET supports conditional If-None-Match (304
  → no body, GitHubRepoV3 `last_commit_etag` parity); blob GET is
  conditional (ETag → 304 skip); 403/429 map to typed
  `RateLimitedError` (stable message prefix) so the batch stops
  cleanly and stays resumable; error text is query-stripped (no token
  leakage).
- **`batch-state.ts`** — resumable batch state (§6.1): repo pin +
  `lastCommitSha`/`lastCommitEtag`, per-catalog blob ETags, and the
  still-to-fetch `pending` set; every mutation persists atomically
  (temp + rename), corrupt state self-heals to a fresh batch.
- **`extract.ts`** — §6.3 extraction: spawns the docker-shipped 7z
  binary (`x -y -aoa -o<tempdir>`), resolution order
  `FMD_CATALOG_7ZZ` → `7zz` → `7za` on PATH → the 7zip-bin binary
  shipped in the image (Dockerfile smoke check added). Exit code +
  stderr surfaced; SIGKILL watchdog at 120 s.
- **`sync-service.ts`** — the §6.1–§6.3 pipeline:
  - `checkForUpdates()`: EXACTLY ONE commits-API call
    (`commits?sha=<ref>&per_page=1`); a moved pin defines the changed
    set (pending carry-over ∪ module-registry hook `knownCatalogIds`);
    the pinned commits-API ETag makes repeat checks 304s.
  - `syncCatalog(id)`: conditional GET of `<dbUrl>/7z/<ID>.7z` under
    the budget → 304 = `unchanged` (drops from pending, keeps ETag);
    200 → write tmp archive → extract into a FRESH temp dir → locate
    the single `.db` → sha256 → fsync → **atomic rename** into
    `data/catalogs/<ID>.db` (never in-place) → install receipt
    (`<ID>.meta.json`, §9 catalog_meta until app.db lands).
  - `syncChanged(ids?)`: drains caller ids ∪ persisted pending; every
    success drops the id from pending immediately (crash window = one
    catalog); rate limit stops the batch with pending intact.
  - `onBeforeInstall` fault-injection hook fires between extract and
    rename (the §6.3 crash window under test).
- **`catalog-store.ts`** — the §6.4–§6.6 read side:
  - **Read policy**: every catalog connection opens with
    SQLITE_OPEN_READONLY (`readonly: true, fileMustExist: true` —
    better-sqlite3's `mode=ro` mechanism: the flag passes straight to
    `sqlite3_open_v2`, so a read connection physically cannot write
    the db, create a rollback journal, or create the file). Cached
    handles are keyed by file identity (size + mtime) so a replaced
    catalog reopens for new readers while old handles stay valid
    (rename semantics).
  - **FTS5 sidecar** (§6.5): `data/fts/<ID>.db` keyed by `db_sha` in a
    `meta` table; external-content FTS5 (`search_index` over `entry`,
    porter+unicode61 tokenizer) built through a separate strictly
    read-only catalog connection. Replacement is double-buffered:
    complete build at a temp path → atomic rename over the active
    sidecar; readers holding the previous buffer finish
    deterministically. `db_sha` mismatch (new install, out-of-band
    swap, `invalidate`) triggers the rebuild on next use.
  - **Browse** (§6.6): `latest` = `ORDER BY jdn DESC` (+ NOCASE title,
    link tiebreaks for deterministic pages), `title` = `ORDER BY title
    COLLATE NOCASE`; bounded `limit` (default 20, max 200), offset
    pages + opaque offset cursors, `total` carried.
  - **Search**: FTS5 MATCH with cursor pagination — cursors are
    query-bound (replay against another query/genre is rejected, never
    silently re-paged); `ORDER BY rank, rowid` determinism; raw user
    query sanitized into quoted phrases (trailing `*` = prefix query);
    exact-`status` filter + `genres` column filter.

## Tests (49 new; `server/test/sync/db/`, all offline §13)

- `jdn.test.ts` (5) — the §6.7 acceptance set: anchored boundary
  fixtures (epoch, J2000, Unix epoch), leap matrix, 800-day
  monotonic walk across the 1899→1900 boundary, JDNToDate round-trips,
  malformed-ISO rejection.
- `rate-budget.test.ts` (11) — the §6.1 acceptance set with the FAKE
  CLOCK: full burst passes at t=0, 51st request waits exactly 100 ms,
  refill 10 tokens/s capped at burst 50, cost-25 acquire waits 2.5 s,
  strict FIFO gate order, tryTake fast path, invalid config/cost
  rejection; SyncHttpClient ETag→If-None-Match → 304 (no body), typed
  403 rate-limit error, 500 surfacing.
- `batch-state.test.ts` (4) — resumable batch acceptance: pending
  persisted after the check, rate-limited batch STOPS with pending
  intact, a FRESH service instance over the same state file resumes
  and completes exactly the remaining ids, per-item pending drops +
  ETag persistence, corrupt-state self-heal, atomic-write discipline
  (no temp leftovers), and the moved-pin + all-304 wave (`unchanged` ×
  3, zero bodies re-served).
- `catalog-store.test.ts` (16) — **read-only invariant acceptance**: a
  browsing + search workload (incl. fresh sidecar builds and post-close
  reopens) leaves ZERO `-journal`/`-wal`/`-shm` files in
  `data/catalogs/` and the catalog db byte-identical (sha256 before ==
  after); read connections refuse writes and refuse creating missing
  files; receipt self-heal; 32-hex id path safety; latest/title
  ordering + pagination determinism; FTS MATCH (AND phrases, prefix
  `*`), rank+rowid deterministic cursor walk, cursor/query mismatch
  rejection, status/genre filters, empty-query guard, query
  sanitization.
- `fts-replace-under-read.test.ts` (4) — **double-buffer acceptance**:
  an external reader holding the OLD sidecar across a db_sha-changing
  replacement finishes with exactly the old (deterministic) results
  while new searches see the new buffer; same-db_sha reuse does not
  touch the sidecar file (inode stable); out-of-band catalog swap
  invalidates by db_sha; on-demand build.
- `atomic-install.test.ts` (3) — **atomic-extract acceptance**: (1) an
  in-process throw in the between-extract-and-rename window leaves
  `data/catalogs/` empty, cleans tmp, keeps the id pending; (2) a
  failed UPDATE never damages the previous catalog (byte-identical,
  reads stay on v1); (3) a REAL SIGKILL in a child process mid-window
  (esbuild-bundled pipeline, no cleanup runs) proves no partial
  catalog is visible while the extracted temp dir still holds the
  killed attempt's db — then a fresh service over the same data dir
  completes the install and the FTS search works.
- `sync-integration.test.ts` (6) — full §6 flow over a LOCAL mock of
  api.github.com + raw.githubusercontent.com (loopback-only,
  request-log asserting): 1 commits call for the check (zero blob
  traffic), fetch+extract+install via the real 7za binary, unchanged
  pin → zero fetches, moved pin → conditional GETs all 304
  (`unchanged`, zero bodies), rotated blob → `updated` + FTS sidecar
  rebuilt by db_sha (new content searchable, old gone) while the other
  catalog stays `unchanged`, rate-limited batch stops at the FIRST
  failure and a retry completes, and the no-sidecar invariant holds
  over the whole sync workload.

## Verification

- `npx vitest run server/test/sync/db/` — **49/49 green**.
- `npm test` — **775/775 green** across 68 files (full workspace,
  no-network guard active; mock server is loopback-only).
- `npm run typecheck` — clean (strict + exactOptionalPropertyTypes).
- `npm run lint` — clean.
- `npm run contract:check` — drift-check OK (0 mismatches).
- `npm run test:coverage` — thresholds hold (sync/db aggregate:
  89.96% lines / 92.3% functions).
- `npx tsx corpus/scripts/generate-compat.ts --gate` — 912/912 = 100%,
  COMPAT.md byte-stable.
- Dependencies added (exact-pinned): `better-sqlite3@12.4.1` (DESIGN
  §3 datastore; bundles FTS5, SQLite 3.50.4), `7zip-bin@5.2.0` (the
  docker-shipped extractor binary), `@types/better-sqlite3` (dev).
  Dockerfile: runtime smoke check for the extractor binary + updated
  §6.3 comment (no apt layer needed).

## FMD2 parity notes (deliberate deltas)

- Update check is ONE commits-API call (DESIGN §6.1) — FMD2's
  `GetTree` second call is replaced by per-file conditional GETs
  (ETag 304s) over the module-registry id universe; per-file change
  detection rides the same ETag round-trip that would otherwise
  download.
- `7zz` vs `7za`: the extractor binary is configurable; the default
  resolution accepts any 7z-compatible CLI (7zz preferred, 7za
  fallback, 7zip-bin shipped binary last). Extraction semantics match
  `DBUpdater.pas` (`x -y -aoa -o`).
- The install receipt (`data/catalogs/<ID>.meta.json`) stands in for
  §9's `catalog_meta` row until the app.db story lands; it is
  self-healing (a db without a receipt recomputes db_sha from the
  file).
