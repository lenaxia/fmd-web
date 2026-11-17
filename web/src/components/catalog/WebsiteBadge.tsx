/**
 * WebsiteBadge (FMD2 parity, frmMain.pas:5170 vtMangaListGetHint):
 * when the all-sites filter is on, every result row shows its source
 * WEBSITE — RS_InfoWebsite + the module's name. The badge names the
 * site (via the /api/modules join); the hex id never reaches the UI.
 */
import type { ReactElement } from 'react';
import { Globe } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function WebsiteBadge(props: { siteName: string; siteId?: string }): ReactElement {
  return (
    <Badge
      variant="outline"
      className="website-badge"
      data-site={props.siteId}
      title={`Website: ${props.siteName}`}
    >
      <Globe aria-hidden="true" className="size-3" />
      {props.siteName}
    </Badge>
  );
}
