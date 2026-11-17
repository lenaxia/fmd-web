/**
 * EnqueueOptions (MangaPage parity, FMD2 cbAddAsStopped —
 * frmMain.lfm:1110 — + edSaveTo per-manga override, frmMain.pas:5613):
 * the enqueue extras row. 'Start paused' creates jobs held until
 * resumed (POST /api/jobs/:id/resume); 'Save to' overrides the
 * finalize directory. The save-to value persists per manga
 * (localStorage — the client-side stand-in until the favorites story
 * owns it server-side) and is recalled whenever the page reopens.
 */
import type { ReactElement } from 'react';
import { FolderInput } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from 'cn';

export interface EnqueueExtras {
  readonly paused: boolean;
  readonly saveTo: string;
}

export const DEFAULT_ENQUEUE_EXTRAS: EnqueueExtras = { paused: false, saveTo: '' };

function saveToKey(moduleId: string, url: string): string {
  return `fmd:saveto:${moduleId}|${url}`;
}

/** Per-manga save-to persistence (recall on mount, store on change). */
export function loadSaveTo(moduleId: string, url: string): string {
  try {
    return globalThis.localStorage?.getItem(saveToKey(moduleId, url)) ?? '';
  } catch {
    return '';
  }
}

export function storeSaveTo(moduleId: string, url: string, value: string): void {
  try {
    if (value === '') {
      globalThis.localStorage?.removeItem(saveToKey(moduleId, url));
    } else {
      globalThis.localStorage?.setItem(saveToKey(moduleId, url), value);
    }
  } catch {
    // private-browsing/quota — persistence is best-effort
  }
}

export function EnqueueOptions(props: {
  moduleId: string;
  url: string;
  extras: EnqueueExtras;
  onExtrasChange: (extras: EnqueueExtras) => void;
  className?: string;
}): ReactElement {
  const { extras } = props;

  return (
    <div
      role="group"
      aria-label="Enqueue options"
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', props.className)}
    >
      <label htmlFor="enqueue-start-paused" className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          id="enqueue-start-paused"
          type="checkbox"
          className="size-4 accent-(--primary)"
          checked={extras.paused}
          onChange={(e): void => {
            props.onExtrasChange({ ...extras, paused: e.target.checked });
          }}
        />
        Start paused
      </label>
      <label htmlFor="enqueue-save-to" className="flex items-center gap-2 text-sm">
        <FolderInput aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-muted-foreground">Save to</span>
        <Input
          id="enqueue-save-to"
          type="text"
          aria-label="Save to directory"
          placeholder="library/<site>/<manga> (default)"
          value={extras.saveTo}
          onChange={(e): void => {
            const value = e.target.value;
            props.onExtrasChange({ ...extras, saveTo: value });
            storeSaveTo(props.moduleId, props.url, value);
          }}
          className="h-8 w-64"
        />
      </label>
    </div>
  );
}
