import { defineConfig } from '@playwright/test';

/**
 * E2E smoke (one happy-path per page) against the REAL Vite dev
 * server with a FIXTURE-DRIVEN mock API (page.route / routeWebSocket
 * interception — no backend, no external network; loopback only).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 20_000,
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
