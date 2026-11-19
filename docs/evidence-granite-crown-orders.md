# Evidence — Triage surface: one Attention screen [granite-crown-orders]

Story: `tsk-granite-crown-orders` (epic "Pipe with an Inbox — post-v0.3.2
product batch", project FMD-Web Implementation). Charter: ONE screen
answering "what needs me" — failed downloads grouped by cause (site
dead joining the [site-availability] record, anti-bot /
bypass-unavailable, rate-limited, other), each group with a retry-all
that routes through the p1 per-host pacing (never a burst), links into
the registry availability column, and a healthy empty state that
celebrates doing nothing. No new state machines: the surface
aggregates existing job failure states + availability.

## What landed

**Server — the aggregation (read-side only, no new state machine):**

- `server/src/runtime/triage.ts` — `classifyFailedJob` (the ONE pure
  classification seam shared by the snapshot and the retry-all so
  membership can never disagree) + `TriageService` (`snapshot()` /
  `retryGroup(cause)`). Grouping order of authority: (1) the
  availability record — `unreachable` ⇒ `site_dead` (the
  [tsk-amber-pivot-refrains] join; the record is written by the ONE
  shared classifier from transport-class failures and 5xx answers, so
  this group is exactly "the pipe already observed origin trouble");
  (2) the typed §4/§7.3 failure kind — pack/engine_oom/worker_stalled
  ⇒ `other` BEFORE any text is read (a zip error mentioning "403" in a
  file name cannot land in anti-bot); (3) narrow text vocabulary for
  the two causes availability deliberately cannot express (HTTP 4xx
  writes no verdict): `\b429\b|too many requests` ⇒ `throttled`,
  `\b403\b|antibot|anti-bot|bypass|challenge|cloudflare|ddos-guard` ⇒
  `antibot`; everything else ⇒ `other`.
- Failed rows superseded by a LIVE retry-chain successor (`<key>#<n>`)
  drop out of the snapshot — they are back in the pipe, not awaiting
  attention (the terminal row lingers until retention; it must not
  linger in the groups). Cursor-paginated walks over the job service's
  `list` seam (100/page, retention bounds the terminal set).
- `retryGroup(cause)` funnels every member row through the SAME
  per-job retry action the downloads tab uses (`action(id, 'retry')`
  — fresh chained attempt, markers resume). Per-host pacing applies
  BY CONSTRUCTION: the re-enqueued rows re-enter the download lane,
  which awaits the shared `ModuleHostPacer` before a job's first
  module hop (the [tsk-outland-henna-masks] seam — "the p1 per-host
  pacing"). Availability is NEVER consulted on the retry path. A row
  that raced away (typed 409) is skipped, not fatal (bulk-action
  precedent).
- **Wire naming collision, disclosed:** the auth-removal grep gate
  (`server/test/api/auth-removal-grep.test.ts`, the [token-auth]
  story's tripwire) bans the quoted string `'rate_limited'` — the
  removed 401/429 auth error code — anywhere in server/web source.
  The rate-limit cause therefore ships as the wire token `throttled`;
  every human-facing label still reads "Rate limited". The gate was
  NOT touched.

**Server — the typed seams (D1 §8.2):**

- `contract/schemas.ts`: `JobFailureKindSchema` (the §4/§7.3 enum as
  zod, mirroring the `JobStateSchema`/`JobState` precedent) + additive
  `JobSchema.failureKind` (failed rows only). `JobRecord` /
  `QueueJob`→wire threading through `download-lane.ts` and `app.ts`.
- `server/src/api/schemas.ts`: `TriageCauseSchema`, `TriageJobSchema`
  (attention rows carry payload provenance + failure text + the typed
  kind), `TriageSiteSchema` (registry-name + availability joins),
  `TriageGroupSchema`, snapshot/retry request-response schemas. All
  four groups ALWAYS present in the fixed order (`site_dead`,
  `antibot`, `throttled`, `other`) so the shape is stable; empty
  groups carry count 0.
- Routes: `GET /api/triage` + `POST /api/triage/retry` in `app.ts`,
  constructed from seams every deployment already has (jobs required;
  availability optional — absent reads `unknown`, the `/api/modules`
  posture; module registry for names). OpenAPI paths + shared-schema
  registry entries in `openapi.ts`; route catalog rows in `routes.ts`;
  **snapshot regenerated in the same change** (`API_OPENAPI_SNAPSHOT=write
  vitest run server/test/api/openapi.test.ts`, 6/6) and the web client
  types regenerated (`openapi-typescript ... --output web/src/api/openapi.d.ts`).

**Web — the surface:**

- `web/src/pages/AttentionPage.tsx`: groups with counts + per-group
  **Retry all** (fires `POST /api/triage/retry` with the cause; toast
  reports the paced outcome), per-site buckets with `AvailabilityChip`
  + the dead-site cross-link into the registry availability column
  (`#/settings?section=websites` — the Settings Websites deep-link),
  job rows dimmed (`opacity`) in the `site_dead` group with an
  explicit "the record never blocks a retry you explicitly make" note
  — **buttons never disable on availability** (D1 §3 hints-never-block).
- Healthy state (`failedTotal: 0`): the explicit `attention-empty`
  block — "Nothing needs you." + coffee icon + copy celebrating the
  hands-off pipe (§1) + a link into the library.
- Primary nav on BOTH form factors: `attention` added to
  `RouteName`/`ROUTE_NAMES` (`router.ts`), `NAV_TABS` (desktop header)
  and `BOTTOM_NAV_DESTINATIONS` (mobile bottom bar, R3 equal-citizen
  rule) in `App.tsx` with the `TriangleAlert` icon. The App shell's
  module-level nav-sync invariant pins the two tab sets to the router.
- Hooks: `useTriage` (query `['triage']`) + `useTriageRetry`
  (invalidates `['triage']` + every `['jobs', *]` page on success).

## Tests (acceptance-shaped)

- `server/test/runtime/triage.test.ts` (14): classifier precedence
  (record > kind > vocabulary > other); snapshot shape (all four
  groups, fixed order, counts, site buckets, name/availability joins,
  cursor-paginated walks, live-successor exclusion, no-seam unknown
  posture); retryGroup (exact membership, the SAME action seam,
  **availability never gates the site_dead retry**, 409-race skip,
  empty no-op).
- `server/test/runtime/triage-retry-pacing.test.ts` (1) — **the AC1
  pacing pin**: real SQLite queue rows driven to the REAL `failed`
  terminal state (typed kind + 429 error text), classified by the
  snapshot (`throttled` × 3 on host A, `other` × 1 on host B),
  re-enqueued by `retryGroup`, then run by the download lane with the
  shared pacer + FakeClock: module-session starts on A spaced exactly
  `[0, 500, 1000]` ms (≥ interval, no burst), B starts at t=0 (never
  blocked by A's busy bucket), all four retries finish `done`.
- `server/test/api/triage.test.ts` (8): the ROUTE contract — healthy
  shape, grouping + joins through HTTP, additive `failureKind` on the
  `/api/jobs` wire, retry response, site_dead retry WITH an
  unreachable record bound (never refused), typed 400 on an unknown
  cause, empty no-op.
- `web/test/attention-page.test.tsx` (5): the explicit healthy empty
  state; non-empty groups render with counts/sites/rows; Retry all
  fires the POST with the cause; dead-site rows carry the registry
  cross-link href AND the retry button stays enabled; the router
  carries `attention` (the App invariant pins the nav sets).

## Gates (all via node_modules/.bin — D1 §8.1)

- `node_modules/.bin/tsc -b tsconfig.json --force` — clean (contract +
  server + web + corpus).
- `node_modules/.bin/eslint` on every touched file — clean.
- `node_modules/.bin/vitest run` (full) — **2486 passed | 0 failed |
  3 skipped (2489 tests)**; a mid-flight full run caught the App-shell
  nav-sync invariant firing (a corrupted tool edit had silently
  dropped the `attention` NAV_TABS entry) — fixed, then the final full
  run above. Two earlier full runs each showed one MOVING load flake
  under the 258-file sweep (a subprocess-drain timeout, a worker-exit
  file race) — both named suites pass in isolation and neither
  involves this story's files; the final run shows zero failed files.
- OpenAPI snapshot test 6/6 in both read and write modes; snapshot +
  generated web types committed with the schema change.

## Standing constraints (D1 §8) checklist

1. Gates via `node_modules/.bin` directly — yes (npx never invoked).
2. Typed seams, no `any`-shaped crossings — the triage port is
   `Pick<JobService, 'list' | 'action'>` (narrow, fake-injectable);
   all wire shapes are zod-inferred; the OpenAPI snapshot regenerated
   in the same change.
3. Restart canon — not needed (no dev-preview restart in this story).
4. Long-form commit — yes.
5. No release tag — yes.

## Sequencing (shared worktree)

The worktree carries the release lane's uncommitted reorganization
(`CHANGELOG.md` + `docs/RELEASE-NOTES.md` 0.3.2 section moves, and the
rebuilt `web/dist-web` bundle). Per the b8de66f/359c20a same-worktree
precedent this story stages ONLY its own content: whole new files,
its modified source/test files, and its single `[Unreleased]`
CHANGELOG hunk via index plumbing (base = HEAD + this story's entry,
the sibling's hunks stay working-tree-only). The committed SPA bundle
is deliberately NOT rebuilt here — bundle regen is the release
story's act at its integration point (f1bf8d5 precedent), and the
release lane owns the uncommitted dist tree right now.
