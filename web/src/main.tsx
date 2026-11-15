import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ApiClientProvider } from './api/context';
import { APP_MOUNT_ID } from './index';
import './styles.css';

/**
 * Entry point (§11 web/): one QueryClient for the whole SPA —
 * conservative retries (2) so the typed error envelope surfaces fast.
 * The ApiClientProvider mounts here too (App renders inside it).
 */
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
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
