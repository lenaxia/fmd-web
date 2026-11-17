import { defineConfig } from '@playwright/test';

/**
 * VISUAL REGRESSION GATE (design system): per-page × per-theme
 * screenshots against the committed fixtures in
 * web/e2e/visual/fixtures/ — ZERO tolerance (one differing pixel
 * fails). Intentional visual changes go through the reviewed update
 * flow:
 *
 *   npm run e2e:visual -- --update-snapshots   # regenerate fixtures
 *   # review + commit the fixture diff together with the source change
 *
 * Same offline shape as the smoke run: real vite dev server, the
 * fixture-driven mock API, deterministic viewport.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /visual\.spec\.ts/,
  timeout: 30_000,
  // CI-load budget (see playwright.config.ts): first test pays vite
  // cold-transform + theme hydration under parallel load.
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  snapshotPathTemplate: 'e2e/visual/fixtures/{platform}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
    },
  },
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1280, height: 800 },
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
