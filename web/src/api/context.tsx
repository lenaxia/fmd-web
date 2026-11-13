/**
 * React context carrying the generated API client instance, so tests
 * and the app can inject different transports (mock fetch in vitest,
 * the global fetch in the browser).
 */
import { createContext, useContext, type ReactNode, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from './client';

const ApiClientContext = createContext<ApiClient | undefined>(undefined);

export function ApiClientProvider(props: {
  client?: ApiClient;
  children: ReactNode;
}): ReactElement {
  const client = props.client ?? createApiClient();
  return <ApiClientContext.Provider value={client}>{props.children}</ApiClientContext.Provider>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === undefined) {
    throw new Error('useApiClient must be used inside <ApiClientProvider>');
  }
  return client;
}
