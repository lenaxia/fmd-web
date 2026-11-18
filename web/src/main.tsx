import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ApiClientProvider } from './api/context';
import { ThemeProvider } from './state/theme';
import { applyPreviewManifestToken } from './state/preview-manifest';
import { APP_MOUNT_ID } from './index';
import './styles/tokens.css';

/**
 * Entry point (§11 web/): one QueryClient for the whole SPA —
 * conservative retries (2) so the typed error envelope surfaces fast.
 * The ApiClientProvider mounts here too (App renders inside it).
 */
// Preview-tunnel manifest token (covers live-defect sibling): when the
// page URL carries the preview proxy's ?t credential, the manifest
// link must ride it too or its fetch 401s through the tunnel. No `t`
// param (every production deployment) — a pure no-op.
applyPreviewManifestToken(document, window.location.search);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

const mount = document.getElementById(APP_MOUNT_ID);
if (mount === null) {
  throw new Error(`SPA mount #${APP_MOUNT_ID} missing from index.html`);
}

createRoot(mount).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider>
          <App />
        </ApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
