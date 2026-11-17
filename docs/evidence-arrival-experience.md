# Evidence — R5 arrival experience: 'While you were away' + nav activity badge + PWA installability

**Story:** tsk-insular-verdict-ambles — R5 license exercised on the arrival workflow
**Date:** 2026-11-17 · **Stage:** in_progress → in_review

## Summary

The architecture's categorical advantage — a server-side queue that works while
you're gone — is now FELT at arrival. Three surfaces, one story:

1. **'While you were away' summary** — the landing view (search home) renders a
   dismissible card when the previous visit stamp (localStorage `fmd-web-last-visit`,
   rewritten on each visit) is **≥ 1 h stale AND there is news**:
   - *Chapters downloaded* — `GET /api/jobs?state=done&since=<previous-stamp>`
     (additive `since` = ISO-ts floor on `updatedAt`, the done timestamp), grouped
     per manga (moduleId+mangaUrl), newest-manga-first, each row a deep link to
     `#/manga?module=…&url=…`;
   - *New chapters for favorites* — `GET /api/favorites?since=<previous-stamp>`
     (additive per-row `newsSince`: `lastCheck >= since && newChapterCount > 0`),
     each row a deep link to `#/favorites`.
   Card states: has-downloads / has-new-chapters / both. 'Nothing new' renders
   NOTHING (no empty shell, ever — loading included). Dismissal persists per NEWS
   BATCH (id = newest item timestamp across both halves): the same batch never
   nags again; a newer batch gets a fresh id and may re-show.
2. **Downloads nav activity badge** — running+queued count on the Downloads
   destination, on BOTH the desktop top tabs and the mobile bottom bar (R3). The
   ONE app-level `/ws` jobs feed moved into `JobsActivityProvider` (the Downloads
   page consumes the same context — single connection for the whole app); the
   count rides the standard `['jobs', *]` query the feed patches in place, and a
   resync invalidates it — WS-driven, never polled, reconnect-safe by
   construction. A completion while the app is open fires the existing toast path
   (sonner, one toast per `id:updatedAt` terminal transition; backfill replays
   suppressed) plus a dot on the destination that clears when the user VISITS
   Downloads.
3. **PWA installability** — `web/public/manifest.webmanifest` (name/short_name,
   `display: standalone`, `start_url: /`, theme/background `#09090b` from the
   design tokens' dark palette, 192/512 icons in `any` + `maskable` purposes,
   generated from the brand BookOpenText glyph via `scripts/gen-pwa-icons.mjs`),
   linked from the SPA shell; iOS meta pair (`apple-touch-icon`,
   `apple-mobile-web-app-*`) for the Share → Add to Home Screen path;
   `beforeinstallprompt` captured (`state/pwa-install.ts`, useSyncExternalStore)
   so **'Install app'** surfaces in Settings → About AND the command palette
   ONLY when the browser actually offers it (consumed prompt or `appinstalled`
   drops the surfaces again). **Offline service worker = documented SKIP** —
   server-dependent app; the manifest is for installability, not offline
   (docs/UX-PARITY.md Part 5).

API additions are **additive-only**: no existing param changed shape, no new
route; OpenAPI snapshot + `openapi-typescript` client regenerated (regen diff
clean — see verification).

## Ground truth / design anchors

| Element | Source of truth | Implementation |
|---|---|---|
| Arrival summary | Story req 1; web-native 'return and be told' pattern | `components/patterns/AwaySummaryCard.tsx` + `state/last-visit.ts` (stamp, 1 h floor, batch-dismiss) |
| Jobs `since` | Story req 2 ('verify first — do not duplicate': param was absent pre-R5) | `server/src/api/schemas.ts` (`since: z.iso.datetime()`), floor applied in the jobs service query |
| Favorites `newsSince` | Story req 2 (additive field, same list call) | `server/src/api/app.ts` favorites handler spreads `newsSince: true` under `?since` |
| Badge/WS/backfill | D19 resync contract (`state/ws-backfill.ts`) | `state/jobs-activity.tsx` — feed + `['jobs','activity']` query, resync invalidation |
| Both viewports | R3 ruling (61f1300) | `Nav` (desktop tabs) + `BottomTabNav` badges prop (mobile bar); Playwright `desktop` + `mobile` projects |
| PWA manifest/icons | Story req 4; design tokens | `web/public/manifest.webmanifest` + `scripts/gen-pwa-icons.mjs` (Playwright rasterizes the lucide glyph at safe-zone padding for maskable) |
| Install gating | `beforeinstallprompt` non-standard contract | `state/pwa-install.ts` (preventDefault + capture; `prompt()` is the ONE call) |

## Key decisions

1. **Visit stamp is one-shot per JS context** — `beginVisit()` reads the previous
   stamp, rewrites to now, and caches the previous value; the app shell calls it
   on mount and the card consumes the cached value, so a route away-and-back
   never re-derives a different gap. No stamp (first run) = never stale — the
   card can only appear from the SECOND session on.
2. **Batch-dismiss id = newest item timestamp** (max over download-group
   `latest` and favorite `lastCheck`) — deterministic from the same data that
   renders the card, so a reload of the identical batch stays dismissed while
   any newer item re-arms it. No server state, no expiry heuristic.
3. **Away queries are one-shot REST seeds, the badge is WS-live** — the summary
   describes an OFFLINE gap (backfill replays deliberately do not re-set the
   completion dot — the away card owns gaps; the dot owns live completions).
   No polling anywhere: the badge count query is patched by WS events and
   invalidated on resync/reconnect exactly like the Downloads page feed.
4. **Badge caps at 99+** (`badgeLabel`) so the chip stays inside the tab rhythm
   on both surfaces; the mobile bar renders badge OR dot in the same slot (the
   count is the stronger signal), desktop renders both inline.
5. **Install surfaces are availability-gated, not UA-sniffed** — iOS Safari
   never fires `beforeinstallprompt` (Share → Add to Home Screen is served by
   the apple-touch meta; our actions stay hidden there by design);
   Firefox/Safari desktop never fire it either. Platform quirks documented in
   docs/UX-PARITY.md Part 5 (guide requirement).
6. **`since` composes with the existing state filter, it does not replace it** —
   `state=done&since=…` is the away-summary call; plain `since` floors any
   state view. Malformed `since` is a typed 400 (zod ISO-datetime, offset-less
   UTC only); absence keeps the pre-R5 response shape byte-for-byte.

## Files changed (story scope)

**New (web):** `web/src/components/patterns/AwaySummaryCard.tsx` ·
`web/src/state/last-visit.ts` · `web/src/state/jobs-activity.tsx` ·
`web/src/state/pwa-install.ts` · `web/public/manifest.webmanifest` +
`icon-192/512(.maskable).png` + `apple-touch-icon.png` ·
`scripts/gen-pwa-icons.mjs` · `web/e2e/arrival-experience.spec.ts`.

**New (server tests):** `since` describe in `server/test/api/jobs.test.ts`
(done-at/after filtering, malformed 400, absence = pre-R5 shape) · `newsSince`
tests in `server/test/api/favorites.test.ts` (check-at/after + chapters gating).

**Modified:** `web/index.html` (manifest link, theme-color, iOS meta pair) ·
`web/src/App.tsx` (JobsActivityProvider mount, badge+dot on Nav, BottomTabNav
badges, beginVisit, dot-clears-on-visit effect) ·
`web/src/components/patterns/BottomTabNav.tsx` (badges prop) ·
`web/src/pages/SearchHomePage.tsx` (card mount) ·
`web/src/pages/DownloadsPage.tsx` (consumes the shared feed) ·
`web/src/state/use-jobs-feed.ts` (live/backfill phase tap) ·
`web/src/api/hooks.ts` (`useJobsList` since, `useFavoritesNews`) ·
`web/src/components/settings/ParitySweepSections.tsx` (About → Install app) ·
`web/src/components/palette/CommandPalette.tsx` (palette install action) ·
`server/src/api/{schemas,routes,app,openapi}.ts` + `openapi.snapshot.json` ·
`web/src/api/openapi.d.ts` (client regen) · `docs/UX-PARITY.md` (Part 5).

**Post-coalesce test health** (after 5434769 landed the shared tree): the
app-shell-level activity query is filtered out of two exact-request-list
assertions in `web/test/pagination.test.tsx` (`pageRequests` helper — the shell
feed is not the page under test); `web/test/browse-list-polish.test.tsx`
settle-hardened (Escape + body pointer-events lift in `settleHoverTimers`;
`findAllByText` for the three settle-only title queries the hover popover can
duplicate under load).

## Verification (final tree, 2026-11-17)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` (tsc -b, strict) | PASS |
| Lint | `npm run lint` (eslint) | PASS |
| Web unit | `npx vitest run web/test --maxWorkers=4` | **27 files / 194 tests passed** — 3 consecutive loaded runs, zero flakes after the settle hardening |
| Server unit | `npx vitest run server/test --maxWorkers=6` | **158 files / 1690 passed + 3 skipped** (live-suite skips by design) |
| OpenAPI contract | `npx vitest run server/test/api/openapi.test.ts` | 6/6 (snapshot ↔ generated) |
| Client regen | `openapi-typescript openapi.snapshot.json` → diff vs `web/src/api/openapi.d.ts` | **identical** (CLIENT-IN-SYNC) |
| E2e desktop | `npx playwright test e2e/arrival-experience.spec.ts --project=desktop` | **8 passed / 1 skipped** (the mobile-only test, correctly) |
| E2e mobile | `… --project=mobile` (390×844) | **1 passed / 8 skipped** (desktop-matrix tests, correctly) |

Suite runs use a worker cap on this 64-core shared box: the uncapped default
forked 64 jsdom/worker processes and hit a V8 JIT fatal
(`Check failed: jit_page.has_value()` → tinypool `ERR_IPC_CHANNEL_CLOSED`) —
an infra ceiling, not a test failure; capped runs are deterministic (3× web
repeat above).

### Spec → acceptance mapping (arrival-experience.spec.ts)

- **Away card, downloads-only**: grouped rows per manga, count chips
  ('1 chapter'/'2 chapters'), deep links `#/manga?module=…&url=…` — desktop.
- **Favorites-only AND both**: favorites rows deep-link `#/favorites`,
  'N new chapters'; both halves visible in the both-state — desktop.
- **Dismiss persists per batch**: dismiss → reload stays gone; a NEWER batch
  (newest ts moved) re-shows — desktop.
- **No-news / fresh-visit render nothing**: empty news and no stamp at all —
  desktop.
- **Badge live**: REST seed '2' → WS done event drops to '1' → toast
  'Downloaded: …' → dot appears → visiting `#/downloads` clears the dot,
  count stays — desktop.
- **Reconnect/backfill**: socket close → reconnect answers backfill with
  `resync` → refetch re-derives '1' from the drained queue — desktop.
- **Manifest**: `/manifest.webmanifest` 200 + valid JSON + name/short_name/
  start_url/display standalone/theme+background + 192 any + 512 maskable
  icons, every icon asset resolves, shell links `rel="manifest"` + iOS meta —
  desktop (integration assert against the serving stack).
- **Install gating**: hidden in Settings→About AND palette without the event;
  a rich synthetic `beforeinstallprompt` reveals both; click → prompt accepted
  → 'installed' feedback → surfaces hide again — desktop.
- **Mobile (390×844)**: card renders; badge on `bottom-nav-downloads-badge`
  reads the queue, WS completion drops it and toasts; tapping through clears
  the dot — mobile project.

## Deliberately NOT (per story)

No notification permissions / Web Push (v0.4 candidate — needs a push-service
decision). No offline caching / service worker (documented SKIP). No email or
external digests.

## Coalescing note

The shared tree landed mid-story via 5434769 ([parity-sweep] review
remediation), which deliberately coalesced this story's complete in-flight
state (attributed in docs/evidence-parity-sweep.md §5.1). Everything above is
re-verified on the final tree INCLUDING that commit plus this story's
post-coalesce test-health deltas.
