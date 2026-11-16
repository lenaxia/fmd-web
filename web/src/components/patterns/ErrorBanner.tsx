/**
 * ErrorBanner (design system pattern): renders the §10 typed error
 * envelope as user-visible feedback (code + message) with an alert
 * role — replaces the hand-rolled components/ErrorBanner with the
 * same contract on token styling (destructive surface).
 */
import type { ReactElement } from 'react';
import { CircleAlert } from 'lucide-react';
import { ApiError } from '@/api/errors';

export function ErrorBanner(props: { error: unknown }): ReactElement {
  const err = props.error;
  const code = err instanceof ApiError ? err.code : 'error';
  const message = err instanceof Error ? err.message : String(err);
  return (
    <p
      role="alert"
      aria-live="assertive"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span>
        <strong className="font-semibold text-destructive">{code}</strong> {message}
      </span>
    </p>
  );
}
