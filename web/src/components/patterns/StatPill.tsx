/**
 * StatPill (design system pattern): compact, muted inline statistic
 * ("Showing 20 of 2 400 entries", "12 chapters", live-stream state).
 * Pure presentation on tokens — no role of its own, so pages keep
 * their precise aria-live semantics alongside it.
 */
import type { ReactElement, ReactNode } from 'react';
import { cn } from 'cn';

export function StatPill(props: { children: ReactNode; className?: string }): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border bg-surface px-2.5 py-0.5',
        'text-xs text-muted-foreground',
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}
