# Evidence — [pipe-health] per-host pacing, retry backoff, missing-chapter check (tsk-outland-henna-masks)

Story: one shared per-host token-bucket pacer over the favorites
scheduler AND the download lane (D1 §2 PIPE), exponential+jitter retry
backoff with a 24 h cap for failed downloads (§2 TRIAGE: pacing
applies to retries exactly as to fresh work), and the manual
missing-chapter check (FMD2 `uFavoritesManager.FCheckMissing` parity,
web-adapted per D1 §6 — report-only, surfaced per favorite).

## What landed

### 1. Per-host token-bucket pacer (`server/src/jobs/host-pacing.ts`)

- `ModuleHostPacer`: one bucket per RootURL HOST (module → host via
  `rootHost` exported from `api/cover-proxy.ts` — the SAME
  RootURL-reading knowledge, one source of truth for "which origin
  does this module speak to"). Continuous-refill token bucket,
  capacity 1 / interval 3 s (conservative fixed v1 defaults, NO user
  knobs; seams exist for tests), FIFO waiters, bucket starts full (a
  quiet host answers its first request immediately).
- Unknown modules and unparseable RootURLs are never gated (§3
  "hints never block" posture applied to the limiter itself — registry
  lag cannot stall the pipe).
- Consulted by BOTH consumers over ONE shared instance built in
  `runtime/assembly.ts`:
  - favorites engine (`jobs/favorites/engine.ts`): `pacer.acquire`
    before EVERY live GetInfo — scheduler sweeps, manual check-now,
    batch checks, transfer re-ingest, and the missing-chapter check;
  - download lane (`runtime/download-lane.ts`): `pacer.acquire` after
    the claim race, before the job's first module hop (ahead of any
    engine state; image-level cadence stays the runner's own
    §7.1 business).
- Modules sharing a RootURL host share one bucket (origin-keyed,
  scheme/path irrelevant).

### 2. Retry backoff for failed downloads (`server/src/jobs/queue/backoff.ts`)

- Curve `min(capMs, baseMs * factor^(attempts-1))` with
  multiplicative-only jitter `* (1 + share·u)`, u ∈ [0,1), re-clamped
  to the cap: base 5 s, factor 2, jitter share 0.5, cap **24 h**.
  Jitter never shrinks the base spacing — a cohort of failed jobs on
  one host cannot re-align into a burst.
- Persistence: additive `next_attempt_at` column on `job` (guarded
  ALTER for pre-existing deployments); a `retry` row with a future
  stamp is invisible to the claim transaction until the stamp elapses.
- Lane behavior change: the retry DWELL (slot held 1 s) is GONE — a
  retry outcome stamps `now + backoff(attempts)` and frees the slot
  immediately; the row stays observable in `retry` state the whole
  backoff long while OTHER work proceeds. Attempt exhaustion (default
  cap 3) lands in the EXISTING `failed` terminal state with the typed
  failure kind (the future triage surface reads the same rows).

### 3. Missing-chapter check (`missingChapters` + `checkMissing`)

- Reverse link-diff (`jobs/favorites/diff.ts`): stored-downloaded
  links the LIVE site list no longer contains — the exact
  set-complement of the forward new-chapter diff (link-keyed, D1 §3
  "a chapter = its link"; ASCII-case-insensitive equality = the
  forward diff's `AnsiCompareText` parity; stored order preserved;
  duplicate stored lines stay distinct).
- `FavoritesEngine.checkMissing` (FMD2 `FCheckMissing` parity,
  uFavoritesManager.pas :397-399 skip-link-less, :421-422 immediate
  CurrentChapter/Status, :509 DateLastChecked; documented divergence:
  DateLastUpdated deliberately NOT set — a missing report is not an
  update): ONE paced live GetInfo → the reverse diff → REPORT ONLY.
  The downloaded list is NEVER rewritten, nothing is enqueued, no file
  is touched ("nothing auto-deletes user files").
- API: `POST /api/favorites/:id/check-missing` (typed 404/502
  envelopes; wildcard composite-id dispatch includes the suffix).
  OpenAPI snapshot + routes inventory + web client regenerated
  (drift tests green).
- Web: Favorites row-menu "Check missing chapters" → report dialog
  (empty state, per-link list, close). The report is the ENTIRE
  effect — no action affordance exists in the dialog by construction.

## Regression pins

- `server/test/jobs/host-pacing.test.ts` — bucket unit pins (spacing
  ≥ interval, cross-host parallelism, origin-keyed sharing,
  never-gated unknowns, FIFO fairness, exported defaults) + the
  SCHEDULER acceptance: N favorites on one host checked in one sweep
  fetch at [0, I, 2I] under a FakeClock (maxConcurrent 4 — pacing is
  the only spreader) while a different host's check fetches at 0.
- `server/test/runtime/download-lane-pacing.test.ts` — the DOWNLOAD
  acceptance: 3 concurrent jobs on one host start their module
  sessions at [0, I, 2I] (pin at the acquire→createHooks seam) while
  a different host's job starts at 0; REAL queue + packers + library
  store over the loopback fixture site.
- `server/test/jobs/queue/backoff.test.ts` — the pinned curve
  (geometric growth, 24 h cap, jitter bounds, defaults) + delayed
  re-claim over the REAL SQLite queue with FakeClock: unclaimable
  until the stamp elapses, slot freed during backoff (other work
  proceeds on ONE slot), exhaustion → existing failed state, crash
  recovery re-pools as immediately claimable retries.
- `server/test/jobs/favorites/missing.test.ts` — the reverse diff
  (complement of the forward diff, case-insensitivity, emptied list,
  duplicate lines) + the engine cycle (never rewrites the stored
  list, empty report, :397-399 skip, typed 404, fetch failure
  propagates).
- `server/test/api/favorites.test.ts` — route shapes over
  fastify.inject (report 200 shape, empty report, unknown 404
  envelope, raw composite-id wildcard dispatch).
- `web/test/favorites-page.test.tsx` — dialog render (links listed in
  order, favorite titled), the no-side-writes assertion (only the
  check-missing POST fires — no DELETE/PUT/other POST), empty state,
  failure path (no dialog, no side writes).

## Gates (working tree, 2026-11-19)

- `node_modules/.bin/vitest run` — **249 files / 2427 passed | 3
  skipped | 0 failed** (354 s).
- `node_modules/.bin/tsc -b tsconfig.json` — clean (0 errors).
- `node_modules/.bin/eslint .` — clean.
- `server/test/api/openapi.test.ts` — 6/6 (snapshot byte-equality +
  client drift; snapshot regenerated in this change).

## Sequencing / same-worktree notes

- The release lane ([tsk-alert-drifter-tasks], retro-titanium-waits)
  found commit 168787c accidentally swept this story's
  `server/src/api/services.ts` FavoriteService INTERFACE hunk
  (`checkMissing`) into its commit — the same-worktree blanket-staging
  accident class documented at 121ed33/4167172. This landing supplies
  the implementations (the worktree services.ts delta vs HEAD is the
  `InMemoryFavoriteService.checkMissing` double + its import), which
  repairs `tsc -b` on a clean checkout of master. No history rewrite.
- This commit stages ONLY this story's files via an explicit
  pathspec commit (the 26318fa/121ed33 precedent): the shared index's
  state for sibling-lane files (honeycomb's staged pair, the v0.3.2
  CHANGELOG/RELEASE-NOTES entries, the 8 orphaned manga+settings
  visual fixtures, dist-web bundles, UX-AUDIT.md) is left untouched
  for their owning lanes.
- No release tag (D1 §8.5).
