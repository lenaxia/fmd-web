# Evidence — [azure-moonlight-plumbs] Single outbound webhook notifications

Story: ONE webhook, zero channel adapters. Settings: url + optional
secret + per-event-class toggles + test-send action. Event classes:
`chapter.downloaded` (individual), `favorites.digest` (per check sweep
summary), `failure.digest` (per-site coalesced failures — a dead site
with 50 favorites produces ONE entry per digest window, never 50;
window 15 minutes per site). Delivery: fire-and-forget POST with JSON
payload, HMAC-SHA256 signature header (secret), 2 retries then drop
(logged); advisory and lossy-tolerated — the inbox remains the source
of truth. Consumers bridge to chat/push services themselves; a
grep-gate test forbids per-channel adapter code from entering the
tree. Charter: D1 (`docs/DESIGN-NORTHSTAR.md` §1 identity
"scheduler → download → library → webhook", §3 Pipeline invariant
"at most one webhook, zero channel adapters", §8 standing
constraints).

## What shipped (files)

| File | Role |
|---|---|
| `contract/types.ts` | The typed seam (§8.2): `WebhookEventClass`, `WebhookEnvelope<D>`, the three payload shapes (`ChapterDownloadedData`, `FavoritesDigestData`, `FailureDigestData`) + `WebhookTestData`, and `WEBHOOK_SIGNATURE_HEADER` (`X-FMD-Signature`) — the wire contract external consumers program against. |
| `server/src/webhook/delivery.ts` | `WebhookNotifier`: `emit()` (fire-and-forget, never throws, toggle+url gated) and `sendNow()` (the test-send action's ONE awaited cycle). `serializeEnvelope()` couples the body and the `sha256=<hex>` HMAC header to the same bytes. 2-retries-then-drop with the `onDrop` structured-log sink; http(s)-only url re-check at the hop. Transport is the `WebhookPostFn` seam (production = global fetch + 10 s AbortSignal timeout; tests = counting fakes). |
| `server/src/webhook/digest.ts` | `SiteFailureCoalescer`: per-site windows keyed on the FIRST failure, `FAILURE_DIGEST_WINDOW_MS = 15 min` (charter-frozen), timer seam injectable (`setTimeoutFlush` unref'd in production), emits ONE `FailureDigestData` per site per window close; `dispose()` drops windows silently (shutdown). |
| `server/src/webhook/sweep.ts` | `SweepAccumulator`: tallies per-check outcomes (checked/new-chapters/queued/failures) between sweep boundaries; `take()` returns the ONE digest payload per sweep or null. |
| `server/src/jobs/favorites/scheduler.ts` | The sweep boundary as a first-class seam: `onSweepIdle` fires when the running set drains AND nothing is due at the clock (a completion with the next favorite still due does NOT fire — the contiguous busy period IS the sweep). Guarded: a throwing consumer never breaks the loop. |
| `server/src/runtime/download-lane.ts` | `onChapterDownloaded` dep — invoked once per finalized chapter with the individual event payload (after finalize + ledger writes; fire-and-forget by contract, try-guarded). |
| `server/src/api/schemas.ts` | `WebhookSettingsSchema` (url `''` = off, secret `''` = unsigned, `WebhookEventTogglesSchema` all-on defaults via `DEFAULT_WEBHOOK_EVENT_TOGGLES`), the http(s) `superRefine` on updates, `WebhookTestSendResponseSchema`, and the `webhook` group added to `SettingsResponseSchema`. |
| `server/src/api/services.ts` | `SettingsService` grows `getWebhookSettings`/`setWebhookSettings` + the `setWebhookSettingsLive` assembly seam (seed does not fire the write-back sink — the favorites posture). |
| `server/src/api/app.ts` | `PUT /api/settings/webhook` (full-group replacement) + `POST /api/settings/webhook/test` (409 unconfigured; honest report; covers-posture mounting on the `webhookTestSend` seam). |
| `server/src/api/openapi.ts`, `routes.ts` | The two routes documented + inventoried; snapshot regenerated in the same change (§8.2). |
| `server/src/runtime/assembly.ts` | Production wiring: `webhook.config` app_settings seed/sink, notifier (live settings read per event — a PUT applies to the next delivery), coalescer flush → `failure.digest`, scheduler check-wrap → sweep tally, `onError` → per-site coalescing, `onSweepIdle` → `favorites.digest`, lane `onChapterDownloaded` → `chapter.downloaded`, dispose drops open windows. |
| `server/src/engine/sidecar/bypass-adapter.ts` | One local renamed (`slack` → `timingSlack`, a timing constant) so the no-channel-adapters gate can ban the brand-shaped word outright. Zero behavior change. |
| `server/test/webhook/delivery.test.ts` | 10 tests: wire shape, HMAC-over-exact-body, unsigned mode, 3-attempts-then-drop (logged), non-2xx = failed attempt, same-envelope retries, off-state, toggle gating, `sendNow` reports, non-http(s) refusal. |
| `server/test/webhook/digest.test.ts` | 7 tests: the pinned coalescing matrix (below). |
| `server/test/webhook/pipe.test.ts` | 3 acceptance-shaped integration tests over the REAL engine + scheduler + store: dead site 12 favorites → 1 failure.digest + 1 favorites.digest per sweep; muted classes silent; off silent. |
| `server/test/jobs/favorites/scheduler.test.ts` | +4 `onSweepIdle` unit tests (one firing per contiguous sweep; new sweep per interval; zero-favorite never fires; throwing consumer survives). |
| `server/test/api/webhook.test.ts` | 6 route tests: group on GET, PUT round-trip, typed 400s (ftp://, garbage), empty-body defaults, test-send 409/report, unmounted-without-seam. |
| `server/test/api/no-channel-adapters-grep.test.ts` | THE GATE (below). |
| `web/src/api/openapi.d.ts` | Regenerated from the snapshot (`openapi-typescript`) — the generated web client seam (§8.2). |
| `docs/API.md` | "Webhook — the ONE outbound notification surface" cookbook section. |

## Design decisions (all inside the D1 charter)

- **The sweep is the scheduler's contiguous busy period.** D1 §2 says
  the favorites check loop is the pump; a "check sweep" therefore ends
  when the running set drains AND nothing is due at the clock — a
  completion that immediately re-claims the next due favorite does not
  end it. Detected INSIDE the scheduler (`onSweepIdle`) where the
  transition is synchronous and deterministic under the FakeClock,
  not by polling `stats()` from the assembly (which would race the
  continuation microtasks).
- **Scheduled sweeps only.** Manual check-now and batch checks surface
  their results in the API response + UI (the exceptions surface,
  D1 §1); the digest is the headless pipe's summary. Scoped
  deliberately.
- **failure.digest keys on module id** (one module = one site = one
  origin — the TRIAGE/availability taxonomy), windows keyed on the
  FIRST failure (later failures never extend a window), flush at
  window close emits exactly one entry. A vanished favorite's failure
  (no resolvable site) is counted in the sweep digest but not
  coalesced — no site, no window.
- **No queue, no guarantee machinery.** `emit()` is void and never
  throws; retries live inside one floating promise; the terminal
  failure is a `webhook_drop` structured log line. Nothing persists,
  nothing redelivers, shutdown drops open digest windows silently —
  the charter's "advisory and lossy-tolerated" honored literally.
- **The signature MACs the exact serialized string.** `serializeEnvelope()`
  derives body and header from the same bytes; the delivery test
  recomputes the HMAC over the raw body the fake transport received —
  the receiver-side verification, done by the test.
- **The only awaited delivery is the test-send action.** Operators
  need the honest report (`delivered/attempts/status/error`); real
  events stay fire-and-forget so the pipe never blocks on
  notifications (D1 §3).
- **The grep gate scans server/src + web/src for the brand
  vocabulary** (telegram/discord/ntfy/slack, case-insensitive whole
  words). Docs are deliberately outside scope (design records NAME
  the services when ruling them out); the OpenAPI snapshot stays
  inside the scan so route descriptions are brand-free by
  construction ("chat/push services"). The pre-existing timing local
  `slack` in bypass-adapter.ts was renamed `timingSlack` in this
  change so the word could be banned outright — disclosed here and in
  the commit.
- **URL validation is layered**: the settings PUT enforces http(s)
  with a host (typed 400); the delivery hop re-checks before every
  POST (never an accidental generic fetcher — the module-validated
  outbound posture applied to the one operator-configured
  destination).

## Test coverage — the pinned digest semantics

`node_modules/.bin/vitest run server/test/webhook` + scheduler +
api suites — all green:

- **Coalescing pinned** (`digest.test.ts`): 50 failures on ONE site
  inside the window → exactly ONE entry (`failureCount: 50`,
  `affectedFavoritesCount: 50`, sample capped at 5); distinct sites
  coalesce independently; a failure after close opens a FRESH window;
  the window is keyed on the FIRST failure (a minute-14 failure
  joins, never extends); non-Error failures stringify with 500-char
  message cap; RFC 3339 stamps; dispose drops silently.
- **Pipe integration** (`pipe.test.ts`): dead site × 12 favorites +
  2 live → after sweep 1 exactly ONE `favorites.digest`
  (`favoritesChecked: 2, checkFailures: 12, newChaptersFound: 2,
  downloadsQueued: 2`) and ZERO `failure.digest` mid-window; window
  close → exactly ONE `failure.digest` (`failureCount: 12`); the next
  interval → the NEXT `favorites.digest` (one per sweep, never per
  check). Muted classes and url-`''` produce silence end-to-end.
- **Scheduler seam** (`scheduler.test.ts`): one firing per contiguous
  sweep of 5; a second firing only at the next interval; zero
  favorites → zero firings; a throwing consumer does not break the
  loop (next sweep still runs).
- **Routes** (`webhook.test.ts`): the group rides GET /api/settings
  (off by default); PUT round-trips url + secret + partial toggles;
  `ftp://` and garbage urls are typed 400s while `''` stays legal;
  `{}` parses to all-defaults; test-send 409s unconfigured, reports
  honestly wired, and 404s without the seam (covers posture).
- **OpenAPI**: snapshot test green after regeneration; the generated
  web client regenerated from it in the same change.

## Gates (all via node_modules/.bin — D1 §8.1)

`npm run contract:check` (0 mismatches) · `node_modules/.bin/eslint .`
(clean) · `node_modules/.bin/tsc -b tsconfig.json` (clean) · `npm
test` (FULL suite: 254 files, 2458 passed / 3 pre-existing skips) ·
`bash scripts/engine-boundary-mutate.sh` (all 5 rules fire) · `bash
scripts/no-chapter-number-parsing-gate.sh` (OK) · `bash
scripts/design-gate.sh` (OK).

DISCLOSED — pre-existing, NOT this story's: `bash
scripts/engine-boundary-gate.sh` exits 1 on the PRISTINE tree
(stash-verified before/after this change): committed HEAD imports
`engine/services/engine-thread.js` + `engine/services/availability.js`
from `runtime/assembly.ts` (and `site-availability.ts`,
`api/cover-proxy.ts` shims), which the gate's `DOORS` allowlist
(facade|index only) flags. This story's delta adds ZERO engine
imports (its assembly.ts additions are `webhook/*` + `api/schemas`
only — the added-import diff is quoted in the commit) and touches
`engine/` solely for a local variable rename inside
`engine/sidecar/bypass-adapter.ts` (gate hygiene for the
no-channel-adapters word ban; no imports, no boundary crossings).
The corpus replay + compose e2e phases of `scripts/ci.sh` are
unchanged by this story (no engine, no UI pages, no fixtures
touched) and are not run here.

## Standing constraints (D1 §8) checklist

- [x] Gates via `node_modules/.bin` — no `npx` anywhere in this
      story's commands.
- [x] Typed seams: the wire contract lives in `contract/types.ts`;
      OpenAPI snapshot + generated web client regenerated in the same
      change (snapshot drift = failed gate, honored).
- [x] Restart canon: not needed (no dev-preview restart in this
      story's verification).
- [x] Long-form commit (see `git log`).
- [x] No release tag.

## Review-bounce remediation (merry-woodland-refrains verdict)

The review FAILED the gate on one blocker + one minor (full transcript
in the review evidence file), both in the no-channel-adapters gate —
remediated in the follow-up commit, A/B-proven:

- **BLOCKER — `\b`-anchored whole words let adapter-shaped camelCase
  identifiers pass GREEN.** The review planted
  `telegramAdapter`/`discordBridge` (both roots),
  `sendDiscordMessage` + `ntfyClient`, and only the bare word tripped
  the gate. Remediation, exactly as prescribed:
  1. Patterns are now case-insensitive **substrings**
     (`/telegram/i` etc., unanchored) — every casing/compound shape
     matches; the gate-file header documents WHY (the bounce) and
     points at the mutation proof.
  2. `bypass-adapter.ts`'s timing constant renamed AGAIN
     (`timingSlack` → `timingMargin`) — the shipped rename only
     satisfied the word-boundary form; the substring "Slack" (any
     casing) would now trip. Zero behavior change, disclosed.
  3. **`scripts/no-channel-adapters-mutate.sh`** (the
     engine-boundary-mutate discipline, wired into `scripts/ci.sh`
     after the chapter-number gate): plants adapter-shaped fixtures
     and requires the REAL gate test to FAIL naming the offender —
     M1 camelCase identifiers in server/src (the review's exact
     evading shapes, all four brands), M2 dotted-API-URL-only in
     server/src (`api.telegram.org` endpoint string), M3 camelCase +
     URL in web/src — then the clean-tree control (gate GREEN with
     every plant removed, trap-guarded cleanup). Run output:
     all mutations fired, clean-tree control green.
- **MINOR — the header claimed the OpenAPI snapshot was inside the
  scan while `.json` was excluded.** Resolved the STRONG way: `.json`
  is now in `ALLOWED_SUFFIXES`, so the committed snapshot under
  `server/src/api` is genuinely scanned (route descriptions stay
  brand-free by construction — verified: the tightened substring
  sweep over server/src + web/src (.ts/.tsx/.json) is clean).

Post-remediation gates (all via node_modules/.bin): substring sweep
clean · `tsc -b` clean · `eslint .` clean · story suites 40/40 ·
`bash scripts/no-channel-adapters-mutate.sh` all-shapes-fire +
clean-tree control · FULL `npm test` — 258 files, 2486 passed /
3 pre-existing skips (the reviewer's post-sibling-landing baseline).
