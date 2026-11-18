/**
 * BottomTabNav (design system shell pattern, R3 mobile parity): the
 * fixed thumb-reach tab bar the app shell mounts BELOW md (768px) —
 * the top tab nav keeps the >=md surface, and BOTH render the exact
 * same destinations (identical routes on mobile and desktop; layout
 * adapts, capability does not).
 *
 * Pattern contract: max 5 destinations, icon + label each, every
 * target >= the 44px touch token, and the bar respects the
 * notched-device home-indicator inset via the safe-area token —
 * the shell pads the content flow by the same band so nothing
 * scrolls under the bar unreachable.
 */
import type { ReactElement, ReactNode } from 'react';
import { cn } from 'cn';

/** One destination: route name (hash `#/name`), label, icon. */
export interface BottomTabDestination {
  readonly name: string;
  readonly label: string;
  readonly icon: ReactNode;
}

/**
 * R5 arrival: per-destination nav badge (keyed by destination name) —
 * the Downloads tab's live queue count and/or completion dot.
 */
export interface BottomTabBadge {
  readonly count?: number;
  readonly dot?: boolean;
}

export function BottomTabNav(props: {
  readonly destinations: readonly BottomTabDestination[];
  readonly current: string;
  /** R5 arrival: optional per-destination badge (e.g. downloads queue). */
  readonly badges?: Readonly<Record<string, BottomTabBadge | undefined>>;
}): ReactElement {
  return (
    <nav
      aria-label="Primary"
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur-sm md:hidden"
    >
      <div className="mx-auto grid w-full max-w-page grid-cols-5 pb-[var(--spacing-safe-bottom)]">
        {props.destinations.map(
          (destination): ReactElement => {
            const badge = props.badges?.[destination.name];
            const showCount = badge !== undefined && (badge.count ?? 0) > 0;
            const showDot = badge?.dot === true;
            return (
              <a
                key={destination.name}
                href={`#/${destination.name}`}
                data-testid={`bottom-nav-${destination.name}`}
                aria-current={props.current === destination.name ? 'page' : undefined}
                aria-label={
                  showCount
                    ? `${destination.label}, ${badge && badge.count !== undefined ? String(badge.count) : ''} active`
                    : undefined
                }
                className={cn(
                  'flex min-h-touch-target flex-col items-center justify-center gap-0.5 px-1 py-1.5',
                  'text-[11px] font-medium text-muted-foreground transition-colors',
                  'aria-[current=page]:text-primary',
                )}
              >
                <span aria-hidden="true" className="relative [&_svg]:size-5">
                  {destination.icon}
                  {showCount ? (
                    <span
                      data-testid={`bottom-nav-${destination.name}-badge`}
                      className="absolute -top-1.5 -right-2 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 py-px text-[11px] leading-none font-semibold text-primary-foreground"
                    >
                      {(badge?.count ?? 0) > 99 ? '99+' : String(badge?.count ?? 0)}
                    </span>
                  ) : null}
                  {showDot && !showCount ? (
                    <span
                      data-testid={`bottom-nav-${destination.name}-dot`}
                      aria-hidden="true"
                      className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </span>
                {destination.label}
              </a>
            );
          },
        )}
      </div>
    </nav>
  );
}
