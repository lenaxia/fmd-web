/**
 * CatalogStateChip (site-first browse): the per-site readiness chip
 * rendered in the SitePicker — the `catalogInstalled` join from
 * /api/modules (CatalogStore receipts, §6.4). Never shows the catalog
 * id: state, not identity (FMD2 parity — cbSelectManga lists sites BY
 * NAME). The unified browsing model keeps this binary: a catalog-less
 * site simply prepares (or opens from the site) on selection — no
 * mode vocabulary on the chip.
 */
import type { ReactElement } from 'react';
import type { ModuleSummaryT } from '../api/hooks';
import { Badge } from '@/components/ui/badge';

export type CatalogChipState = 'installed' | 'not-installed';

export function catalogChipState(module: ModuleSummaryT): CatalogChipState {
  return module.catalogInstalled ? 'installed' : 'not-installed';
}

const CHIP: Record<CatalogChipState, { label: string; title: string; className: string }> = {
  installed: {
    label: 'ready',
    title: 'The site’s list is ready — it opens instantly',
    className: 'catalog-chip-installed',
  },
  'not-installed': {
    label: 'needs setup',
    title: 'Prepared automatically the first time you open this site',
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
