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
import type { ModuleSummaryT } from '../api/hooks';
import { CapabilityBadges } from './CapabilityBadges';
import { CatalogStateChip } from './CatalogStateChip';
import { Badge } from '@/components/ui/badge';
import { cn } from 'cn';

export function siteRowDisabledReason(module: ModuleSummaryT): string | undefined {
  if (module.capabilities.known_broken_flags.length === 0) return undefined;
  return (
    `Known broken upstream (${module.capabilities.known_broken_flags.join(', ')}) — ` +
    'the site adapter fails against the live site until an upstream fix lands.'
  );
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
}): ReactElement {
  const { module } = props;
  const brokenReason = siteRowDisabledReason(module);
  const disabled = brokenReason !== undefined;
  const host = safeHost(module.rootURL);
  const onClick: MouseEventHandler<HTMLButtonElement> = (): void => {
    props.onPick(module);
  };
  return (
    <div
      data-site-id={module.id}
      className={cn('site-row w-full', disabled ? 'opacity-60' : '')}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={brokenReason}
        aria-label={`${module.name} — browse ${module.category}${disabled ? ' (unavailable: known broken upstream)' : ''}`}
        className={cn(
          'flex w-full flex-col items-start gap-1 rounded-md px-3 py-2 text-left',
          'transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span className="flex w-full flex-wrap items-center gap-2">
          <span className="site-name min-w-0 flex-1 truncate text-sm font-medium">{module.name}</span>
          <CatalogStateChip module={module} />
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
    </div>
  );
}
