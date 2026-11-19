# Evidence — [crystal-nectar-pricks] Paste-URL add: universal front door

Story: paste box on the search home AND in the command palette →
resolve module via the existing RootURL host-match seam → info preview
(title, cover via proxy, alt titles) → one-decision follow (follow /
follow + auto-download). Unknown host → typed, human error. Charter:
D1 (`docs/DESIGN-NORTHSTAR.md` §2 ENTER, §8 standing constraints).

## What shipped (files)

| File | Role |
|---|---|
| `web/src/state/paste-url-arm.ts` | The palette→home arm channel (`armPasteUrl`/`consumePasteUrlArm`, exactly-once like `state/search-focus.ts`) + `normalizePastedUrl` (scheme-less pastes upgraded to https://). |
| `web/src/components/catalog/PasteUrlAdd.tsx` | The paste box + preview card + one-decision follow. Rides ONLY existing API surface: `POST /api/info` url-only (M14 host-resolve seam) and `POST /api/favorites` (`autoDownload`). Cover renders through `coverSrc` → `GET /api/cover` (the module-validated proxy — CSP untouched). |
| `web/src/pages/SearchHomePage.tsx` | Mount (2 hunks: import + `<PasteUrlAdd />` under the hero — the ENTER door lives on the search home always). |
| `web/src/components/palette/CommandPalette.tsx` | The palette action: "Add manga by URL". URL-shaped query (else clipboard) → `navigate('browse')` + `armPasteUrl` — the palette is a LAUNCHER, not a second form. Empty hand → toast + palette stays open. |
| `web/test/paste-url-add.test.tsx` | 10 unit tests (see below). |
| `web/e2e/paste-url-add.spec.ts` | 5 desktop e2e tests (see below). |
| `web/playwright.config.ts` | desktop testMatch + `paste-url-add`. |
| `docs/USER-GUIDE.md` | "Paste a URL (the universal front door)" section under Finding manga. |

## Design decisions (all inside the D1 charter)

- **No API change.** The M14 seam already carries url-only `/api/info`
  with typed 400s (`no_site_match`, `ambiguous_site` —
  `contract/types.ts:320`) and `/api/favorites` already accepts
  `autoDownload`. OpenAPI snapshot therefore unchanged (§8.2: regen
  rides API changes; there is none).
- **One preview/follow flow, two doors.** The palette action lands the
  URL in the search-home box via the arm bus instead of duplicating
  the form — "never a wizard, never re-asked" (§2 ENTER).
- **`noValidate` on the form**: native `type="url"` validation would
  swallow the submit for scheme-less pastes (`site.example/x`) with a
  browser bubble instead of OUR guidance — `normalizePastedUrl` owns
  the verdict.
- **cmdk filter seam**: a URL-shaped query scores zero against a bare
  label (every palette item vanishes, "No results found"); the query
  folds into the item's `value` so registration + the search-change
  recompute both score it (keywords alone re-register too late —
  empirically pinned by the e2e).
- **Already-favorited** derives from the favorites list join
  (the `useFavoriteState` membership pattern); a racing 409 `conflict`
  lands as "Already in your Favorites", never an error wall.

## Test coverage

Unit (`node_modules/.bin/vitest run web/test/paste-url-add.test.tsx`
— 10 passed): resolve-by-host preview (title/alt-titles/proxied cover
src asserted byte-exact); Follow posts `{moduleId,url,title}`; Follow
+ auto-download adds exactly `autoDownload: true`; already-favorited
done-state without a second POST; `no_site_match` → guidance +
"Browse supported sites" + zero favorite POSTs; `ambiguous_site` →
candidates named; non-URL input → guidance with zero `/api/info`
requests; pending arm consumed at mount auto-resolves.

E2E (`node_modules/.bin/playwright test paste-url-add
--project=desktop` — 5 passed): paste → preview → follow → appears in
Favorites (the AC journey, cover asserted through the `/api/cover`
proxy seam with real PNG bytes); auto-download body difference;
unknown host (typed guidance + the box stays operable — Playwright
fails on uncaught page errors, so these passing IS the never-a-500
assertion); ambiguous host candidates; palette entry from `#/downloads`
(URL query keeps the item visible → arms → same follow flow).

## Gates

- `node_modules/.bin/tsc -b` — **clean on the staged tree** (verified
  in an isolated HEAD+this-change worktree; see coordination note).
- `node_modules/.bin/eslint .` — clean on the same isolated tree.
- Full vitest on the isolated HEAD+this-change worktree: every web
  suite green (the worktree's server/corpus/contract failures are
  gitignored-fixture-path suites — module-sync, drift-check, harvester
  — absent from any fresh worktree, unrelated to this diff).
- Full vitest on the live working tree: **2372 passed | 4 failed |
  3 skipped** — all 4 in `web/test/pagination.test.tsx` +
  `web/test/site-picker.test.tsx`, asserting the PARALLEL session's
  uncommitted search-scope WIP surface (an unexpected
  `/api/preferred-sites` request; duplicate `BrokenSite` rows) —
  failure modes naming their features, in their modified files, with
  zero overlap with this story's files; the isolated HEAD+this-change
  tree has zero web failures, so none of the 4 is this change's
  regression (the be654a4/26318fa A/B coordination precedent).
- e2e neighbors on the isolated tree: search-home (desktop 8 +
  mobile 7+1 skipped), parity-sweep, favorites-parity, smoke —
  23 desktop passed, mobile 7 passed.
- e2e on the LIVE working tree cannot run while the parallel session's
  mid-flight edit leaves `SearchHomePage` throwing
  `ReferenceError: onScopeChange is not defined` at runtime (pageerror
  captured in test-results); the isolated tree is the discrimination
  proof for the same reason.

## Standing constraints (D1 §8) checklist

1. Gates via `node_modules/.bin` — yes (no `npx` invoked; the
   verification vite ran as `node node_modules/.bin/vite --port 5174`).
2. Typed seams, no `any`-shaped crossings; OpenAPI snapshot regen —
   N/A (no API change; the typed error codes consumed, not invented).
3. Restart canon — respected (the shared 5173 dev server was left
   alone; verification used an isolated worktree + port 5174).
4. Long-form commit — yes.
5. No release tag — yes.
