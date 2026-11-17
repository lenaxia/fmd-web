/**
 * SourceBadge (unified browsing): the subtle per-list transparency
 * badge — which channel served the open list. Plumbing-free by
 * charter: the labels are user-facing ('from site' / 'from catalog'),
 * the tooltips carry the one-line explanation; the words 'scrape',
 * 'live browse' and any mode names never appear. Muted by design
 * (secondary variant, muted foreground) — transparency, not a
 * decision point.
 */
import type { ReactElement } from 'react';
import { Badge } from '@/components/ui/badge';

/** The §6.8 page discriminator carried by every catalog response. */
export type ListSource = 'catalog' | 'live';

const SOURCE: Record<ListSource, { label: string; title: string }> = {
  live: {
    label: 'from site',
    title: 'List fetched live from the site',
  },
  catalog: {
    label: 'from catalog',
    title: 'Prebuilt list from FMD2-DB',
  },
};

export function SourceBadge(props: { source: ListSource }): ReactElement {
  const source = SOURCE[props.source];
  return (
    <Badge
      variant="secondary"
      className="badge-source text-muted-foreground"
      data-source={props.source}
      title={source.title}
    >
      {source.label}
    </Badge>
  );
}
