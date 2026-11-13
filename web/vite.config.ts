import { defineConfig } from 'vite';

/**
 * Vite config for the @fmd/web SPA. No React plugin needed — esbuild
 * applies the automatic JSX runtime from tsconfig `jsx: react-jsx`.
 * The API base is the SAME origin (single-container deployment, §10:
 * the server serves the SPA), so dev/E2E traffic to `/api/*` is the
 * only backend the bundle ever talks to.
 */
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist-web',
    sourcemap: true,
  },
});
