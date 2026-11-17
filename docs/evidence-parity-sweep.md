# Evidence — Parity sweep ([parity-sweep], tsk-orient-toybox-reviews)

Scope: docs/UX-PARITY.md Part 4 (binding) — the genre `!`-exclude defect fix
(audit (b)2), Settings groups M2/M4/M5/M6/M8/M10/M12/M13, open-by-URL (M14),
and the UX-PARITY Part 2/Part 4 refresh. All tests offline (fake clocks /
in-memory doubles / intercepted routes) except the Playwright specs (loopback
+ intercepted routes — no network).

## 1. Genre `!`-exclude correctness (audit (b)2 — defect fix)

The V1 parser STRIPPED the `!`/`-` prefix and fed the genre into the INCLUDE
list (typing `!Ecchi` INCLUDED Ecchi — inverted semantics). Fixed end-to-end:

- **Parser** (`web/src/state/browse-filter-state.ts`): `parseGenreEntries`
  preserves the prefix into a separate `excludes` list;
  `parseCustomGenresSplit` resolves collisions exclude-wins (mirrors FMD2
  unchecking the box). State carries `excludedGenres`; `apiGenresExclude`
  feeds `genresExclude[]` to both the per-site and all-sites queries
  (`web/src/api/hooks.ts`, `web/src/state/use-catalog-query.ts`).
- **Regression test** (`web/test/browse-filter-state.test.ts`:
  "REGRESSION (audit (b)2): the ! prefix EXCLUDES, never includes") fails on
  the old parser (it returned `['Ecchi']` as an include; the new assertion
  requires `{includes: [], excludes: ['Ecchi']}` — a shape the old parser
  could not produce).
- **SQL composition matrix** (`server/test/sync/db/catalog-store-search-filters.test.ts`,
  describe "genre excludes — real SQL composition matrix"): exclude-only
  `NOT LIKE` (no include clause); includes ANY `[A,B]` + exclude `[C]` →
  `(A OR B) AND NOT C`; includes ALL `[A,B]` + excludes `[C,D]` →
  `(A AND B) AND NOT C AND NOT D`; excludes AND among themselves; collision →
  exclude wins (documented in `composeRowFilters`'s doc matrix); contains
  semantics (`'med'` matches `Comedy`); LIKE wildcards escaped in excludes;
  composes with q (FTS) + newDays; cursor binds the exclude list (reuse
  under a changed exclude set throws).
- **Route-level wire forms** (`server/test/api/catalog-search-filters.test.ts`):
  `genresExclude` repeated-param + csv forms; q-optional when only excludes
  are set; cursor reuse under changed excludes → 400. The all-sites union
  (`/api/search`) carries `genresExclude` through `UnionSearchInput` +
  its cursor fingerprint (`server/src/api/search-service.ts`). The §6.8
  live-scrape fallback store mirrors the semantics
  (`server/src/catalog/live-scrape-store.ts` + helpers' in-memory double).
- **Chips**: excluded genres render a distinct `None of: …` chip —
  strikethrough + muted + `data-excluded="true"`; removal clears only the
  exclude list (`web/test/parity-sweep-ui.test.tsx`).
- **URL round-trip**: `cgenres` carries the FMD2 grammar (excludes
  serialize `!`-prefixed; `-` parses equivalently) — round-trip test in
  `web/test/browse-filter-state.test.ts`.
- **Playwright** (`web/e2e/parity-sweep.spec.ts`): typing `!Ecchi` in the
  custom-genres box renders the distinct chip and the URL carries
  `cgenres=%21Ecchi`; removing the chip clears both.

## 2. Settings groups (all on the Settings page, every control PUTs a real
server setting — no dead controls)

Additive API: `PUT /api/settings/{performance,retention,filename-policy,diagnostics}`
+ the output-defaults itemized subset on the existing
`PUT /api/settings/output`. `GET /api/settings` returns all groups; groups
persist in app.db (`app_settings` kv) via the assembly seeds/sinks
(`server/src/runtime/assembly.ts`, `setParitySweepSettingsLive`). OpenAPI
snapshot + web client regenerated (`api:snapshot` + `gen:api`).

- **Performance (M10)** — `server/src/api/schemas.ts`
  `PerformanceSettingsSchema`; honored-in-behavior:
  - request timeout seeds the HTTP pipeline default
    (`setDefaultRequestTimeoutMs`, `HttpPipeline.timeout` seeded at
    construction — real-pipeline test in
    `server/test/jobs/output-rename-options.test.ts`; module per-request
    override still wins);
  - retry count = the per-image retry budget (read per-job in the lane);
  - threads-per-chapter = the image-worker width (read per-job);
  - parallel chapters = the download-lane slot count, fixed at LaneRunner
    start (documented restart-to-apply; lane-options tested in
    `server/test/runtime/download-lane-knobs.test.ts`);
  - lane thread-caps SKIP (UX-PARITY M10).
- **Output defaults itemization (M5/M6/M8)** — `OutputDefaultsSchema` +=
  unicodeReplacement + unicodeReplacementChar + digitPadding +
  removeMangaName; honored in the download lane: `applyOutputRenameOptions`
  (strip manga-title prefix, replace non-ASCII runs) before the final
  truncation; `indexFileName(workId, padding)` sets the minimum page-name
  width in archive entries. Unit matrix:
  `server/test/jobs/output-rename-options.test.ts`. Auto-folder toggles +
  WebP-target/JPEG-quality SKIP (UX-PARITY M6/M8, with reasons).
- **Job-history retention (M2)** — `PUT /api/settings/retention {days}`
  (0 = keep forever); the queue takes a live `retentionMs` provider and the
  assembly schedules an HOURLY prune sweep + a boot sweep (previously
  nothing scheduled `pruneRetention`). Fake-clock matrix
  (`server/test/jobs/retention.test.ts`): live 7-day window honored at the
  boundary, window re-read every prune (change applies next sweep), 0 and
  negative = keep forever.
- **Filename policy (M4)** — checkbox (Linux-normalized vs desktop-parity);
  precedence `FMD_NORMALIZE_PATHS` env > setting > parity composed in
  assembly (`envNormalize ?? setting-mode`), threaded into the lane's
  `resolveChapterFileName` mode. UI notes the env override.
- **Diagnostics (M13)** — log enable + minimum level applied LIVE to the
  running StructuredLogger (filter behavior-tested); links to /metrics +
  the runbook; live viewer = v0.4 note in the UI.
- **About (M12)** — server version from `GET /healthz` (live), links to
  CHANGELOG.md / GitHub releases / repo; donate/blog SKIP.
- **Round-trip + validation tests**: `server/test/api/settings.test.ts`
  (defaults mirror the pre-settings server truth: 15s/2/1/1, 30d, parity
  filenames, logs on at info; every PUT round-trips; out-of-range 400s;
  legacy output bodies keep working via zod defaults).
- **UI tests**: `web/test/parity-sweep-ui.test.tsx` (sections render, PUT
  payloads verified, About version + links). e2e fixtures mock
  `/api/settings` + `/healthz` deterministically.

## 3. Open-by-URL (M14 — FMD2 edURL paste-and-go parity)

- `POST /api/info` extended additively: `moduleId` OPTIONAL; a url-only
  body resolves the module by RootURL host match
  (`resolveModuleByHost` — case- and port-insensitive). Unknown host →
  typed `400 no_site_match` ("no site matches this URL"); multiple sites
  on one host → `400 ambiguous_site` naming candidates. The response
  embeds the serving `moduleId` (client navigation). New error codes added
  to the ApiError envelope enum (client regenerated).
- **Host-resolution matrix** (`server/test/api/info.test.ts`): url-only
  resolves + serves + returns the resolved id; case/port-insensitivity;
  unknown host typed error (no engine call); ambiguous host names both
  candidates (no engine call); explicit moduleId wins; url-only responses
  cache under the RESOLVED (moduleId,url) key.
- **UI**: `OpenByUrlInput` on the Browse picker ("Paste a manga URL…");
  success navigates to `#/manga?module=<resolved>&url=…&title=…`; typed
  errors surfaced verbatim; Ctrl+Shift+V reads the clipboard and goes.
  Component tests in `web/test/parity-sweep-ui.test.tsx`; Playwright in
  `web/e2e/parity-sweep.spec.ts` (paste-and-go navigates, unknown host
  shows the typed error without navigating, Ctrl+Shift+V honored with
  granted clipboard permissions).

## 4. UX-PARITY refresh

- Part 2 rewritten as the v0.3.0-complete snapshot (staleness banner
  removed; browse/picker/settings lines describe the landed tree).
- Part 3 genre row: LANDED (defect fixed; v0.4 note now only the per-genre
  tri-state checkbox UI).
- Part 4: every M1–M16 row carries its landed disposition
  (IMPLEMENTED / SPLIT / SKIP-with-reason); self-check against the audit's
  M-list appended — zero 'undocumented' rows remain.

## 5. Gate status

Run at story completion (shared working tree — two other stories were
mid-landing during this sweep):

- contract:check — **PASS** (`contract drift-check: OK — 0 mismatches`)
- corpus — **PASS** (`912/912 = 100.00%`, `corpus gate passed: >=99% with zero undocumented mismatches`)
- lint — **PASS** for every [parity-sweep]-touched file
- typecheck — **PASS** for every [parity-sweep]-touched file (server + web +
  contract); the residual tree-wide errors at run time were the parallel
  stories' in-flight files (favorites batch-transfer, favorites page
  components), outside this story's scope
- tests — full suite at landing: **1945 passed / 1952** (3 failing + file-level
  drain skip are the parallel [downloads-parity]/[favorites-parity] in-flight
  files; every suite this story touched is green):
  browse-filter-state, catalog-store-search-filters (SQL matrix),
  catalog-search-filters (routes), settings (round-trips + defaults),
  info (M14 host-resolution matrix), retention (fake clock),
  output-rename-options, download-lane-knobs, parity-sweep-ui (9/9),
  pagination (picker assertion updated for the open-by-URL input)
- OpenAPI snapshot + web client regenerated (`api:snapshot` + `gen:api`;
  snapshot byte-for-byte test green)
- Playwright — `web/e2e/parity-sweep.spec.ts` **4/4** (paste-and-go
  navigates, unknown host typed error, Ctrl+Shift+V, exclude-chip distinct
  rendering + URL round-trip)
- visual — settings fixtures regenerated for the new sections
  (`e2e:visual:update`, intentional diff), gate **12/12** in the same window
  (browse fixtures also refreshed for the coalescing [browse-list-polish]
  work in the shared tree)
