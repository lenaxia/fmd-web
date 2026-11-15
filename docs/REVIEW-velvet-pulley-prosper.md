# REVIEW — tsk-velvet-pulley-prosper — server/jobs/download per DESIGN §7.1

Reviewer: independent in_review agent (implementation review, Round 1).
Scope: `server/src/jobs/download/` (8 files) + `server/test/jobs/download/`
(7 files incl. the fixture site) vs DESIGN §7.1/§4 and the five accepted
criteria. Status: **fail** — the implementation and the five criteria
suites verify clean; the deliverable tree ships an unreported, red
diagnostic test file that breaks `npm test`/CI, and the flake it hunts is
unresolved and directly threatens the resume criterion's assertion.

---

## What verified clean (re-run by this reviewer)

- **All five acceptance suites** (`--exclude diag-resume-race.test.ts`):
  6 files / **43 tests green** (2 independent runs; integration 7/7 both
  times). Happy path asserts the full §5.2 hook log in WorkId order with
  the AcceptImage header captured server-side; cancel asserts the
  deadline + frozen request count + persisted 'D' markers; resume asserts
  the exact remaining-fetch count; the limiter asserts the server-side
  `maxInflight === 2` bound is met AND saturated; the filename unit
  suites cover FileNames[]/`%.3d`/`%FILENAME%`/tail-truncation plus the
  end-to-end custom SaveImage path.
- **Implementation vs §7.1/§4**: the three required interfaces
  (`SiteLimiter`, `ImageWorkerPool`, `ChapterModuleHooks` — `undefined`
  = unbound, FMD2 `Assigned(OnX)`) are coded as specified; the runner
  faithfully walks TaskStart? → GetPageNumber → 'W'/'D'-aware WorkId
  phases (per-phase cursor reset) → per image BeforeDownloadImage →
  AcceptImage+limiter+retry (`> 500` only, FMD2 parity) → SaveImage /
  default writer → FileExists re-check → markDone+persist →
  AfterImageSaved; assembly is WorkId/FileNames[]-ordered with
  hole-normalization; cancellation aborts in-flight (AbortController) and
  fails limiter/pool-queued work fast; markers persist atomically and
  resume composes the persisted-'D' overlay with the on-disk
  reconciliation. Loopback-only fixture, no-network guard untouched.
  Code quality: good; FMD2 line citations check out where spot-checked.

## Findings

### Blocker 1 — red diagnostic test file shipped in the deliverable tree

`server/test/jobs/download/diag-resume-race.test.ts` (untracked, part of
this task's `?? server/test/jobs/download/` tree; never mentioned in the
evidence doc) fails on **every run** — reviewer runs: 4/4 red, ~1–4 of 25
iterations mismatch per run (~5%/iter). Vitest includes
`server/test/**/*.test.ts`, so `npm test` and CI are RED. It also carries
the repo's ONLY current tool errors: 2× TS6133 (`path`, `dupes1`
unused) and 2× eslint `no-unused-vars`. This contradicts the evidence's
verification section point-by-point ("6 files, 43 tests, all green",
"eslint → clean", "zero errors in this task's files") — those claims are
stale for the delivered tree (7 files / 44 tests, 1 red, 4 lint/type
errors in-task). The concurrent WS task's files have since gone clean, so
the coexistence caveat no longer covers anything: every defect is
in-task.

### Blocker 2 — the cancel→resume wire-level duplicate is real, unresolved, and aimed at AC-3

Every diag mismatch has one signature: pool schedules workId 3 exactly
once, the app issues exactly ONE `fetch()` (single fetchLog entry,
`downloaderEvents=[]`), yet the server records TWO `/img/p3` arrivals
~4–8 ms apart during the resume run — and final state is still correct
(`done=20`, onDisk=20). That is a transparent retry below `fetch()`:
the first attempt's connection dies before a response (root cause
unestablished — this is what the diag was hunting when the file was
abandoned), undici re-dispatches the idempotent GET on a fresh
connection. AC-3's accepted test asserts the SAME exact server-request
count (`fetchedOnResume === PAGE_COUNT − doneFirst`) over the SAME
cancel→resume race, so it carries the same ~5%/iteration nondeterminism;
it has passed so far by luck (reviewer run included). Acceptance
evidence must not rest on an unexplained flake the task's own diagnostic
reproduces on demand.

### Required for re-review

1. Resolve the transport dup at the cancel→resume boundary: establish the
   root cause of the pre-response socket death (candidates to rule in/out:
   socket torn down by the run-1 abort racing the resume dispatch on the
   shared global dispatcher pool; fixture writing into a client-aborted
   response during the overlap window). Fix at the right layer — e.g.
   dispatcher/dispatcher-pool isolation per job or non-retried dispatch —
   or, if confirmed as benign undici transparent-retry behavior on
   loopback, make the assertions wire-count-tolerant with the reason
   documented in both the fixture and the evidence doc.
2. Delete `diag-resume-race.test.ts` OR promote it to a real regression
   test with a bounded, documented assertion and zero tool errors — no
   unreported leftovers in `server/test/jobs/download/`.
3. Re-verify and update the evidence doc to match the delivered tree
   exactly (file/test counts, eslint/tsc status, stability runs).

---

*Reviewer runs (this tree, offline, node v24.20 / vitest 3.2.7):
`npx vitest run server/test/jobs/download/ --exclude …/diag-resume-race.test.ts`
→ 43/43 ×2; integration suite standalone → 7/7 ×1; diag standalone →
1/25, 2/25, 4/25, 3-sample mismatch log (all `/img/p3`, all
single-fetch/double-arrival); `npx eslint server/src/jobs/download
server/test/jobs/download` → 2 errors (diag only); `npx tsc -b
tsconfig.json` → 2 errors (diag only).*

---

## Round 2 (independent re-review, 2026-11-14 ~11:55Z) — **fail** (no changes since Round 1)

Re-ran everything in this tree. All Round-1 required fixes are **unaddressed**
(no source/test/evidence change after 10:25Z; review Round 1 written 11:13Z):

1. **Blocker (reconfirmed)** — `server/test/jobs/download/diag-resume-race.test.ts`
   still ships red: fresh run 1/60 iterations mismatched (`/img/p3`: two server
   arrivals ~8 ms apart in the resume run; single client `fetch()` in fetchLog;
   pool scheduled workId 3 exactly once; `downloaderEvents=[]`; final state
   correct 20/20) — still the tree's ONLY tool errors (2× TS6133 `path`/`dupes1`,
   2× eslint no-unused-vars; verified repo-wide tsc -b + eslint). `npm test`/CI red.
2. **Blocker (reconfirmed)** — the cancel→resume wire duplicate remains
   unresolved: Round-2 capture confirms it is a transparent retry below
   `fetch()` on a connection poisoned by run-1 aborts (shared global dispatcher);
   root cause still unestablished, AC-3's exact server-count assertion still
   carries the same nondeterminism (reproducible on demand via the diag).
3. **Major (reconfirmed)** — evidence doc (10:16Z, pre-review) still claims
   "6 files / 43 tests, all green" + "eslint → clean"; the delivered tree is
   7 test files / 44 tests, 1 red, 4 tool errors.

What verified clean again (reviewer re-run): all five acceptance suites
43/43 excluding the diag (happy-path hook log + server-side AcceptImage;
cancel deadline/fail-fast/'D' persistence; resume exact-count; limiter
server-side `maxInflight === 2`; filename unit + e2e custom-SaveImage);
implementation vs §7.1/§4 unchanged-good.

Next implementer: fix at (a) the transport layer — per-job dispatcher
isolation (fresh undici Agent per `DownloadChapterRunner`/job, mirroring
FMD2's per-job THTTPQueue) **or** a wire-count-tolerant AC-3 assertion with
the benign-retry reason documented in fixture + evidence; (b) delete the
diag or promote it to a bounded, documented regression test with zero tool
errors; (c) refresh the evidence doc to the delivered tree (counts, tool
status, stability runs). Do not restructure the verified-green pipeline.
