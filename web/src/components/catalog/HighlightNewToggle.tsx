/**
 * HighlightNewToggle (browse-list polish): the list-level 'Highlight
 * new' checkbox (FMD2 miHighlightNewManga parity, frmMain.lfm:5817 +
 * pas:2465-2468 — the FMD2 control lives in the list context menu; the
 * web adaptation is this persistent FilterBar control). Checked state
 * is workspace-global and persisted locally (localStorage — the
 * settingsfile stand-in), default ON like FMD2's ReadBool(..., True).
 * The accent window reuses the filter's only-new day setting (the
 * panel's 'Only new' chip) — the shared OptionNewMangaTime model.
 */
import type { ReactElement } from 'react';
import { useHighlightNew } from '../../state/highlight-new';
import { Checkbox } from '@/components/ui/checkbox';

export function HighlightNewToggle(): ReactElement {
  const [enabled, setEnabled] = useHighlightNew();
  return (
    <label
      htmlFor="highlight-new-toggle"
      className="flex items-center gap-1.5 text-sm"
      data-highlight-new={enabled ? 'on' : 'off'}
    >
      <Checkbox
        id="highlight-new-toggle"
        checked={enabled}
        onCheckedChange={(value): void => {
          setEnabled(value === true);
        }}
        aria-label="Highlight new manga"
        data-testid="highlight-new-toggle"
      />
      Highlight new
    </label>
  );
}
