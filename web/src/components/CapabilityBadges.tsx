/**
 * Capability + known-broken badges (§5.10 / D3): the standing
 * ecosystem metric (§15) is rendered per module in Settings — every
 * flag the registry detected is visible, no silent breakage.
 *
 * Design-system retrofit: the vendored Badge on semantic variants
 * (destructive / secondary / default); titles and texts unchanged.
 */
import type { ReactElement } from 'react';
import type { ModuleSummaryT } from '../api/hooks';
import { Badge } from '@/components/ui/badge';

export function CapabilityBadges(props: { module: ModuleSummaryT }): ReactElement {
  const caps = props.module.capabilities;
  return (
    <ul className="badge-list flex list-none flex-wrap items-center gap-1 p-0" aria-label={`Capability flags for ${props.module.name}`}>
      {caps.known_broken_flags.map((flag): ReactElement => (
        <li key={`broken-${flag}`}>
          <Badge variant="destructive" className="badge-broken" title={`Upstream regression flag (D3): ${flag}`}>known broken: {flag}</Badge>
        </li>
      ))}
      {caps.requires_browser ? (
        <li>
          <Badge variant="secondary" className="badge-capability" title="Module requires the browser/antibot sidecar profile (D2)">needs browser</Badge>
        </li>
      ) : null}
      {caps.requires_subprocess ? (
        <li>
          <Badge variant="secondary" className="badge-capability" title="Module shells out to a subprocess (7z/python-gated helpers)">subprocess</Badge>
        </li>
      ) : null}
      {caps.bypass_python_gated ? (
        <li>
          <Badge variant="secondary" className="badge-capability" title="Module carries python-gated bypass code">bypass-gated</Badge>
        </li>
      ) : null}
      {caps.live_scrape_fallback ? (
        <li>
          <Badge
            variant="secondary"
            className="badge-capability"
            title="§6.8: no FMD2-DB catalog — Browse serves this module live from its directory walk (§5.8-normalized, TTL-cached)"
          >
            live-scrape browse
          </Badge>
        </li>
      ) : null}
      {props.module.accountSupport ? (
        <li>
          <Badge variant="default" className="badge-account" title="Module supports account login">account</Badge>
        </li>
      ) : null}
    </ul>
  );
}
