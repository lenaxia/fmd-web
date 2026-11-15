import { defineConfig } from '@playwright/test';

/**
 * Compose/process e2e (scripts/e2e.sh) — the FULL stack scenario: the
 * browser drives the REAL app (server + SPA + SQLite catalogs + engine
 * live info) bootstrapped by D20 against the local mock upstream. No
 * API interception here (that's the smoke config); the only backend is
 * the compose stack / process twin.
 *
 * Three projects, run SEQUENTIALLY by scripts/e2e.sh:
 *   1. bootstrap-watch — starts immediately after `up`; asserts the D20
 *      empty-state + the bootstrap progress banner appearing/clearing
 *      (the UI-asserted auto-bootstrap);
 *   2. main — after wait-on /readyz: browse → search → live info via
 *      the mock upstream → dry-run enqueue → Downloads queued state.
 *   3. phase3 — the Phase-3 gate (download → pack → library →
 *      cancel/resume → retry); see e2e/download-flow.spec.ts.
 *
 * Failure artifacts (scripts/e2e.sh --phase3 copies them under
 * e2e/.tmp/artifacts): traces + screenshots are RETAINED ON FAILURE
 * (trace.zip opens in the Playwright trace viewer).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env['FMD_E2E_BASE_URL'] ?? 'http://localhost:3000',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: process.env['FMD_E2E_TRACE_DIR'] ?? './test-results/compose',
  projects: [
    { name: 'bootstrap-watch', testMatch: /bootstrap-watch\.spec\.ts/ },
    { name: 'main', testMatch: /compose-scenario\.spec\.ts/ },
    { name: 'phase3', testMatch: /download-flow\.spec\.ts/ },
  ],
});
