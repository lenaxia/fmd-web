import { defineConfig } from '@playwright/test';

/**
 * E2E smoke (one happy-path per page) against the REAL Vite dev
 * server with a FIXTURE-DRIVEN mock API (page.route / routeWebSocket
 * interception — no backend, no external network; loopback only).
 */
export default defineConfig({
  testDir: './e2e',
  // The compose/process stack scenario lives in its own specs driven by
  // scripts/e2e.sh (web/playwright.compose.config.ts) — this config is
  // the smoke run only (vite dev server + intercepted mock API): the
  // four page happy-paths (smoke.spec.ts), the keyboard-navigation
  // smoke (a11y.spec.ts), the virtualization perf smoke
  // (perf.spec.ts) and the MangaPage parity suite (manga-parity.spec.ts
  // — favorites round-trip, downloaded tint/hide, asc/desc). Visual
  // regression has its own zero-threshold config
  // (playwright.visual.config.ts).
  testMatch: /(smoke|a11y|perf|search|manga-parity|browse-list-polish|settings-parity|favorites-parity|parity-sweep)\.spec\.ts/,
  timeout: 20_000,
  // CI-load budget: the first test pays vite cold-transform + mock-API
  // hydration under parallel load; 5s (Playwright default) loses that
  // race on busy runners — observed as a cold-start flake in ci.sh.
  expect: { timeout: 10_000 },
  fullyParallel: false,
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
});
