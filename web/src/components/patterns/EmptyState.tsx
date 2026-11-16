/**
 * EmptyState (design system pattern): explicit empty-state guidance
 * (D20) — nothing is ever an unexplained blank page. Replaces the
 * hand-rolled components/EmptyState with the same contract (title,
 * body, optional action) on token styling.
 */
import type { ReactElement, ReactNode } from 'react';

export function EmptyState(props: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <section
      aria-live="polite"
      className="rounded-xl border border-dashed border-border bg-surface/40 px-6 py-10 text-center"
    >
      <h2 className="text-lg font-semibold">{props.title}</h2>
      <div className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground [&_p]:mt-2">
        {props.children}
      </div>
      {props.action !== undefined ? <div className="mt-4 flex justify-center">{props.action}</div> : null}
    </section>
  );
}
