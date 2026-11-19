import { defineConfig, devices } from '@playwright/test';

/**
 * E2E smoke (one happy-path per page) against the REAL Vite dev
 * server with a FIXTURE-DRIVEN mock API (page.route / routeWebSocket
 * interception — no backend, no external network; loopback only).
 *
 * TWO projects (R3 — mobile is a first-class citizen, not an afterthought):
 *   - desktop  — the full smoke surface (Desktop Chrome viewport; the
 *                keyboard-only '/' shortcut test lives here — the
 *                affordance is desktop-only by design, mobile reaches
 *                search via the always-visible input);
 *   - mobile   — the mobile surface (iPhone 13): the search-first home
 *                flow (search default, union results, facet narrow,
 *                picker toggle, recents, palette via the visible
 *                header affordance — never a keyboard-only path).
 *
 * The compose/process stack scenario lives in its own specs driven by
 * scripts/e2e.sh (web/playwright.compose.config.ts); visual regression
 * has its own zero-threshold config (playwright.visual.config.ts).
 */
export default defineConfig({
  testDir: './e2e',
  // The compose/process stack scenario lives in its own specs driven by
  // scripts/e2e.sh (web/playwright.compose.config.ts) — this config is
  // the smoke run only (vite dev server + intercepted mock API).
  timeout: 20_000,
  // CI-load budget: the first test pays vite cold-transform + mock-API
  // hydration under parallel load; 5s (Playwright default) loses that
  // race on busy runners — observed as a cold-start flake in ci.sh.
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // ONE test at a time across BOTH projects: the perf/jank specs
  // measure frame times — desktop and mobile suites overlapping on a
  // loaded runner doubles the ambient CPU noise and flips the scroll
  // budgets (observed: perf-mobile green in isolation, flaky in the
  // full run). Serial keeps the gate deterministic; the whole e2e
  // chain stays ~4 minutes.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    trace: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: 'npx vite',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testMatch:
        /(smoke|a11y|perf|search|search-home|search-scope|manga-parity|browse-list-polish|settings-parity|favorites-parity|downloads-parity|parity-sweep|arrival-experience|fmd2-import|cover-proxy|library-file-state|site-availability|paste-url-add)\.spec\.ts/,
    },
    {
      name: 'mobile',
      // One retry for the touch/frame-budget surface: the mobile specs
      // measure interaction timing (tap activation, scroll jank) — a
      // single ambient hiccup on a loaded runner (desktop project
      // finishing, vite settling) fails the FIRST attempt and passes
      // the retried one on a settled machine. Reported as flaky, never
      // silently green.
      retries: 1,
      // R3 'mobile' project (tsk-verdant-manger-hovers): the iPhone-13
      // PATTERN (390×844 @ deviceScaleFactor 3, isMobile, touch) on the
      // Chromium engine (the gate stays single-engine — the Webkit
      // binary is not part of the offline sandbox toolchain; the device
      // descriptor is a SHAPE, not an engine choice). Under this
      // emulation Chromium reports (hover: none), so this project
      // exercises the REAL touch surface: the bottom tab shell,
      // tap-activated metadata popovers (R3a), drag-dismissable sheets
      // and the touch-target floor (R3b).
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
      testMatch: /(search-home|mobile-parity|touch-audit|perf-mobile|arrival-experience)\.spec\.ts/,
    },
  ],
});
