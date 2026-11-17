# Evidence — Manga Page Parity (FMD2 info pane, tsk-basic-carousel-wiggles)

FMD2 `pcInfo/tsInfoManga` vs the web MangaPage: cover, Read-online,
add-to-favorites, Save-to, add-as-stopped, and the full chapter-list
toolbar. Ground truth (verified in FMD2 source this session): cover
thumbnail with loading anim (`frmMain.lfm:962` imCover), btReadOnline
opens the manga URL (`:3060`), btAddToFavorites (`:2797`),
cbAddAsStopped (`lfm:1110`), edSaveTo + per-website override
(`pas:5613`), pmChapterList (`lfm:1649-1703`) — check/uncheck
selected|all, HIDE-downloaded toggle, case-insensitive substring
Filter box (`pas:1939`), Ascending/Descending (`pas:1552`), downloaded
chapters highlighted in-list (`pas:3156`).

## What landed

### 1. Cover + Read online (info card)

- `web/src/components/manga/CoverImage.tsx` — lazy (`loading="lazy"`,
  `decoding="async"`) cover from §5.8 `info.coverLink`; pulse skeleton
  while loading; broken/empty covers degrade to a "No cover"
  placeholder (role=img), never an empty box.
- Read online: external link (`target="_blank"` `rel="noopener"`) on
  `info.url` (btReadOnline parity).

### 2. Add to favorites (the EXISTING hook, now wired)

- `web/src/api/hooks.ts` `useFavoriteState(moduleId, url)` — membership
  derived from the favorites LIST (match on moduleId+url; the id is
  `LowerCase(ModuleID+Link)` server-side), toggling through the
  pre-existing `useCreateFavorite` / `useDeleteFavorite` hooks with
  list invalidation. Button: `Add to favorites` → `In favorites`
  (click removes) with `aria-pressed`; membership also unlocks
  **Select new** (FMD2: needs the favorite's downloaded list).
- Unblocks: favorites lifecycle (favorites-parity story), browse row
  actions (list-polish story).

### 3. Chapter toolbar (pmChapterList parity)

- `web/src/state/chapter-view-state.ts` — the pure state machine:
  case-insensitive substring filter (name OR link), hide-downloaded,
  asc/desc presentation toggle, invert-on-visible, select-new
  (chapters absent from the downloaded ledger — favorited only),
  case-insensitive downloaded membership (ASCII LowerCase parity with
  the server's MergeCaseInsensitive ledger semantics).
- `web/src/components/manga/ChapterToolbar.tsx` (FilterBar pattern):
  filter box, Ascending/Descending (aria-pressed), Hide downloaded,
  Invert, Select new, Select all, Clear + "N shown · M downloaded".
- Downloaded chapters tinted in-list (`pas:3156`): row
  `data-downloaded="true"` + `bg-primary/5` + a `downloaded` badge —
  membership from the API-provided set.

### 4. Downloaded set via /api/info (embed chosen — one call)

- `InfoResponse.downloaded: string[]` — the §9 `downloaded_chapters`
  ledger projection for (moduleId, url), computed at RESPONSE time and
  never cached with the info snapshot (a finished download flips the
  set on the next call, cache hit or not — proven by
  `server/test/api/info-downloaded.test.ts`).
- Server seam: `LibraryService.downloadedChapters(moduleId, url)`
  (`SqliteLibraryService` → `SqliteLibraryStore.getDownloadedChapters`
  → splitTextLines; in-memory double with a test seed hook).

### 5. Enqueue options: Start paused + Save to

- `web/src/components/manga/EnqueueOptions.tsx` — cbAddAsStopped
  checkbox + edSaveTo input; the save-to value persists per manga
  (localStorage `fmd:saveto:<module>|<url>`) and is recalled on
  reopen. Both ride the dry-run preview AND the POSTed bodies
  (`dry-run.ts` + `useCreateDownloadJob` pass-through; defaults omit
  the keys entirely).
- API (additive, zod + OpenAPI + client regen):
  `POST /api/jobs/download {paused?, saveTo?}`; new
  `POST /api/jobs/:id/resume`.
- Paused semantics (§4/§9): the SQLite queue gains a `paused` column
  (additive migration in `ensureJobSchema`); the claim transaction
  skips `paused=1` rows (`WHERE … AND paused = 0`) — the job is
  created **queued** but never auto-run until resume lifts the hold.
  `Job.paused?: boolean` on the REST/WS wire (contract JobSchema).
  Resume: 404 unknown / 409 terminal / idempotent no-op when live.
- saveTo semantics (edSaveTo parity): rides the job payload;
  `FinalizeRequest.saveTo` REPLACES the
  `<libraryRoot>/<module>/<manga>` prefix (relative → resolved against
  the library root; absolute verbatim); §7.1 file-name sanitization
  kept either way.

## Verification (this session, all green)

- `npm run typecheck` — 0 errors. `npm run lint` — clean.
- `npm test` — **180 files / 1802 passed | 3 skipped** (was 174/1760):
  - NEW `server/test/api/jobs-paused-saveto.test.ts` (7) — paused
    create/hold/replay-conflict, resume round-trip + 409/404 guards,
    saveTo payload echo, paused+saveTo composition.
  - NEW `server/test/api/info-downloaded.test.ts` (4) — embed, per-manga
    keying, response-time freshness past the info cache.
  - NEW `server/test/jobs/queue-paused.test.ts` (6) — claim-skip (FIFO
    looks PAST a held row), resume→claim, guards, and the LaneRunner
    integration: a live lane completes the sibling while the paused row
    stays queued, then runs to done after resume (FakeClock-driven).
  - NEW `server/test/jobs/library/finalize-saveto.test.ts` (6) —
    default-path regression, relative/absolute overrides, atomic commit
    under saveTo, §7.1 sanitization preserved.
  - NEW `web/test/chapter-view-state.test.ts` (10) — filter × hide ×
    sort compositions, invert-on-visible, select-new gating, ASCII
    case-insensitive membership.
  - NEW `web/test/manga-parity.test.tsx` (9) — cover lazy+fallback,
    read-online attrs, favorites round-trip (stateful mock: POST →
    membership → DELETE), tinting, filter/hide/asc-desc/invert/
    select-new behaviors, enqueue extras in preview AND POST bodies,
    per-manga save-to persistence.
- `npx playwright test` (web) — **20 passed** incl. the 3 NEW
  `web/e2e/manga-parity.spec.ts` specs: favorites round-trip,
  downloaded tint + hide-downloaded visual state, asc/desc flip +
  paused:true on the wire.
- OpenAPI regenerated (`API_OPENAPI_SNAPSHOT=write vitest run
  server/test/api/openapi.test.ts`) — snapshot now carries
  `/api/jobs/{id}/resume`, `InfoResponse.downloaded`, `Job.paused`,
  `createDownloadJob.saveTo`; typed client regenerated
  (`npm run gen:api -w @fmd/web`); `web/test/api-drift.test.ts` green
  (snapshot ↔ client in lockstep).

## Deliberate scope notes

- DownloadsPage resume button for paused rows: NOT added — the
  acceptance criteria prove the contract through the API/queue
  integration; the Downloads-page surface belongs to the list-polish
  story. The wire already carries `paused` so that story needs zero
  server work.
- 'Start paused' create semantic: state stays `queued` (FMD2's stopped
  download = not running until started); the hold is the `paused`
  flag — an additive column, not a new state-machine state, so the
  persisted §7.1 transitions and WS frames are untouched.
- Filter matching is contains/substring (FMD2 `pas:1939` semantics);
  no regex, no prefix modes.
