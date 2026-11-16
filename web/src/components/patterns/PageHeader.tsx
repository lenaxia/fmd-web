/**
 * PageHeader (design system pattern): every page's title block —
 * consistent h-level, description and actions rhythm so all six tabs
 * read as one product. Patterns own the spacing scale; pages never
 * hand-roll margins.
 */
import type { ReactElement, ReactNode } from 'react';
import { cn } from 'cn';

export function PageHeader(props: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div className={cn('mb-6 flex flex-wrap items-start justify-between gap-4', props.className)}>
      <div className="min-w-0">
        <h2 className="text-2xl font-semibold tracking-tight">{props.title}</h2>
        {props.description !== undefined ? (
          <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      {props.actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}
