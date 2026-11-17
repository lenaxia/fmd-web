/**
 * UnionSearchChips — the all-sites search meta rows (FMD2 parity:
 * every union row carries its website; sites that could not answer are
 * named, never silently dropped):
 *
 * - FACET chips: per-site result counts. Clicking one routes into that
 *   site's browse context with the current query (site-scoped search).
 * - WARNING chips: catalogs that failed — the typed partial state from
 *   GET /api/search (a broken site yields the rest of the union).
 * - EXCLUDED chips: enabled sites without an installed catalog — the
 *   union is over INSTALLED catalogs only (FMD2 unions installed DBs),
 *   and the chip explains why the site is missing.
 */
import type { ReactElement } from 'react';
import { AlertTriangle, FolderX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ExcludedSiteT, SearchFacetT, SiteSearchFailureT } from '../../api/hooks';

export function FacetChips(props: {
  facets: readonly SearchFacetT[];
  onPickSite: (siteId: string) => void;
}): ReactElement | null {
  if (props.facets.length === 0) {
    return null;
  }
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-1.5"
      aria-label="Per-site result counts"
      data-testid="search-facets"
    >
      {props.facets.map((facet): ReactElement => (
        <Button
          key={facet.siteId}
          type="button"
          variant="outline"
          size="sm"
          className="facet-chip h-6 rounded-full px-2 text-xs"
          title={`Search only ${facet.siteName}`}
          onClick={(): void => {
            props.onPickSite(facet.siteId);
          }}
        >
          {facet.siteName}
          {facet.count !== undefined ? (
            <span className="ml-1 text-muted-foreground">{facet.count}</span>
          ) : null}
        </Button>
      ))}
    </div>
  );
}

export function UnionWarningChips(props: {
  warnings: readonly SiteSearchFailureT[];
}): ReactElement | null {
  if (props.warnings.length === 0) {
    return null;
  }
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-1.5"
      aria-label="Sites that failed to answer"
      data-testid="search-warnings"
    >
      {props.warnings.map((warning): ReactElement => (
        <Badge
          key={warning.siteId}
          variant="destructive"
          className="warning-chip gap-1"
          title={warning.error}
        >
          <AlertTriangle aria-hidden="true" className="size-3" />
          {warning.siteName} didn’t answer
        </Badge>
      ))}
    </div>
  );
}

export function UnionExcludedChips(props: {
  excluded: readonly ExcludedSiteT[];
}): ReactElement | null {
  if (props.excluded.length === 0) {
    return null;
  }
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-1.5"
      aria-label="Sites excluded from the all-sites search"
      data-testid="search-excluded"
    >
      {props.excluded.map((site): ReactElement => (
        <Badge
          key={site.siteId}
          variant="secondary"
          className="excluded-chip gap-1"
          title="FMD2 parity: the all-sites search unions installed local lists — a site without one is skipped, not fetched from the site."
        >
          <FolderX aria-hidden="true" className="size-3" />
          {site.siteName}: no catalog installed
        </Badge>
      ))}
    </div>
  );
}
