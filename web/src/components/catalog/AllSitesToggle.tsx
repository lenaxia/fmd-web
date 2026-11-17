/**
 * AllSitesToggle (FMD2 cbSearchFromAllSites parity, frmMain.pas:335):
 * the checkbox beside the search bar that switches between the open
 * site's catalog and the UNION over every installed catalog. Purely a
 * controlled input — routing (browse?site=… ⇄ browse?allsites=1) is
 * the parent's business.
 */
import type { ReactElement } from 'react';
import { Checkbox } from '@/components/ui/checkbox';

export function AllSitesToggle(props: {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Disables the control (e.g. no installed catalogs at all). */
  disabled?: boolean;
}): ReactElement {
  const id = props.id ?? 'all-sites-toggle';
  return (
    <span className="flex items-center gap-2" data-testid="all-sites-toggle">
      <Checkbox
        id={id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(value): void => {
          props.onChange(value === true);
        }}
      />
      <label htmlFor={id} className="cursor-pointer text-sm font-normal">
        All sites
      </label>
    </span>
  );
}
