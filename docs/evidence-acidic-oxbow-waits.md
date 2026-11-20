# Evidence — [acidic-oxbow-waits] Inbox home: new-chapters feed with caught-up

Story: Home becomes an **inbox** (D1 §2 INBOX) — a reverse-chronological
feed of what arrived, with per-chapter seen state and one shared
caught-up action. Chartered by `docs/DESIGN-NORTHSTAR.md` §2 INBOX +
§3 invariants; standing constraints §8 observed throughout.

## What shipped (files)

Server:

- `server/src/runtime/inbox.ts` (NEW) — the store + service: app.db
  table `inbox_event` (one row per detected new chapter), `seen_at`
  NULL = the feed / a stamp = the archive, the rolling 30-day window,
  ack-exactly / caught-up / purge, and `inboxChapterKey` (the
  Pascal-`LowerCase`-folded `module|link` chapter identity).
- `server/src/jobs/favorites/engine.ts` — the ONE detection path emits:
  `FavoritesEngine.checkFavorite` records the diff's new-chapter set
  through a new guarded `inbox` dep (scheduler sweeps, manual
  check-now AND batch checks all flow through this single method —
  there is no second detection path anywhere in the tree).
- `server/src/runtime/assembly.ts` — production wiring: the service on
  the shared app.db handle, the engine dep, and the purge as the same
  hourly-housekeeping posture as the job-retention sweep (unref'd
  interval + one boot pass — **never** a read side effect, D1 §3 "GET
  never mutates").
- `server/src/api/schemas.ts` / `app.ts` / `routes.ts` / `openapi.ts` —
  the typed surface: `GET /api/inbox?view=new|archive`,
  `POST /api/inbox/ack` (EXACTLY the named chapters),
  `POST /api/inbox/caught-up`; zod parses at the boundary; the routes
  mount only when the seam is bound (the covers/metrics posture).
- `server/src/api/openapi.snapshot.json` — regenerated in the same
  change (D1 §8.2: snapshot drift is a failed gate, not a follow-up).

Web:

- `web/src/api/openapi.d.ts` — regenerated from the new snapshot
  (`gen:api`); every call site keys on generated path types.
- `web/src/router.ts` — route `inbox`, and `DEFAULT_ROUTE = 'inbox'`:
  **Home IS the inbox** (unknown hashes and the bare `#/` land on the
  feed). The old search-home default lives on at `#/browse`; deep
  links unchanged.
- `web/src/pages/InboxPage.tsx` (NEW) — the mobile-first feed: cover
  thumb via the existing `coverSrc` proxy, title, chapter label, site
  badge (the `/api/modules` name join, rendered through the existing
  `WebsiteBadge`), arrival time; per-row **Seen** ack; **Caught up**
  bulk action; the Archive tab; the healthy empty state.
- `web/src/api/hooks.ts` — `useInbox(view)` / `useAckInboxChapters` /
  `useInboxCaughtUp` over the generated client.
- `web/src/App.tsx` — Inbox leads the nav (top tabs + bottom bar),
  brand link → `#/inbox`.
- `web/src/components/patterns/BottomTabNav.tsx` — count-aware grid
  columns. This fixes a LATENT mobile defect this story inherited: the
  bar hardcoded `grid-cols-5` while the app already shipped 6
  destinations (the 6th wrapped onto a second row); landing the 7th
  (Inbox) made the bar count-aware (5–8) instead.

Tests (all new):

- `server/test/runtime/inbox.test.ts` — the persisted-truth semantics.
- `server/test/jobs/favorites/engine-inbox.test.ts` — the emission
  seam (what the check engine records, and what it must survive).
- `server/test/api/inbox.test.ts` — the §10 route contract over the
  real SQLite service.
- `web/test/inbox-page.test.tsx` — the UI contract.

Docs: this file + `docs/USER-GUIDE.md` § "The inbox (Home)".

## Design decisions (all inside the D1 charter)

1. **The feed derives from check-engine events — one detection path.**
   `FavoritesEngine.checkFavorite` is the only new-chapter detector
   (link-keyed diff, §7.2/D8). The inbox rows are written THERE, via a
   guarded fire-and-forget sink — so a sweep, a manual Check now and a
   batch check all feed the same inbox, and nothing else in the tree
   detects chapters. The download lane's `chapter.downloaded` webhook
   event is a different event class (delivery, not detection) and is
   deliberately NOT an inbox source: the inbox answers "what arrived
   for my favorites", which is exactly the diff's new-chapter set.
2. **Seen state is per chapter (`chapterKey`), not per favorite.**
   `chapterKey = asciiLowerCase(moduleId) + '|' + asciiLowerCase(link)`
   — the same Pascal `LowerCase` folding the favorites mangaKey uses
   (`downloadedChaptersKey`), so case-variant links fold to one row
   exactly like the diff's membership test. Acknowledging clears
   EXACTLY the acknowledged chapters; bulk caught-up stamps every
   unacknowledged row in one write.
3. **Idempotent recording (D1 §3).** `INSERT ... ON CONFLICT DO
   NOTHING`: a chapter re-detected on a later sweep (the no-auto-
   download case — the stored favorites list never learns the link)
   neither duplicates a feed row nor resets its seen state; the FIRST
   detection stamp is the arrival truth. Consequence, documented: a
   favorite deleted and re-added does not replay its previously
   acknowledged chapters into the feed — those arrivals were already
   seen (identity is the link, and the link arrived once).
4. **Snapshots ride the row.** Title and cover link are captured at
   detection, so an entry keeps rendering after its favorite is
   deleted — the inbox is a feed of arrivals, not a favorites join.
   The cover renders through the existing same-origin `/api/cover`
   proxy (`coverSrc`); no new byte-serving surface exists (D1 §3).
5. **One shared caught-up state across devices (the documented
   multi-device posture).** Seen rows live in app.db server-side:
   caught up once, caught up everywhere; marking read on one device
   never replays on another because NO per-device state exists
   anywhere. This is D1 §4/R2 (single-user instance) applied to read
   state — accepted and documented here, in the runbook-facing user
   guide, and in the API descriptions.
6. **The archive is a 30-day rolling window, and reads never mutate.**
   The window rides the archive query's WHERE clause; the physical
   purge is scheduled housekeeping (hourly unref'd interval + boot
   pass, exactly the job-retention sweep's posture). An
   unacknowledged row is NEVER purged — the feed is the user's truth
   until they ack it (an API test pins GET-read-twice byte-equality).
7. **URL-as-truth (`?view=new|archive`).** The page renders purely
   from the route query (absent/invalid → `new`); the tabs are plain
   links to `#/inbox?view=…` hashes — every view shareable,
   reloadable, back-navigable. The API mirrors the vocabulary
   (`GET /api/inbox?view=`), with a typed 400 for garbage on the wire
   (no silent fallback at the API boundary; the PAGE falls back to
   `new` because a hash param is UI state, not an API call).
8. **Notifications complement, never gate.** Nothing in the inbox
   consults the webhook subsystem; the webhook story's own charter
   already declares the inbox the source of truth. No code touch
   needed — pinned here as the recorded posture.
9. **Home = the inbox, Browse stays Browse.** The default route and
   the nav lead move to `#/inbox`; `#/browse` (search home, site
   browse) is unchanged and every existing deep link keeps working.
   The nav order is Inbox · Browse · Favorites · Downloads ·
   Attention · Library · Settings (top tabs and bottom bar stay in
   lockstep — the shell invariant asserts it).

## Acceptance criteria → evidence

1. **Seen-state is per chapter (chapterKey); acknowledgment clears
   exactly the acknowledged chapters; bulk caught-up marks all
   visible.**
   `server/test/runtime/inbox.test.ts`: "acknowledges EXACTLY the
   named chapters — the others stay in the feed" (3 recorded, 1
   acked → feed keeps 2, archive holds 1 with its stamp; re-ack
   flips 0; unknown keys flip 0); "caught-up stamps EVERY
   unacknowledged row" (across two favorites; second call flips 0);
   "recording is idempotent per chapter_key"; "case-variant links
   fold to the SAME chapter key". 11/11 green.
2. **Home renders the unacknowledged feed (cover, title, chapter
   label, site badge) mobile-first; archive shows acknowledged
   events for 30 days; ?view= URL-as-truth.**
   `web/test/inbox-page.test.tsx`: "renders arrivals with cover,
   title, chapter label and site badge" (cover/title/chapter testids
   + the `ExampleScan` site-name join + the new-count chip);
   "the per-row Seen button acknowledges EXACTLY that chapter"
   (POST body `{chapterKeys: ['key-2']}`); "Caught up fires
   POST /api/inbox/caught-up"; the archive suite (?view=archive
   renders acknowledged rows with NO ack buttons, the feed call
   carries `view=archive`, tabs target the ?view= hashes, unknown
   ?view falls back to new, archive empty state). 8/8 green. The
   30-day window + purge semantics are pinned server-side
   ("serves acknowledged entries inside the window and hides older
   ones", "purge removes EXACTLY the acknowledged rows past the
   window — never an unacknowledged row", the frozen 30-day
   constant).
3. **Multi-device shared state documented; feed derives from
   check-engine events, no second detection path.**
   Documented: DESIGN-NORTHSTAR §2 (the charter), this file §Design
   decisions 1/5, `docs/USER-GUIDE.md` § "The inbox (Home)" ("One
   inbox, every device (documented)"), and the three API route
   descriptions. Derivation: `server/test/jobs/favorites/
   engine-inbox.test.ts` — a check with new chapters records EXACTLY
   the new set with identity + snapshots; nothing-new records
   nothing; known chapters are not re-recorded; the tag-100 transfer
   ingest records nothing; a THROWING sink never takes the check
   down; the real service lands rows idempotently. 6/6 green. The
   detection code path is one method (`checkFavorite`) — the diff
   lives in `jobs/favorites/diff.ts`, untouched.
4. **Full gates green via node_modules/.bin; typed seams + OpenAPI
   snapshot; long-form commit; no release tag.**
   See "Gates run" below; the snapshot + generated client are
   regenerated in this change; the commit is the long-form house
   message; no tag is created.

## Gates run (all via /workspace/fmd-web/node_modules/.bin — D1 §8.1)

- `tsc -b tsconfig.json` — CLEAN (contract/server/web, tests included).
- `vitest run` (full) — 259 files, 2501 tests: **2497 passed | 3
  skipped | 0 failed** (the three skips are the repo's pre-existing
  conditional skips; numbers re-run after the final edit — see the
  note below).
- Targeted suites in isolation after the final file state:
  `server/test/runtime/inbox.test.ts` 11/11,
  `server/test/jobs/favorites/engine-inbox.test.ts` 6/6,
  `server/test/api/inbox.test.ts` 9/9 (includes the absent-seam 404
  posture + the GET purity test), `web/test/inbox-page.test.tsx` 8/8,
  `server/test/api/openapi.test.ts` 6/6 (snapshot byte-equality after
  regeneration).
- `eslint` on every touched file — clean.
- `npm run contract:check -w @fmd/contract` — green (extractors vs
  contract.json vs generated bindings; no contract-type change).
- Shell gates from `scripts/ci.sh` that apply: `engine-boundary-gate.sh`
  (the inbox service lives in runtime/, outside the engine boundary),
  `no-chapter-number-parsing-gate.sh` (no number parsing added —
  chapter labels are the live-list names), `design-gate.sh`
  (tokens-only styling; the page uses the token classes), and
  `no-channel-adapters-mutate.sh` (no adapter code touched).
- NOT run here (documented): the docker/compose e2e phases and the
  corpus replay — they are unchanged by this story (no engine,
  corpus or pipeline-code touch) and belong to the release lane's
  full `scripts/ci.sh` pass on a docker-capable runner; the SPA
  bundle under `web/dist-web` is likewise left to the release lane
  (a sibling lane holds uncommitted bundle state in this worktree —
  deliberately not staged, per the same-worktree coordination
  precedent).

## Deliberate divergences / notes

- The API 400s on an invalid `view` (typed boundary); the PAGE falls
  back to `new` for an invalid hash param — the hash is UI state, the
  API is the contract (documented in decision 7).
- No per-favorite grouping in v1: the feed is strictly
  reverse-chronological per chapter (D1 §2 "per-chapter seen state");
  grouping is a future read-side presentation choice if wanted.
- The nav-tab badge (new-count outside the Inbox page) was
  deliberately NOT built — the acceptance criteria do not ask for it
  and the page itself carries the count; noted as a p2 idea.
