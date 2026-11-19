/**
 * SiteRow (site-first browse): one ENABLED site in the picker — the
 * FMD2 cbSelectManga parity row: the site NAME is the primary identity
 * (hex module ids are carried in the URL, never rendered as text the
 * user must read or type). Capability badges (§5.10/§15) + the
 * catalog-state chip ride along; a known-broken module (D3 flags) is
 * disabled with its reason surfaced — FMD2 hides unchecked sites, the
 * web shows standing breakage instead of a mystery failure.
 */
import type { ReactElement, MouseEventHandler } from 'react';
import { Star, WifiOff } from 'lucide-react';
import type { ModuleSummaryT } from '../api/hooks';
import { availabilityTitle } from './AvailabilityChip';
import { CapabilityBadges } from './CapabilityBadges';
import { CatalogStateChip } from './CatalogStateChip';
import { Badge } from '@/components/ui/badge';
import { cn } from 'cn';

export function siteRowDisabledReason(module: ModuleSummaryT): string | undefined {
  if (module.capabilities.known_broken_flags.length === 0) return undefined;
  return (
    `Known broken upstream (${module.capabilities.known_broken_flags.join(', ')}); ` +
    'the site adapter fails against the live site until an upstream fix lands.'
  );
}

/** Dead-site discovery: an unreachable LAST CHECK dims the row as a HINT
 * (never a gate — the row stays fully clickable; the site may be back). */
export function siteRowUnavailable(module: ModuleSummaryT): boolean {
  return module.availability.status === 'unreachable';
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function SiteRow(props: {
  module: ModuleSummaryT;
  onPick: (module: ModuleSummaryT) => void;
  /**
   * [fuzzy-javelin-pearls] Preferred-sites star: present when the
   * embedding surface offers the allowlist affordance (the picker);
   * absent everywhere else — the row renders identically to before.
   */
  isPreferred?: boolean;
  /** Pending mutation → the star disables (one decision in flight). */
  onTogglePreferred?: (module: ModuleSummaryT) => void;
}): ReactElement {
  const { module } = props;
  const brokenReason = siteRowDisabledReason(module);
  const disabled = brokenReason !== undefined;
  const unavailable = !disabled && siteRowUnavailable(module);
  const unavailableTitle = unavailable ? availabilityTitle(module.availability) : undefined;
  const host = safeHost(module.rootURL);
  const onClick: MouseEventHandler<HTMLButtonElement> = (): void => {
    props.onPick(module);
  };
  return (
    <div
      data-site-id={module.id}
      data-unavailable={unavailable ? 'true' : undefined}
      data-preferred={props.isPreferred === true ? 'true' : undefined}
      className={cn(
        'site-row flex w-full items-stretch gap-1',
        disabled ? 'opacity-60' : '',
        unavailable ? 'site-row-unavailable opacity-70' : '',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={brokenReason ?? unavailableTitle}
        aria-label={`${module.name}: browse ${module.category}${
          disabled
            ? ' (unavailable: known broken upstream)'
            : unavailable
              ? ' (last check failed — the site may be back, picking it still works)'
              : ''
        }`}
        className={cn(
          'flex min-w-0 flex-1 flex-col items-start gap-1 rounded-md px-3 py-2 text-left',
          'transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span className="flex w-full flex-wrap items-center gap-2">
          <span className="site-name min-w-0 flex-1 truncate text-sm font-medium">{module.name}</span>
          <CatalogStateChip module={module} />
          {unavailable ? (
            <Badge
              variant="secondary"
              className="availability-chip-down"
              title={unavailableTitle}
              data-testid={`site-unavailable-${module.id}`}
            >
              <WifiOff aria-hidden="true" className="size-3" />
              unreachable
            </Badge>
          ) : null}
          {disabled ? (
            <Badge variant="destructive" className="badge-broken" title={brokenReason}>
              known broken: {module.capabilities.known_broken_flags[0]}
              {module.capabilities.known_broken_flags.length > 1
                ? ` +${String(module.capabilities.known_broken_flags.length - 1)}`
                : ''}
            </Badge>
          ) : null}
        </span>
        <span className="site-meta text-xs text-muted-foreground">
          {module.category}
          {host !== '' ? ` · ${host}` : ''}
        </span>
        <CapabilityBadges module={module} />
      </button>
      {props.onTogglePreferred !== undefined ? (
        <button
          type="button"
          onClick={(): void => {
            props.onTogglePreferred?.(module);
          }}
          disabled={disabled}
          title={
            props.isPreferred === true
              ? `Remove ${module.name} from preferred sites`
              : `Add ${module.name} to preferred sites (searches prefer it)`
          }
          aria-label={
            props.isPreferred === true
              ? `${module.name}: remove from preferred sites`
              : `${module.name}: add to preferred sites`
          }
          aria-pressed={props.isPreferred === true}
          data-testid={`prefer-toggle-${module.id}`}
          className={cn(
            'flex w-11 shrink-0 items-center justify-center rounded-md',
            'transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            props.isPreferred === true ? 'text-amber-500' : 'text-muted-foreground',
          )}
        >
          <Star
            aria-hidden="true"
            className={cn('size-4', props.isPreferred === true ? 'fill-current' : '')}
          />
        </button>
      ) : null}
    </div>
  );
}
