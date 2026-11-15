/**
 * Capability + known-broken badges (§5.10 / D3): the standing
 * ecosystem metric (§15) is rendered per module in Settings — every
 * flag the registry detected is visible, no silent breakage.
 */
import type { ReactElement } from 'react';
import type { ModuleSummaryT } from '../api/hooks';

export function Badge(props: { kind: 'broken' | 'capability' | 'account'; label: string; title: string }): ReactElement {
  return (
    <span className={`badge badge-${props.kind}`} title={props.title}>
      {props.label}
    </span>
  );
}

export function CapabilityBadges(props: { module: ModuleSummaryT }): ReactElement {
  const caps = props.module.capabilities;
  return (
    <ul className="badge-list" aria-label={`Capability flags for ${props.module.name}`}>
      {caps.known_broken_flags.map((flag): ReactElement => (
        <li key={`broken-${flag}`}>
          <Badge kind="broken" label={`known broken: ${flag}`} title={`Upstream regression flag (D3): ${flag}`} />
        </li>
      ))}
      {caps.requires_browser ? (
        <li>
          <Badge kind="capability" label="needs browser" title="Module requires the browser/antibot sidecar profile (D2)" />
        </li>
      ) : null}
      {caps.requires_subprocess ? (
        <li>
          <Badge kind="capability" label="subprocess" title="Module shells out to a subprocess (7z/python-gated helpers)" />
        </li>
      ) : null}
      {caps.bypass_python_gated ? (
        <li>
          <Badge kind="capability" label="bypass-gated" title="Module carries python-gated bypass code" />
        </li>
      ) : null}
      {caps.live_scrape_fallback ? (
        <li>
          <Badge
            kind="capability"
            label="live-scrape browse"
            title="§6.8: no FMD2-DB catalog — Browse serves this module live from its directory walk (§5.8-normalized, TTL-cached)"
          />
        </li>
      ) : null}
      {props.module.accountSupport ? (
        <li>
          <Badge kind="account" label="account" title="Module supports account login" />
        </li>
      ) : null}
    </ul>
  );
}
