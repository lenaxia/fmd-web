# Evidence — tsk-velvet-pulley-prosper (server/jobs/download per DESIGN §7.1: interfaces ChapterPipeline/ImageWorkerPool/SiteLimiter, the 'W'/'D' image workers, hooks, assembly — cancel + resume + the local fixture-site integration suites)

Date: 2026-11-14T10:12Z · Revised: 2026-11-14T14:45Z (Round-1/2 review
fixes: cancel→resume wire-straggler root cause + deterministic
regression, diag/scratch files removed, tree-wide tool clean) ·
Environment: node v24.20, vitest 3.2.7, undici fetch (Node global),
linux · Offline (loopback `node:http` fixture only — the repo no-network
guard is active for every test; DESIGN §13)

## Scope

`server/src/jobs/download/` — the §7.1 chapter pipeline, coded against the
three required interfaces:

- **`types.ts`** — the seam surface: `SiteLimiter` (per-host acquire with
  null-on-cancel), `ImageWorkerPool` (`run(workIds, maxThreads, worker,
  shouldStop) → PoolItemFailure[]`), `ChapterModuleHooks` (the §5.2
  download-event module surface: `taskStart? / getPageNumber /
  getImageURL / beforeDownloadImage? / saveImage? / afterImageSaved?` —
  `undefined` method = handler not bound, FMD2 `Assigned(OnX)`),
  `TaskWriter` (the module-writable TASK view, LuaDownloadTask.pas:21-32),
  `ImageDownloader`, `CancelToken`.
- **`site-limiter.ts`** — `PerHostSiteLimiter implements SiteLimiter`
  (FMD2 `THTTPQueue` / `MaxConnectionLimit`; limit 0 = unlimited): FIFO
  slot queue per host with direct slot hand-off on release, §4
  cancellation — `cancelAll()` resolves every queued waiter with null
  (queued-but-unstarted → fail fast) while granted slots are untouched;
  single-job lifetime (after cancelAll every acquire fails fast).
- **`image-worker-pool.ts`** — `ConcurrentImageWorkerPool implements
  ImageWorkerPool` (FMD2 `TDownloadThreads` + `Checkout`,
  uDownloadsManager.pas:870-920): `MaxThreadPerTaskLimit` concurrent
  workers pulling a FIFO of work ids (the `InternalGetDownloadWorkId`
  cursor), `shouldStop` stops scheduling queued-but-unstarted items, a
  throwing worker is isolated and reported per item.
- **`filenames.ts`** — `composeFileName` (FMD2 `TTaskThread.GetFileName`,
  uDownloadsManager.pas:530-550): FileNames[] entry when
  `FileNames.Count = PageLinks.Count`, `%.3d` index fallback, the
  `%FILENAME%` custom-rename template (`CR_FILENAME`,
  FMDOptions.pas:26; empty template defaults to it, :1112-1114), then
  tail-truncation when `CurrentMaxFileNameLength > 0` (Delete from the
  HEAD — the TAIL survives; D5 Windows-parity by choice on Linux).
- **`image-files.ts`** — the host-default save path: `extFromContentType`
  (GetImageStreamExt), `findImageFile` (any-known-image-ext existence
  probe — the CheckForExists resume source), `saveImageStreamToFile`
  (tmp-write + rename atomic save; empty bytes or unknown type → '' =
  the FMD2 failure contract).
- **`marker-store.ts`** — 'W'/'D' PageLinks persistence: atomic JSON
  write (tmp+rename) in the chapter work dir; `readMarkers` returns
  undefined for absent/corrupt/non-array payloads (resume falls back to
  the file-on-disk reconciliation instead of throwing).
- **`http-downloader.ts`** — `HttpImageDownloader implements
  ImageDownloader` (FMD2 `DownloadImage` :367-378 — `HTTP.Reset;
  HTTP.AcceptImage; HTTP.GET`): the §5.4 Reset default set +
  `Accept: image/webp,*/*` (reused verbatim from
  `engine/shims/http-headers.ts`), the request-side UA insert, the
  per-site limiter slot around every hop, the transport retry loop
  (no-response / status `> 500` bounded by the per-image retry budget —
  httpsendthread.pas:623-629), and §4 cancellation: the cancel signal
  aborts in-flight hops (`AbortController`), queued limiter waiters get
  null → the hop fails fast.
- **`download-runner.ts`** — `DownloadChapterRunner` + `JobCancelToken`:
  the §7.1 flow — TaskStart? → GetPageNumber (module sets
  TASK.PageNumber + PageLinks[] through the TaskWriter) →
  `prepareFromPageNumber` + `PageNumber := PageLinks.Count` (:1196-1198)
  → resume (persisted-'D' marker overlay, then
  `ChapterPipeline.reconcileWithFiles` — files on disk are the truth,
  :1040-1063) → assembly backfill (every already-done slot contributes
  its on-disk file — the Compress phase packs the whole chapter) →
  CS_GETPAGELINK phase (`beginPhase` cursor reset per phase, :1268-1272;
  `nextPagelinkWork` → GetImageURL per waiting slot → `applyPagelink`)
  → CS_DOWNLOAD phase (`nextDownloadWork` → per image: marker
  short-circuits :351-359 → BeforeDownloadImage (URL rewrite via the
  seam return — FMD2's URL global is push-only) → downloader.download →
  SaveImage module hook, else host default writer →
  FileExists re-check :403-404 → markDone 'D' + marker persist →
  AfterImageSaved) → verdict (`CheckForFinish` :1067-1111): done /
  cancelled (cancel fired before finish) / failed. Result carries the
  WorkId-ordered `savedFiles` (module FileNames[] order = the assembly
  order), per-image `failures`, done/total.

The pipeline reuses `engine/pipeline/chapter-pipeline.ts`
(`ChapterPipeline` — the 'W'/'D' resume contract) unchanged.

`server/test/jobs/download/` — the suites (7 test files + the fixture,
44 tests):

- **`fixture-site.ts`** — `FixtureMangaSite`: a LOCAL `node:http` manga
  site on `127.0.0.1:0` serving a RECORDED chapter page (a real corpus
  seed body, `corpus/fixtures/seed/Hentai2Read/source.html`) and
  deterministic synthetic images, with the server-side counters the
  tests assert on: per-path request counts (resume proof), a live
  in-flight tracker + observed peak (limiter proof), and the
  deliberately misbehaving handlers — flaky (502-then-200 per path —
  the FMD2 retry covers `> 500` only), route-changing (the image only
  exists under the BeforeDownloadImage-rewritten `-v2` path), and slow
  (cancellable in-flight downloads). Also **`waitSettled()`** — the
  bounded wire-quiescence gate every post-cancel request-count sample
  goes through (see the review-resolution section below for why).
- **`download-runner.integration.test.ts`** — the §7.1 integration
  suites with a hook-logging module double (`HookLogModule`): happy
  path, cancel deadline, resume fetch counts, parallel-chapter limiter
  bound, URL rewrite, custom SaveImage filename, per-image retry (7
  tests). Both post-cancel suites sample counts only after
  `waitSettled()`.
- **`cancel-resume-determinism.test.ts`** — the Blocker-2 regression:
  30 bounded cancel→resume cycles asserting the wire-straggler
  invariant deterministically (exact remaining-fetch count, exactly
  once per remaining path, 'D' contract — details below).
- **`filenames.test.ts` / `image-files.test.ts` /
  `site-limiter.test.ts` / `image-worker-pool.test.ts` /
  `marker-store.test.ts`** — the unit suites (36 tests: 12 + 3 + 9 + 7
  + 5).

## Acceptance criteria → evidence

| Criterion | Evidence | Status |
|---|---|---|
| Happy-path integration test: recorded 20-image chapter downloads in FileNames/PageLinks order with all module hooks invoked (hook-call log asserted) | `download-runner.integration.test.ts` "happy path" (threads=1): `HookLogModule` binds all six §5.2 hooks; GetPageNumber FETCHES the recorded chapter page from the fixture site (200 required). Asserted: `state=done`, `done=total=20`, `failures=[]`; the hook-call log is `taskStart → getPageNumber(chapter URL) → getImageURL×20 (CS_GETPAGELINK phase, WorkId order) → [beforeDownloadImage → saveImage → afterImageSaved]×20 (CS_DOWNLOAD phase, WorkId order)`; afterImageSaved received the assembled saved path of its image; assembly keeps module FileNames[] order (`savedFiles[i] = workDir/page-XX.jpg`, each on disk); exactly one request per image with the `Accept: image/webp,*/*` (ACCEPT_IMAGE_VALUE) header captured server-side. | met |
| Cancel test: cancel mid-download → workers stop ≤ deadline, queued requests fail fast, 'D' markers persisted | "cancel mid-download" test: slow fixture (150 ms/image), limiter 2, pool 3 → wait until ≥3 requests started server-side → `runner.cancel()` → the run resolves in **< 1500 ms deadline** (elapsed asserted), `state=cancelled`, `1 ≤ done < 20`. The run then `waitSettled()`s the fixture (a cancelled in-flight request's bytes may already have crossed the wire — see the review-resolution section) and the server-side request count is FROZEN after cancel + 300 ms grace (no new requests land — in-flight aborted via the abort signal, limiter-queued waiters resolved null, pool-queued items skipped by `shouldStop`). `readMarkers(dir)` holds exactly `result.done` 'D' entries and every completed file exists on disk. | met |
| Resume test: restart after cancel → only remaining images fetched (server request-count asserted) | "resume after cancel" test: after the cancelled first run (markers persisted to the work dir) and `waitSettled()` (the baseline is sampled only after every run-1 handler quiesced, so no cancelled in-flight arrival can leak into the resume window), a fresh runner starts with `resumeMarkers: readMarkers(dir)` and a fresh limiter (a cancelled limiter is single-job/terminal). Asserted: `state=done`, `done=20`, and `site.countFor('/img/') − before == 20 − doneFirst` — EXACTLY the remaining images were fetched; the final assembly holds all 20 files on disk (resumed slots backfilled from disk by the runner's assembly pass). The count is deterministic, not probabilistic — pinned further by the Blocker-2 regression suite (30 cycles, exact count + exactly-once per path). | met |
| Site limiter: per-host concurrency never exceeds configured limit under parallel chapters (server-side counter asserted) | "site limiter" test: THREE chapters run in parallel (`Promise.all` of three runners, each `maxThreadPerTaskLimit: 4`) sharing ONE `PerHostSiteLimiter` with the fixture host limited to 2; the fixture's server-side in-flight tracker asserts `maxInflight === 2` — the bound is never exceeded AND is actually saturated; all three chapters finish `done` (8/8 each). | met |
| Module filename flow: SaveImage return + FileNames[] + template + tail-truncation compose correctly (unit tests) | `filenames.test.ts` (12 tests): FileNames[] honored only when `FileNames.length === pageCount` (else `%.3d` index, 999→'1000'), empty entries fall back to the index; the `%FILENAME%` template replaces EVERY occurrence (multi-placeholder input), an empty template defaults to `%FILENAME%` (:1112-1114), FileNames entries ride through the template (:531→:542 order); tail-truncation keeps the TAIL (`page-%FILENAME%` @5 → 'e-001'), maxLength 0 = no limit, exact-length is a no-op, truncation applies AFTER template expansion. The SaveImage-return path is composed end-to-end in "SaveImage custom filename is honored end-to-end": module `saveImage` returns `custom-name-007.img` for the composed name '007' → the runner keeps the custom path in `savedFiles[6]`, the file exists on disk, and AfterImageSaved received it (defaults stay `001.jpg`). | met |

## Review Round 1+2 blockers — resolution

### Blocker 1 (red diagnostic file) — resolved by removal + replacement

`diag-resume-race.test.ts` (and the temporary `scratch-rootcause.test.ts`
harness it fed) are **deleted from the tree**. Their investigation is
complete: the root cause is established (below) and pinned by
`cancel-resume-determinism.test.ts` — a bounded, documented regression
with zero tool errors. `npx tsc -b` and `npx eslint .` are clean
repo-wide (the tree has no tool errors anywhere).

### Blocker 2 (cancel→resume wire-level duplicate) — root cause established; engine correct; tests fixed

Instrumented wire capture (undici diagnostics channels
`undici:client:sendHeaders` + `undici:request:error` + server-side
connection/request log, looped until reproduction) — captured trace:

- Resume-window server arrivals: `["/img/p3", "/img/p2", "/img/p3",
  "/img/p4", …]` — the first `/img/p3` lands **before** the resume
  run's first dispatch (`SEND /img/p2 +3ms, SEND /img/p3 +4ms`).
- The resume downloader issues exactly ONE hop per image (single
  success, no error hop, no dispatcher-level retry — undici 8's
  Client/Pool/Agent do not transparently retry, verified in the
  installed `node_modules/undici/lib/dispatcher/*` and
  `lib/web/fetch/index.js`).

**Root cause**: the duplicate is run-1's OWN in-flight request. At
cancel time the `p3` fetch had just been dispatched (the FIFO
pool/limiter grant it the slot freed by `p1` in the same few ms the
3rd server arrival trips the cancel); `AbortController.abort()` then
destroys the client socket — but the request BYTES were already
written and loopback delivers them: the server parses the request and
records the arrival a few event-loop turns AFTER the cancelled run's
promise settles, i.e. inside the test's resume-window baseline. TCP
cannot unsend (FMD2 `THTTP.Terminate` has the same property); the
engine is correct per DESIGN §4 — the cancelled request is never
marked 'D' and resume re-fetches that image exactly once, which is why
every observed mismatch still ended `done=20`, on-disk 20/20.

**The defect was in the TESTS, not the pipeline**: request-count
baselines were sampled on the client immediately after `await run`,
racing the server's late parse of the already-aborted request (~1–4 of
25 iterations in the old diag). Fix, at the right layer:

- `FixtureMangaSite.waitSettled()` — bounded handler-quiescence gate
  (documented on the class and the method): an arrival's handler must
  finish before quiescence resolves, and parse-vs-close races resolve
  within that window on loopback — so every arrival recorded after
  `waitSettled()` deterministically belongs to the next run.
- Both post-cancel integration suites (cancel + resume) now
  `waitSettled()` before sampling counts. The cancel suite's frozen
  count had the same latent race (a straggler inside its 300 ms grace
  window would fail it) — fixed the same way.
- `cancel-resume-determinism.test.ts` pins the invariant: 30
  cancel→resume cycles, each asserting (a) exact remaining-fetch count,
  (b) exactly once per remaining path / no other path touched (sorted
  multiset — pool arrival order is nondeterministic by design), (c) all
  20 'D' markers persisted after resume. Green across repeated runs
  (≥6 consecutive full-suite runs + 8 standalone runs = >240 cycles,
  zero mismatches).

The pipeline (`server/src/jobs/download/*`) is unchanged by this fix —
the verified-green implementation was not restructured.

## Implementation notes

- **Phase cursor reset**: FMD2 resets `WorkCounter/DownCounter` at EVERY
  phase transition (:1268-1272 for CS_DOWNLOAD). The runner calls
  `pipeline.beginPhase()` before each drain — a single reset before the
  pagelink phase leaves the download drain with an exhausted cursor
  (caught by the integration suites: zero image requests, instant
  'failed').
- **Flaky fixture uses 502, not 500**: the FMD2 transport retry covers
  `ResultCode > 500` only (:623-629) — mirrored verbatim in
  `HttpImageDownloader`; a 500 is terminal by design, so the
  deliberately-flaky handler flips to 502-then-200.
- **BeforeDownloadImage URL rewrite**: FMD2 pushes the URL global
  push-only (never read back — §5.2), so modules rewrite via TASK
  side effects; the fmd-web seam makes it explicit — the hook returns
  the (possibly) rewritten URL, undefined keeps it. The route-changing
  fixture handler 404s the original path and serves only `-v2`, so the
  test proves the rewrite actually drove the request (original path:
  zero requests).
- **Resume composition**: persisted-'D' overlay + file reconciliation
  compose — the overlay survives marker-file-only state, the file probe
  survives marker loss; `reconcileWithFiles` demotes 'D'-without-file
  back to 'W' so such slots re-download. Already-done slots are skipped
  by the download scan, so the runner backfills `savedFiles` from disk
  for every 'D' slot after reconciliation (assembly completeness —
  FMD2's Compress packs the whole chapter, not just this run's images).
- **Assembly holes**: parallel completion order fills `savedFiles`
  sparsely; the result builder normalizes holes to '' so the
  WorkId/FileNames[]-ordered array is always dense.
- **Limiter lifetime**: `PerHostSiteLimiter.cancelAll()` is terminal
  (single-job semantics documented on the interface) — the resume test
  initially reused the cancelled limiter and failed fast on every
  acquire; a new job constructs a new limiter.
- **Post-cancel sampling discipline** (new): any request-count sampled
  after a cancel goes through `FixtureMangaSite.waitSettled()` first —
  see the review-resolution section.

## Verification

- `npx vitest run server/test/jobs/download/` → **7 files, 44 tests,
  all green** (integration 7/7, determinism regression 1/1 over 30
  cycles, units 36/36), stable across **5 consecutive runs**; the
  determinism suite additionally green in 8 standalone runs (>240
  cancel→resume cycles total, zero mismatches).
- Full repo `npm test` → **108 files / 1095 tests, all green**.
- `npx tsc -b` → exit 0, **zero errors repo-wide**.
- `npx eslint .` → exit 0, **zero errors repo-wide**.
- Offline discipline: every test suite runs against loopback only (the
  repo no-network guard active; DESIGN §13).
