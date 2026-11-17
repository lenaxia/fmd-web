/**
 * CatalogStateChip (site-first browse): the per-site catalog install
 * chip rendered in the SitePicker — the `catalogInstalled` join from
 * /api/modules (CatalogStore receipts, §6.4) plus the §6.8
 * live-scrape capability. Never shows the catalog id: state, not
 * identity (FMD2 parity — cbSelectManga lists sites BY NAME).
 */
import type { ReactElement } from 'react';
import type { ModuleSummaryT } from '../api/hooks';
import { Badge } from '@/components/ui/badge';

export type CatalogChipState = 'installed' | 'live-only' | 'not-installed';

export function catalogChipState(module: ModuleSummaryT): CatalogChipState {
  if (module.catalogInstalled) return 'installed';
  return module.capabilities.live_scrape_fallback ? 'live-only' : 'not-installed';
}

const CHIP: Record<CatalogChipState, { label: string; title: string; className: string }> = {
  installed: {
    label: 'catalog ready',
    title: 'The site’s FMD2-DB catalog is installed — entries open instantly',
    className: 'catalog-chip-installed',
  },
  'live-only': {
    label: 'live browse',
    title:
      'No FMD2-DB catalog yet — this site can be browsed live from its directory walk (§6.8), or provisioned on demand',
    className: 'catalog-chip-live',
  },
  'not-installed': {
    label: 'needs setup',
    title: 'No catalog installed — selecting this site provisions it automatically',
    className: 'catalog-chip-missing',
  },
};

export function CatalogStateChip(props: { module: ModuleSummaryT }): ReactElement {
  const chip = CHIP[catalogChipState(props.module)];
  return (
    <Badge variant="secondary" className={chip.className} title={chip.title}>
      {chip.label}
    </Badge>
  );
}
