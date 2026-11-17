# Evidence — browse-list polish (tsk-primal-okra-tramps)

FMD2 manga-list affordances on the browse entry rows: the §5.8 metadata
hover popover (`vtMangaListGetHint`), new/completed row accents +
persisted highlight-new toggle (`vtMangaListBeforeCellPaint` /
`miHighlightNewManga`), and the row overflow menu (`pmMangaList`) with a
new **batch download-all jobs API**. All FMD2 line references verified
against `/workspace/FMD2/mangadownloader/forms/frmMain.{pas,lfm}`.

## FMD2 source anchors (verified in-tree)

| Affordance | FMD2 evidence | Web adaptation |
|---|---|---|
| Metadata tooltip | `vtMangaListGetHint` frmMain.pas:5161-5226 — Website line leads in all-sites mode (:5166-5170), then Title always, then AltTitles/Authors/Artists/Genres/Status/Summary each only when non-empty (:5172-5226) | Radix HoverCard popover, catalog data ONLY (no fetch on hover) — `EntryMetadataPopover` |
| Row coloring | `vtMangaListBeforeCellPaint` frmMain.pas:5114-5152 — new paint gated on `miHighlightNewManga.Checked` AND `JDN > OptionJDNNewMangaTime`; completed paint UNGATED and applied LAST (overrides new) | `entryAccent()` in `CatalogEntryRow`: `data-accent="new|completed"` + `new` badge; completed overrides new exactly like the paint order |
| Highlight-new toggle | `miHighlightNewManga` frmMain.lfm:5817, click handler pas:2465-2468, persisted `settingsfile 'general'/'HighlightNewManga'`, default **True** (pas:5820) | `useHighlightNew` — module store + localStorage `fmd.highlight-new`, default ON; list-level FilterBar checkbox (`HighlightNewToggle`), global across site browse AND all-sites union (FMD2's setting is global) |
| New-manga window | `OptionJDNNewMangaTime := currentJDN - OptionNewMangaTime` pas:6330; default window 1 day (pas:5953) — the SAME setting feeds cbOnlyNew and the paint | The filter's only-new `newDays` (URL `new=`) is the window; FMD2 default 1 day when no filter window is active (`isNewEntry` — same Gregorian JDN math as the server's `dateToJdn`, uBaseUnit.pas:2740 parity) |
| Row context menu | `pmMangaList` frmMain.lfm:5787-5820: View manga infos / Download all / Add to Favorites / Delete / — / Highlight new manga | `EntryRowMenu` (DropdownMenu, ⋮ trigger): **Open / Download all chapters / Add to favorites**. Delete-local-list deferred (UX-PARITY.md Part 3); the in-menu highlight toggle moved to the list-level control (web pattern, owner adaptation ruling) |

## What shipped

### 1. Batch download-all jobs API (additive) — server

`POST /api/jobs/download/batch` (`createDownloadJobsBatch`):

- Request: `{moduleId, mangaUrl, mangaTitle?, chapters: 'all' | [links], idempotencyKey (REQUIRED), paused?, saveTo?}`.
- `chapters:'all'` resolves the live chapter list through the SAME cached §5.8 info
  path `POST /api/info` uses (`instrumentInfo` + `InfoResponseCache`); explicit
  selections enqueue verbatim with **no info fetch**.
- Per-chapter creates reuse the §10 idempotent `createDownload` with derived keys
  `<batchKey>:<index>` (index in resolved chapter order): whole-batch replay while
  live returns the SAME jobs (200 + `replayed:true` — the double-submit guard);
  a changed chapter sequence under the same key surfaces the per-chapter 409;
  terminal originals chain re-downloads (`<key>:<i>#<n>`) exactly like the single
  create. `paused`/`saveTo` apply to every chapter job.
- LLD decision honored: server batch endpoint (one request per manga, single
  idempotency key per manga) over chatty per-chapter client loops — matches
  FMD2's one-task-per-manga mental model.
- Files: `server/src/api/schemas.ts` (`JobBatchCreateRequest/ResponseSchema`),
  `server/src/api/app.ts` (route), `server/src/api/openapi.ts` +
  `routes.ts` (documentation/inventory), `openapi.snapshot.json` regenerated,
  web client regenerated (`npm run gen:api -w @fmd/web` → `openapi.d.ts`).
  Additive only — no existing shape changed.

### 2. Web affordances

- `web/src/components/ui/hover-card.tsx` — Radix HoverCard primitive
  (unified `radix-ui` package, matches the vendored dropdown-menu pattern).
- `EntryMetadataPopover` — §5.8 sections from catalog fields; `website` line
  leads in all-sites union rows; content `data-testid="entry-metadata"` +
  `data-entry-link` for tests. **Zero network on hover** (unit-asserted).
- `CatalogEntryRow` — the ONE composed row behind BrowsePage site lists AND
  the AllSitesSearchPage union (website line + WebsiteBadge); carries accents,
  popover, and menu. While the row menu is open the hover popover is
  suppressed (controlled HoverCard) — two overlays never fight for the row.
- `HighlightNewToggle` + `state/highlight-new.ts` — persisted global toggle.
- `EntryRowMenu` — Open (navigation), Download all chapters
  (`useCreateDownloadBatch` + `downloadAllBatchKey` FNV-1a per (module, manga),
  sonner toasts: "Queued N chapter downloads" / "Already queued" on replay),
  Add to favorites (`useFavoriteState`; disabled + "Already in favorites"
  tooltip when favorited — span-wrapped trigger because disabled items are
  pointer-events:none).
- Accents use design tokens only (`bg-primary/5`, `bg-success/5`,
  `bg-primary/10 text-primary`) — no ad-hoc colors.

### 3. Platform bug found + fixed (pre-existing, app-wide)

**Every Radix popper overlay in the app rendered off-screen in a real
browser.** The vendored `Button` (CLI React-19 plain-function style) cannot
receive refs under the app's React 18, so every `asChild` trigger wrapping it
silently dropped the anchor ref → Radix never registered the popper anchor →
floating-ui left content at its `translate(0, -200%)` pre-positioning state.
Reproduced on BOTH the new row menu and the (separately in-flight) favorites
row menu; hover popovers stalled identically (masked in tests because
Playwright `toBeVisible` does not require in-viewport and jsdom never
measures layout). Console signature: *"Function components cannot be given
refs … Check the render method of `Primitive.button.Slot` … at Button"*.

Fix: `web/src/components/ui/button.tsx` and
`web/src/components/patterns/EntryRow.tsx` converted to `forwardRef`
(vendored-patch comments in place). Probe evidence: menu wrapper transform
`translate(0px, -200%)` → `translate(926px, 330px)` (anchored at the
trigger) after the fix. This also repairs the favorites row menu, dialog /
sheet / tooltip triggers that wrap Button.

## Tests (all green at commit time)

| Suite | Count | Covers |
|---|---|---|
| `server/test/api/jobs-batch.test.ts` | 7 | 'all' resolves live info + one job/chapter with derived keys `<k>:<i>`; **identical replay → SAME job ids, 200 + replayed, no new jobs**; same key + different sequence → 409; selection enqueues verbatim with ZERO info calls; paused/saveTo on every job; unknown module 404; empty selection / missing key 400 |
| `web/test/browse-list-polish.test.tsx` | 13 | popover fixture test (all §5.8 fields + empty-field omission + union Website line) with **no `/api/info` call on hover**; accent matrix (new/completed/both/none, toggle on/off, filter-window widening); toggle persistence + FMD2 default ON; menu: Open navigates, Download-all POSTs the batch body with the deterministic key, double-submit replays identically, favorites disabled+tooltip when seeded / POSTs when not |
| `web/e2e/browse-list-polish.spec.ts` | 4 | real-browser popover (visible + positioned after the forwardRef fix, zero info fetch); Open navigation; Download-all → toast + 201→200 replay with identical idempotencyKey; favorites round-trip → disabled item + tooltip (hover on the pointer-events wrapper) |

Regression surface: `server/test/api` + `contract/test` + api-drift +
ws-contract-drift + downloads-feed + site-picker + manga suites — 403/404
(the one failure is the separately in-flight `[parity-sweep] M14` info
test, uncommitted work by another story, unrelated). Pre-existing row-query
regexes in `pagination` / `all-sites-search` / `browse-provision` specs
anchored (`/^Title/`) because rows now carry a second "Actions for <title>"
button.

## Verify

```bash
cd /workspace/fmd-web
npx vitest run server/test/api/jobs-batch.test.ts web/test/browse-list-polish.test.tsx
npx playwright test browse-list-polish.spec.ts   # from web/
```

## Deferred

- **Delete local list** (pmMangaList's `miMangaListDelete`): destructive
  server-side data; documented in `docs/UX-PARITY.md` Part 3 as deferred from
  the v1 row menu until a confirm+undo pattern exists.
- FMD2's in-menu highlight-new checkbox lives as the list-level toggle
  instead (task requirement; web pattern ruling).
- All-sites rows reuse the filter default window (1 day) — the union view has
  no filter panel; revisit if the union gains filter state.
