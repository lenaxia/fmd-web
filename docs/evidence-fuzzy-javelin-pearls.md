# Evidence — Catalog-index search with scope + preferred sites

**Story:** tsk-fuzzy-javelin-pearls — search-with-scope (D1 §2 ENTER) + the
preferred-sites allowlist + the capped live-scrape leg + the short-TTL query cache
**Date:** 2026-11-19 · **Stage:** in_progress → in_review

## Summary

Search now rides a three-way **scope selector** on the search home —
**all sites** (the default: the union over every installed catalog, answered
from the local index with ZERO network), **preferred** (the persisted
user-ordered allowlist filters participation), and **specific** (an explicit
multi-select, the tightest scope — wins over the named one). Results keep
their per-site badges (mirror copies of a series interleave in one set).
The **preferred-sites allowlist** is one global ordered list persisted
server-side (app_settings kv, single-user per R2/D1 §4.1), surfaced as the
picker's star (one-decision add/remove → full-list PUT), joined live onto
/api/modules rows (`preferred: true`), ordering the picker's pinned
Preferred group, the search-facet chips, and — per D1 §3 — destined to fix
duplicate-title resolution order. Dead preferred sites **dim** (availability
hint composes; never hidden, never a gate). The **live-scrape leg** fires
ONLY for catalog-less live-capable sites under an EXPLICIT scope (never the
all-sites firehose): one request per site (per-host concurrency 1 by
construction), client fan-out capped at 3, server §6.8 walks single-flight
per module + update-lane-gated, results render PROGRESSIVELY per site, and
navigation aborts the in-flight generation. A **short-TTL cache** (30 s,
bounded, generation-bumped by preferred-sites writes) serves repeated
identical query pages without re-fanning the per-site FTS windows.

## Ground truth (D1 — DESIGN-NORTHSTAR.md)

| D1 ruling | Implementation |
|---|---|
| §2 ENTER: "search-with-scope (catalog-index search over a preferred scope, not the all-sites firehose)" | `?scope=preferred` narrows the /api/search participation set to the allowlist; `?sites=` multi-select is the tightest scope; `all` stays the zero-network default |
| §2 ENTER: "Scoping rides the preferred-sites global allowlist: one canonical, user-ordered list" | `SqlitePreferredSitesService` over the app_settings kv row `search.preferredSites` (order-preserving JSON); GET/PUT /api/preferred-sites (full-list replacement) |
| §2 ENTER: "One-decision add … never re-asked, never a wizard" | the picker star: click = append (PUT next full list), un-star = remove; no per-manga prompt anywhere |
| §3: "The preferred-sites list ORDER is canonical — it fixes scope ordering, presentation order, and duplicate-title resolution order" | order is exactly the submitted order (dedupe keeps first position); facets render in it under scoped queries; the picker floats the Preferred group in it; duplicate-title resolution order is consumed by the EXIT story |
| §3: "Hints never block" | unreachable preferred sites dim in the chips + picker rows + specific-pick list; stay visible, selectable, searchable |
| §3: "GET never mutates" | the allowlist reads on GET; PUT is the one write surface |
| Killed-ideas: batch site probing / synchronized fan-out shape | scope=all NEVER live-scrapes (excluded chips instead); the live leg is capped at 3 concurrent sites, one request per host |
| §8 standing constraints | gates via node_modules/.bin; typed seams (SiteIdSchema, scope enums, generated client); OpenAPI snapshot regenerated in-change; long-form commit; no release tag |

## The API

- `GET /api/search` — additive params: `scope=all|preferred` (default all)
  and `sites=` (repeated or comma-separated — the specific multi-select;
  unknown registry ids are a typed 400 naming them; known-but-disabled
  picks are invisible, union parity). Response gains `scope:
  'all'|'preferred'|'specific'` (the effective scope echo). The union
  cursor now binds scope+sites (reuse under another scope → typed 400).
  Facets render in canonical scope order under scoped queries; entries
  keep the documented (normalized title, site, link) comparator order.
- `GET /api/preferred-sites` → `{ sites: [...] }` in canonical order.
- `PUT /api/preferred-sites` `{ sites: [...] }` — full-list replacement;
  registry membership gate at the route (unknown ids → 400 naming them);
  dedupe keeps first position; caps at 512; bumps the search-cache
  generation.
- `GET /api/modules` rows gain `preferred: boolean` (joined LIVE per read
  — the same posture as catalogInstalled/availability; `.default(false)`
  keeps stored fixtures parsing).

## Documented decisions

1. **`picks` not `sites` on the router** — `#/browse?sites=1` is the
   site-picker mode (App.tsx's search-home detection reads it); the
   specific scope's URL param is `?picks=<id1,id2>` to stay disjoint.
2. **'specific' never goes on the wire** — the server derives it from the
   presence of `sites[]`; only the NAMED `preferred` scope is a wire value.
   The response echo disambiguates for clients.
3. **Scope resolution at the route, order in the service** — the route
   resolves preferred → the ordered id list (absent service → typed 400,
   never a silent fall-back to all: scope truth is not guessable); the
   service consumes any ordered list (preferred/specific identical to it)
   and keeps entry order comparator-based (deterministic, cursor-stable)
   while FACETS + EXCLUDED render in scope order (the presentation order).
4. **Empty preferred list = honest empty page** (entries [], facets []) +
   the UI's teaching hint — never a silent fall-back to all.
5. **Live leg guards** — fires only when scope ≠ all AND the site is
   enabled, catalog-less, and live-capable (`live_scrape_fallback` — a
   catalog-less site WITHOUT directory events surfaces through the
   excluded chips, never as a doomed 404 request). Concurrency:
   LIVE_FANOUT_CONCURRENCY = 3 client-side; per-host = 1 by construction
   (one request per distinct origin); server-side each request rides the
   §6.8 walk (TTL-cached, single-flight per module, update-lane-gated —
   never a download slot). Per-host PACING proper (checks/downloads/
   retries) is p1's charter (tsk-outland-henna-masks, backlog) — this
   story composes with it by staying one-request-per-host.
6. **TTL cache shape** — key = generation + full filter fingerprint
   (scope+sites included) + cursor + limit; 30 s TTL; 64-entry LRU;
   `bumpGeneration()` on every preferred-sites PUT (O(1) orphaning);
   entries private (structuredClone on get — a mutated return can never
   poison the next hit). Catalog installs sync-lag tolerance is the TTL
   itself (documented, not hooked).
7. **Picker star placement** — the clickable star is a SIBLING of the
   pick button (HTML forbids nested buttons); the row's primary identity
   stays the site name; `data-preferred` + `aria-pressed` carry state.
8. **Same-worktree coordination** (the b8de66f/99c5edd precedent): the
   tree carried the sibling [paste-url-add] lane's in-flight files
   mid-story (its spec, then its commit 4635bfc landing under me); this
   diff stages ONLY this story's files. The shared `playwright.config.ts`
   testMatch line gained `search-scope` (the sibling's `paste-url-add`
   entry had already committed by then — the final diff is single-purpose).

## Zero-network proof (AC1)

`server/test/api/search-scope.test.ts`:
- `globalThis.fetch` is STUBBED TO REJECT ("EGRESS-STUB: network is
  forbidden in this test") — the all-sites query answers 200 with entries
  and site badges from the local index.
- a `catalogFallback` double whose EVERY method throws proves the union
  NEVER consults the §6.8 live fallback under scope=all; the catalog-less
  site surfaces as `excluded[]` instead.
- a second egress-stubbed test pins the preferred scope local-index-only
  shape too.

## Scope selector + allowlist (AC2)

- Server: scope=preferred filters participation to the allowlist ∩
  enabled+installed; facets render in ALLOWLIST order (pinned by a test
  whose allowlist order deliberately differs from site-id order); empty
  allowlist → honest empty; absent service → typed 400; unknown `sites=`
  ids → 400 naming them; specific wins over preferred; cursor scope-bound.
- Persistence: real better-sqlite3 app_settings round-trip (a SECOND
  service instance over the same db — the restart shape — serves the same
  order); dedupe/first-position; cap; defensive decode of legacy bytes.
- Web: URL-as-truth (`?scope=`, `?picks=`; typing replaces, scope pushes),
  preferred chips in allowlist order with `data-unavailable` dimming,
  empty-allowlist teaching hint, the specific multi-select (filter +
  checkboxes + capped render), the picker star → PUT round-trip →
  Preferred group re-render, `/api/modules` join flips live.
- e2e: the picker star PUTs and survives reload; chips order + dim; the
  default-all request carries no scope and never live-searches.

## Live-scrape leg (AC3)

- ONLY explicit scopes fire it (scope=all with the same registry → zero
  per-site searches — unit + e2e pins); candidates = enabled +
  catalog-less + live-capable, in canonical scope order.
- Capped: at most 3 in flight (hook-level unit test with a controlled
  fetch double — the 4th request starts only after a slot frees);
  per-host = 1 by construction (one request per distinct origin).
- Progressive: per-site groups render in scope order; a resolved site's
  rows show while another is still pending (unit pin); failures render
  typed failed rows (never silent).
- Cancellable: the hook's AbortController aborts on dependency change and
  unmount; a generation guard keeps late resolutions from landing. NOTE
  (documented in-test): under jsdom the fetch-level signal is
  realm-dropped for EVERY query in this suite (the shipped
  `requestCompatibleSignal` tradeoff) — browsers get true network
  aborts; the unit suite pins the user-visible half (stale results never
  render, unmount is leak-free).

## Gates (all via node_modules/.bin — D1 §8.1)

- **tsc -b tsconfig.json**: clean on this story's files. Pre-existing/
  sibling exceptions, both reproducing outside this diff:
  `server/test/runtime/download-lane-output.test.ts` is the sibling
  [library-layout-follow-up] lane's UNCOMMITTED mid-flight edit (its
  `run()` helper refactor in progress when the gate ran; untouched here).
- **eslint .**: clean (repo-wide).
- **vitest run (full)**: 242 files / 2376 passed | 3 skipped | 0 failed —
  including the 26 new server tests (search-scope 11 + search-cache 5 +
  preferred-sites 10) and the 18 new/updated web tests (search-scope 14 +
  site-picker-preferred 4), plus the two assertion-shape updates in
  pagination/site-picker suites (the search home + picker now also read
  /api/preferred-sites; the pick button is disambiguated from the new
  star by its ': browse' label).
- **e2e desktop project**: 85 passed — the 4 new search-scope specs +
  locator scoping in site-picker-smoke (5 tests) and site-availability
  (2 locators) for the star-button collision. The ONE failure is the
  Settings virtualized-scroll perf spec — the DOCUMENTED pre-existing
  loaded-runner flake (b8de66f's A/B note: proven identically failing on
  unchanged HEAD; this diff touches no Settings/virtualization surface —
  SettingsPage does not render SiteRow).
- **e2e visual (32/32 green)**: search-home ×4 + palette ×4 fixtures
  regenerated with this story's scope selector (the palette shots are
  taken over the search home; the sibling 4635bfc's home box is in them
  too — shared pages, coordinated regen). The update run ALSO refreshed
  settings ×4 and manga ×4 drift owned by sibling lanes (settings = the
  [site-availability] pending regen noted in 99c5edd; manga = a ~60-byte
  nondeterminism not caused by this diff) — those stay UNSTAGED per the
  coordinated-staging precedent; the working tree is green either way.
- **OpenAPI**: snapshot regenerated in-change (2 new operations, scope/
  sites params, scope echo, preferred join); snapshot test green;
  `openapi.d.ts` regenerated; api-drift test green.
- **SPA bundle**: web/dist-web rebuilt from the committed tree (the
  token-auth lane's reproducible-bundle discipline).

## Sequencing note

The sibling [paste-url-add] lane committed (4635bfc) while this story was
in flight; this diff is exactly the [fuzzy-javelin-pearls] content on top
of it (SearchHomePage's diff vs HEAD is this story's scope work alone —
their home-box hunks landed in their commit). `server/test/runtime/
download-lane-output.test.ts` and the manga/settings visual fixtures are
the sibling lanes' uncommitted/pending content, left for their commits.
