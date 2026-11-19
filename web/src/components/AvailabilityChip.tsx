/**
 * AvailabilityChip (dead-site discovery): the LAST-CHECK status marker
 * for one site — an icon plus a checked_at tooltip that carries the
 * failure reason. A DIFFERENT concern from CatalogStateChip (catalog =
 * list readiness; availability = last observed site reachability), so
 * its tooltip and label always say "Last check", never "Catalog".
 *
 * Token discipline: no color literals — the icon rides the existing
 * token utilities (success / destructive / muted-foreground).
 */
import type { ReactElement } from 'react';
import { CircleCheck, CircleHelp, WifiOff } from 'lucide-react';
import type { ModuleAvailabilityT } from '../api/hooks';
import { cn } from 'cn';

/** Compact relative age for the tooltip ("just now" / "3 h ago" / "2 d ago"). */
export function formatCheckedAgo(checkedAt: string | null): string {
  if (checkedAt === null) {
    return 'never checked';
  }
  const ms: number = Date.now() - new Date(checkedAt).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) {
    return 'just now';
  }
  const minutes: number = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  const hours: number = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} h ago`;
  }
  const days: number = Math.floor(hours / 24);
  return `${String(days)} d ago`;
}

/** The tooltip text: status + age + reason (when unreachable). */
export function availabilityTitle(availability: ModuleAvailabilityT): string {
  if (availability.status === 'unknown') {
    return 'Last check: never (status becomes visible once the site is used or checked)';
  }
  const when: string = formatCheckedAgo(availability.checkedAt);
  if (availability.status === 'reachable') {
    return `Last check: reachable (${when})`;
  }
  const reason: string = (availability.reason ?? '').trim();
  return `Last check: unreachable (${when})${reason === '' ? '' : ` — ${reason}`}`;
}

const SHAPE: Record<
  ModuleAvailabilityT['status'],
  { readonly icon: ReactElement; readonly className: string; readonly label: string }
> = {
  reachable: {
    icon: <CircleCheck aria-hidden="true" />,
    className: 'availability-chip-ok text-(--success)',
    label: 'Site reachable at last check',
  },
  unreachable: {
    icon: <WifiOff aria-hidden="true" />,
    className: 'availability-chip-down text-destructive',
    label: 'Site unreachable at last check',
  },
  unknown: {
    icon: <CircleHelp aria-hidden="true" />,
    className: 'availability-chip-unknown text-muted-foreground',
    label: 'Never checked',
  },
};

export function AvailabilityChip(props: {
  readonly availability: ModuleAvailabilityT;
  /** Optional test hook (registry rows carry stable module ids). */
  readonly testId?: string;
}): ReactElement {
  const shape = SHAPE[props.availability.status];
  const title: string = availabilityTitle(props.availability);
  return (
    <span
      className={cn('availability-chip inline-flex size-4 items-center justify-center', shape.className)}
      title={title}
      aria-label={title}
      role="img"
      {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
    >
      {shape.icon}
    </span>
  );
}
