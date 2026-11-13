/**
 * Explicit empty-state guidance (D20): nothing is ever an unexplained
 * blank page — first-run bootstrap (auto module+catalog sync) progress
 * is surfaced with an action button and what-to-do-next copy.
 */
import type { ReactElement, ReactNode } from 'react';

export function EmptyState(props: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <section className="empty-state" aria-live="polite">
      <h2>{props.title}</h2>
      <div className="empty-state-body">{props.children}</div>
      {props.action !== undefined ? <div className="empty-state-action">{props.action}</div> : null}
    </section>
  );
}
