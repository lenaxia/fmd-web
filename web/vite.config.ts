import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Vite config for the @fmd/web SPA. No React plugin needed — esbuild
 * applies the automatic JSX runtime from tsconfig `jsx: react-jsx`.
 * The API base is the SAME origin (single-container deployment, §10:
 * the server serves the SPA), so dev/E2E traffic to `/api/*` is the
 * only backend the bundle ever talks to.
 *
 * Design system: Tailwind v4 via its Vite plugin (CSS-first config —
 * every token lives in src/styles/tokens.css) + the `@/` alias shared
 * with tsconfig so CLI-vendored shadcn components resolve as authored.
 */
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist-web',
    sourcemap: true,
  },
});
