# @fmd/web — React SPA (DESIGN.md §10/§11)

React + Vite + TypeScript (strictest) SPA over the §10 API: **Browse**,
**Manga detail**, **Downloads**, **Settings**. Phase-2 story
`tsk-crimson-leopard-sweeps`.

## Stack choices (documented, per the task contract)

| Concern | Choice | Why |
|---|---|---|
| Build | **Vite** (no React plugin) | esbuild applies the automatic JSX runtime from `tsconfig` (`jsx: react-jsx`); one less dep, same output. |
| Typed API client | **openapi-typescript** → `src/api/openapi.d.ts` + **openapi-fetch** runtime | The client is GENERATED from the committed snapshot (`server/src/api/openapi.snapshot.json`) — never hand-written against routes. Call sites are keyed by path literals from the generated `paths` type, so a route rename/removal breaks `tsc`. Regenerate: `npm run gen:api -w @fmd/web`. |
| Server state | **@tanstack/react-query** (v5) | All server state (queries/mutations/cache) lives in React Query; local UI state stays in `useState`/`useRef`. No other store exists. WS events patch query caches; a D19 `resync` hint invalidates. |
| Routing | hand-rolled hash router (`src/router.ts`) | Four pages + query params is the entire surface — a router dependency buys nothing. |
| WS (D19) | `src/state/ws-backfill.ts` — transport-agnostic state machine | `idle → connecting → open|backfilling → reconnecting` with capped exponential backoff; hello carries the last event id (backfill cursor); `resync` clears the cursor and triggers a full refetch (ring buffer: 1000 events/job, 15 min — §10/D19). |
| Component tests | vitest (jsdom env per file) + Testing Library + user-event + jest-dom | Request-recording mock fetch (`test/helpers.tsx`) — fully offline (§13). |
| E2E | **Playwright** against the real Vite dev server with a fixture-driven mock API | `page.route` fulfills every `/api/…` call from `e2e/fixtures.ts`; `page.routeWebSocket` mocks the `/ws` event stream. One happy-path per page, offline, exit 0. |

Strictness flags all come from `../tsconfig.base.json` untouched
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, …); only module/JSX settings are overridden for
the browser toolchain (documented in `web/tsconfig.json`).

## API drift gate

`web/test/api-drift.test.ts` regenerates the client from the committed
snapshot in-memory and byte-compares against `src/api/openapi.d.ts`:
a route change in the snapshot without `npm run gen:api -w @fmd/web`
FAILS the build. A negative control proves the harness reacts to route
additions.

## §5.1 combobox INDEX semantics

A combobox option's STORED value is the item INDEX inside `items`, never
the label. The editor renders labels and submits integers
(`collectOptionValues` — unit-tested in `test/options-editor.test.tsx`,
including out-of-range refusal).

## Commands

```sh
npm run dev -w @fmd/web        # Vite dev server :5173 (same-origin API)
npm run gen:api -w @fmd/web    # regenerate src/api/openapi.d.ts from the snapshot
npm run build -w @fmd/web      # vite build → web/dist-web
npm test                       # root vitest (includes web/test, offline)
npm run e2e -w @fmd/web        # Playwright smoke (starts the dev server itself)
npx playwright install chromium  # once, before e2e
```

## Notes / known limits

- The §10 read model (`ModuleSummary`) exposes option descriptors +
  `defaultValue` only — stored §9 option values are not part of the
  list response, so drafts seed from `defaultValue` until a values read
  model exists (documented in `OptionsEditor`).
- Catalog ids equal the site module id (§6.4); Browse takes `?catalog=`
  and the D20 empty state guides catalog selection when absent.
- The WS hub server-side is a separate story; `ws-protocol.ts` documents
  the client-side §10 wire shapes the hub must match byte-for-byte.
