# Evidence — tsk-polished-keystone-waits (Phase-3 gate: compose e2e download → pack → library → cancel/resume → retry)

Phase-3 exit gate: the compose test stack gained the fixture manga site
container's failure-injection controls, and the Playwright phase3
project drives the three download-engine scenarios end-to-end over the
REAL stack (server + SPA + SQLite + engine vs the mock upstream).
One-command reproducibility: `bash scripts/e2e.sh --phase3`. Failure
artifacts (Playwright traces + screenshots) are retained and documented.

## Delivered

**1. Fixture site failure injection (`e2e/mock-upstream.mjs`)**

- `POST /_control/fail500 {path, count}` / `POST /_control/slow
  {path, ms, count}`: prefix-matched, hit-count-bounded injection
  rules — the first `count` requests whose path starts with `path`
  return 500 or delay `ms`. `POST /_control/reset` clears all rules;
  `GET /_control` shows the armed set; `GET /_stats` reports per-path
  request counts (`{total, paths}`) — the server request-count oracle
  the scenarios assert against. The same mock script serves BOTH modes
  (compose `e2e-mock` container, process twin on 127.0.0.1:8091), so
  the specs are mode-agnostic (`HOST_MOCK` vs `APP_MOCK_BASE` env).

**2. Scenario suite (`web/e2e/download-flow.spec.ts`, Playwright
project `phase3` in `web/playwright.compose.config.ts`)**

- **Scenario 1 — enqueue → WS progress → library → artifact**:
  Manga-page checkbox enqueue → Downloads row LIVE-patches over the WS
  feed (`queued|running` → `done`, coalesced progress `"done":3`,
  "Event stream: Live") → Library lists `Chapter 1 The Beginning.zip`
  → `GET /api/library/:id/file` → ZIP central-directory walk asserts
  exactly `001/002/003.jpg`, stored (method 0), sizes > 0.
- **Scenario 2 — cancel mid-download → resume via persisted markers**:
  24-page chapter armed with the 400 ms/image slow rule → ≥2 images
  downloaded → Cancel button in Downloads → badge + server truth both
  `cancelled` → `/_stats` proves the aborted run fetched strictly fewer
  than the whole chapter → re-enqueue (a FRESH job id) → done, and the
  DELTA `fetchedAfter − fetchedBefore < total` proves the 'D' markers
  skipped already-downloaded images (no re-fetch). Library shows the
  packed `Chapter 2 The Middle.zip`.
- **Scenario 3 — injected 500s → retry visible → recovery**: 3×500 on
  the chapter's images → the JOB retries (state history includes
  `retry` — per-image parity: a 500 fails the chapter attempt and the
  job re-enters as retry, resuming from markers) → `done` badge →
  `/_stats` shows `total + 3` GETs → Library artifact re-validated by
  central-directory walk.
- All assertions key on the DURABLE server truth (`GET /api/jobs/:id`,
  `/_stats`) at 100 ms poll granularity so transient states
  (`running`, `retry`) stay observable to the history assertions; the
  UI assertions (badge, row, library listing) prove the same truth is
  surfaced over the WS feed.

**3. One-command reproducibility (`scripts/e2e.sh --phase3`)**

- The gate runs as one more Playwright project after the Phase-2 main
  scenario on the SAME stack: build → fixture prep (now chapter pages +
  deterministic JPEGs per `e2e.json chapterPages`: ch1=3, ch2=24,
  ch3=2) → bootstrap-watch → `/readyz` → main → phase3 → evidence →
  drain asserts → teardown. Auto mode: compose stack when docker is
  available, process-mode twin otherwise (same fixtures, mock script,
  app entry, specs).

**4. Failure artifacts, documented**

- `web/playwright.compose.config.ts`: `trace: 'retain-on-failure'`,
  `screenshot: 'only-on-failure'`, output dir `FMD_E2E_TRACE_DIR`.
- `scripts/e2e.sh --phase3`: on a failed phase3 run the whole
  `FMD_E2E_TRACE_DIR` is copied to `e2e/.tmp/artifacts/playwright/`
  with a loud log line pointing at the runbook.
- `docs/runbook.md` gains the "Phase-3 e2e gate" section: the command,
  the three scenarios, and the failure-artifact procedure
  (`npx playwright show-trace …/trace.zip`, error-context.md,
  `/_requests` cross-check).
- Mechanism probe (not just config review): a deliberately-failing
  scratch spec run with the same settings produced
  `trace.zip` + `error-context.md` under `FMD_E2E_TRACE_DIR`;
  probe removed afterwards.

## Verification run (2026-11-15, process mode — docker unavailable here)

`bash scripts/e2e.sh --phase3` → **exit 0, PASS**:

```
[bootstrap-watch] › empty-state → bootstrap progress → ready      ✓ (8.7s)
[main] › browse → search → live info → dry-run → Downloads queued ✓ (1.1s)
[phase3] › scenario 1: enqueue → WS progress → library listing
          → artifact validates                                    ✓ (922ms)
[phase3] › scenario 2: slow images → cancel mid-download
          → cancelled → re-enqueue resumes via markers            ✓ (3.5s)
[phase3] › scenario 3: injected 500s → retry visible → recovers    ✓ (3.0s)
[e2e] phase3 gate green
[e2e] mock served: zipball, commits, catalog .7z, site page — the ONLY upstream traffic
[e2e] server uid=1000 (non-root)
[e2e] drain OK: exited in 70ms with flush logs
[e2e] PASS — compose e2e green (mode: process, drain 70ms)
```

Scenario 2's resume assertions are the marker proof: with the slow rule
reset after the cancel, `fetchedBefore ∈ (0, total+2)` and
`fetchedAfter − fetchedBefore < 24` passed — the resumed job re-fetched
strictly fewer than a full chapter, i.e. the persisted 'D' markers were
honored. Scenario 3's `/_stats` counter hit `total + 3` exactly as the
3×500 injection predicts, and the `retry` state was observed in the job
state history before `done`.

## Review round (in_review) — fixes landed with the final runs

The implementer's tree failed the local CI gate; the review fixed the
working tree to a fully green hand-off:

1. **Contract drift (blocked `contract:check`)**: `fmd.imagepuzzle` /
   `fmd.mangafoxwatermark` were `planned` in `contract.json` and the
   drift-check test's static fixture registry, while the REAL shim
   loader registry (the sanctioned source of truth, runtime-tested via
   real wasmoon `require` in `require-registry.test.ts`) says
   `implemented`. Flipped contract.json rows, the test fixture, and the
   `generate-compat.ts` curated tables (`bindingStatus` + `unitStatus`)
   to match; the lie-victim in the "claims MORE" drift test moved from
   imagepuzzle to the remaining shipped planned row (`fmd.strings`).
2. **Stale generated artifacts**: `docs/COMPAT.md` regenerated (GZip /
   PCRE2 / Logger / pb / ImagePuzzle / MangaFox tracker rows current);
   `registration-summary.json` re-swept — **411→412 registered files,
   6→5 failures, 98.6%→98.8%** (the FanFox failure is gone now that
   `fmd.mangafoxwatermark` serves its `require`); index synced with the
   regenerated bytes (the corpus gate's byte-stability check compares
   against the index).
3. **Lint**: scratch debug files removed (`server/.probe-health.mjs`,
   `.tmp-core-debug.mjs` at root); `pcre2-shim.ts` no-fallthrough cases
   made terminal via `return throwTranslate(...)` (typed `never` — no
   misleading fallthrough comments); `imagepuzzle-shim.ts` `let bridge`
   → `const` (never reassigned). Behavior-identical; pcre2 +
   require-registry suites re-run (53/53).
4. **Runbook**: the Phase-3 gate section (command, scenarios,
   failure-artifact procedure) added — `scripts/e2e.sh` already pointed
   at it.

Final state: `npm run ci` — **CI gate passed** (contract → lint →
typecheck → test → corpus, 912/912 = 100%); re-run
`bash scripts/e2e.sh --phase3` on the final tree — **PASS** (all three
phase3 scenarios green: 765ms / 3.4s / 2.9s, drain 67ms).
