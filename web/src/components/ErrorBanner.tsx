/**
 * Error banner: renders the §10 typed error envelope as user-visible
 * feedback (code + message) with an aria-live region.
 */
import type { ReactElement } from 'react';
import { ApiError } from '../api/errors';

export function ErrorBanner(props: { error: unknown }): ReactElement {
  const err = props.error;
  const code = err instanceof ApiError ? err.code : 'error';
  const message = err instanceof Error ? err.message : String(err);
  return (
    <p role="alert" className="error-banner" aria-live="assertive">
      <strong>{code}</strong> {message}
    </p>
  );
}
