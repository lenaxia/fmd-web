/**
 * ImportFavoritesDialog (favorites-parity): the frmImportFavorites
 * ADAPT. FMD2 reads a favorites.db SQLite file (FMD1/FMD2 layouts —
 * frmImportFavorites.pas:58-175: moduleid/website/link/title/…); the
 * web parity imports a JSON list carrying the SAME FMD2 field names
 * (`moduleid`/`website`/`link`/`title`) or the fmd-web wire names
 * (`moduleId`/`url`/`title`) — every entry round-trips the EXISTING
 * POST /api/favorites/import (tag-100: all live chapters land marked
 * downloaded, nothing re-downloads), with a per-row result report.
 */
import { useRef, useState, type ReactElement } from 'react';
import { FileUp, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { Badge } from '@/components/ui/badge';
import { useImportFavorite, type ModuleSummaryT } from '../../api/hooks';

/** One parsed list entry (either field-naming accepted). */
export interface ImportEntry {
  readonly moduleId: string;
  readonly url: string;
  readonly title: string;
  readonly label: string;
}

/** Raw row shapes the parser accepts (FMD2 db names + fmd-web names). */
type RawEntry = Partial<Record<'moduleId' | 'moduleid' | 'url' | 'link' | 'title', string>>;

export type ImportRowStatus = 'pending' | 'imported' | 'failed';

export interface ImportRow {
  readonly entry: ImportEntry;
  readonly status: ImportRowStatus;
  readonly error?: string;
}

/**
 * Parse + resolve an imported list: `moduleid` wins, else `website` is
 * matched against the installed site names (FMD2 LocateModule /
 * LocateModuleByHost parity); unresolvable rows surface as errors in
 * the report (never imported).
 */
export function parseImportList(
  text: string,
  modules: readonly ModuleSummaryT[],
): { rows: ImportRow[]; parseError: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { rows: [], parseError: 'not a valid JSON list file' };
  }
  const list = Array.isArray(parsed) ? parsed : null;
  if (list === null) {
    return { rows: [], parseError: 'the file must be a JSON array of favorites' };
  }
  const byName = new Map(
    modules.map((module): [string, ModuleSummaryT] => [module.name.toLowerCase(), module]),
  );
  const rows: ImportRow[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const raw = item as RawEntry & { website?: string };
    const moduleId = raw['moduleId'] ?? raw['moduleid'] ?? '';
    const websiteName = typeof raw['website'] === 'string' ? raw['website'] : '';
    const resolved =
      moduleId !== ''
        ? modules.find((module): boolean => module.id.toLowerCase() === moduleId.toLowerCase())
        : byName.get(websiteName.toLowerCase());
    const url = raw['url'] ?? raw['link'] ?? '';
    const title = raw['title'] ?? '';
    const label = `${title !== '' ? title : url} <${resolved?.name ?? websiteName}${url}>`;
    if (resolved === undefined || url === '') {
      rows.push({
        entry: { moduleId, url, title, label },
        status: 'failed',
        error: url === '' ? 'missing link' : 'website not installed',
      });
      continue;
    }
    rows.push({
      entry: { moduleId: resolved.id, url, title, label },
      status: 'pending',
    });
  }
  return { rows, parseError: null };
}

export function ImportFavoritesDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly modules: readonly ModuleSummaryT[];
  readonly onImported: () => void;
}): ReactElement {
  const { open, onClose, modules, onImported } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const importFavorite = useImportFavorite();

  const close = (): void => {
    setFileName('');
    setRows([]);
    setParseError(null);
    setRunning(false);
    importFavorite.reset();
    onClose();
  };

  const loadFile = (file: File): void => {
    setFileName(file.name);
    // FileReader (not File.text()) — the broader-compatibility read.
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = parseImportList(String(reader.result), modules);
      setRows(result.rows);
      setParseError(result.parseError);
    };
    reader.readAsText(file);
  };

  const pending = rows.filter((row): boolean => row.status === 'pending');
  const imported = rows.filter((row): boolean => row.status === 'imported').length;
  const failed = rows.filter((row): boolean => row.status === 'failed').length;

  const runImport = (): void => {
    setRunning(true);
    void (async (): Promise<void> => {
      const next: ImportRow[] = [...rows];
      for (let index = 0; index < next.length; index += 1) {
        const current = next[index];
        if (current === undefined || current.status !== 'pending') {
          continue;
        }
        const entry = current.entry;
        try {
          await importFavorite.mutateAsync({
            moduleId: entry.moduleId,
            url: entry.url,
            ...(entry.title !== '' ? { title: entry.title } : {}),
          });
          next[index] = { entry, status: 'imported' };
        } catch (error) {
          next[index] = {
            entry,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      setRows([...next]);
      setRunning(false);
      onImported();
    })();
  };

  return (
    <Dialog open={open} onOpenChange={(next): void => { if (!next) close(); }}>
      <DialogContent className="import-favorites-dialog max-w-lg" data-testid="import-favorites-dialog">
        <DialogHeader>
          <DialogTitle>Import favorites list</DialogTitle>
          <DialogDescription>
            frmImportFavorites parity (ADAPT): a JSON list of favorites —
            FMD2 field names (`moduleid`/`website`/`link`/`title`) or the
            fmd-web names. Every entry imports marked fully downloaded
            (nothing re-downloads).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-1">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            data-testid="import-file-input"
            onChange={(event): void => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                loadFile(file);
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            data-testid="import-choose-file"
            onClick={(): void => fileInput.current?.click()}
          >
            <FileUp aria-hidden="true" />
            {fileName === '' ? 'Choose list file…' : fileName}
          </Button>

          {parseError !== null ? (
            <p role="alert" className="text-sm text-destructive" data-testid="import-parse-error">
              {parseError}
            </p>
          ) : null}

          {rows.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground" data-testid="import-summary">
                {imported} imported · {failed} failed · {pending.length} pending
              </p>
              <ul
                className="import-report max-h-56 divide-y overflow-y-auto rounded-md border"
                aria-label="Import report"
                data-testid="import-report"
              >
                {rows.map((row, index): ReactElement => (
                  <li key={`${row.entry.url}-${String(index)}`} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate" title={row.entry.label}>
                      {row.entry.label}
                    </span>
                    {row.status === 'imported' ? (
                      <Badge variant="success">imported</Badge>
                    ) : row.status === 'failed' ? (
                      <Badge variant="destructive" title={row.error}>
                        failed: {row.error}
                      </Badge>
                    ) : (
                      <Badge variant="outline">pending</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {importFavorite.isError && rows.length === 0 ? <ErrorBanner error={importFavorite.error} /> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            Close
          </Button>
          <Button
            type="button"
            disabled={running || pending.length === 0}
            data-testid="import-run"
            onClick={runImport}
          >
            <Upload aria-hidden="true" />
            {running ? 'Importing…' : `Import ${pending.length} ${pending.length === 1 ? 'favorite' : 'favorites'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
