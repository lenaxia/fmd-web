/**
 * Settings → 'Import from FMD2' card (two-phase import): drag-drop the
 * FMD2 data files (favorites.db / downloadedchapters.db / settings.json /
 * modules.json / config.json or a zip of the FMD2 data dir) → server-side
 * analyze → preview (favorites by site incl. unmapped ids, mappable
 * settings, detected credential FIELDS — never values) → confirm with
 * explicit per-selection checkboxes (credentials OPT-IN, off by
 * default) → apply → result summary with a link to Favorites.
 *
 * frmImportFavorites ADAPT (R5 web-native): the desktop dialog's
 * directory picker + modal become a web upload + inline preview
 * table; the JSON-list import dialog (favorites-parity) stays for
 * hand-made lists — this card covers FMD2's OWN files end to end.
 */
import { useRef, useState, type DragEvent, type ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, FolderInput, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { navigate } from '../../router';
import {
  postFmd2Analyze,
  postFmd2Apply,
  type Fmd2ImportPreview,
  type Fmd2ImportReport,
} from '../../api/fmd2-import';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';

type Phase = 'idle' | 'analyzing' | 'preview' | 'applying' | 'result';

const ACCEPT = '.json,.sqlite,.db,.zip';

function DragDropZone(props: {
  readonly disabled: boolean;
  readonly onFiles: (files: readonly File[]) => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const take = (list: FileList | undefined): void => {
    const files = list === undefined ? [] : [...list];
    if (files.length > 0) {
      props.onFiles(files);
    }
  };
  return (
    <div
      data-testid="fmd2-dropzone"
      role="button"
      tabIndex={0}
      aria-label="Upload FMD2 data files"
      aria-disabled={props.disabled}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
        dragOver ? 'border-primary bg-primary/5' : 'border-border'
      } ${props.disabled ? 'pointer-events-none opacity-50' : ''}`}
      onClick={(): void => input.current?.click()}
      onKeyDown={(event): void => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          input.current?.click();
        }
      }}
      onDragOver={(event: DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(): void => setDragOver(false)}
      onDrop={(event: DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        setDragOver(false);
        take(event.dataTransfer?.files);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        data-testid="fmd2-file-input"
        onChange={(event): void => {
          take(event.target.files);
          event.target.value = '';
        }}
      />
      <UploadCloud aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">Drop FMD2 files here, or click to choose</p>
      <p className="text-xs text-muted-foreground">
        favorites.db · downloadedchapters.db · settings.json · modules.json · config.json · or a zip of the
        FMD2 data folder (.json / .sqlite / .db / .zip)
      </p>
    </div>
  );
}

export function ImportFromFmd2Card(): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [preview, setPreview] = useState<Fmd2ImportPreview | undefined>(undefined);
  const [report, setReport] = useState<Fmd2ImportReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [importFavorites, setImportFavorites] = useState(true);
  const [settingKeys, setSettingKeys] = useState<Set<string>>(new Set());
  const [credentialKeys, setCredentialKeys] = useState<Set<string>>(new Set());

  const busy = phase === 'analyzing' || phase === 'applying';

  const reset = (): void => {
    setPhase('idle');
    setFileNames([]);
    setPreview(undefined);
    setReport(undefined);
    setError(undefined);
    setImportFavorites(true);
    setSettingKeys(new Set());
    setCredentialKeys(new Set());
  };

  const analyze = async (files: readonly File[]): Promise<void> => {
    setPhase('analyzing');
    setError(undefined);
    setFileNames(files.map((file): string => file.name));
    try {
      const result = await postFmd2Analyze(globalThis.fetch, files);
      setPreview(result);
      // Settings default ON (non-secret, the user uploaded them for a
      // reason); credentials default OFF — explicit opt-in only.
      setSettingKeys(new Set(result.settings.mappable.map((item): string => item.key)));
      setCredentialKeys(new Set());
      setPhase('preview');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };

  const apply = async (): Promise<void> => {
    if (preview === undefined) {
      return;
    }
    setPhase('applying');
    setError(undefined);
    try {
      const result = await postFmd2Apply(globalThis.fetch, {
        token: preview.analyzeToken,
        favorites: importFavorites,
        settings: [...settingKeys],
        credentials: [...credentialKeys],
      });
      setReport(result);
      setPhase('result');
      toast.success('FMD2 import complete');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('preview');
    }
  };

  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  };

  return (
    <section role="region" aria-label="Import from FMD2" className="mb-6" data-testid="fmd2-import-section">
      <div className="rounded-lg border bg-surface/40">
        <div className="flex items-center gap-x-3 px-4 py-3">
          <FolderInput aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Import from FMD2</h2>
          <span className="font-mono text-xs text-muted-foreground">
            bring a desktop install&apos;s favorites, downloaded-chapter history and settings
          </span>
        </div>
        <div className="border-t px-4 pb-4">
          {phase === 'result' && report !== undefined ? (
            <div className="grid gap-3 pt-3" data-testid="fmd2-result">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <CheckCircle2 aria-hidden="true" className="size-4 text-primary" />
                <span data-testid="fmd2-result-favorites">
                  Favorites: {String(report.favorites.created)} created · {String(report.favorites.updated)}{' '}
                  updated · {String(report.favorites.unchanged)} unchanged
                </span>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={(): void => navigate('favorites', {})}
                >
                  Go to Favorites
                </Button>
              </div>
              {report.downloadedLedgerRowsApplied > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Downloaded-chapter ledger rows applied: {String(report.downloadedLedgerRowsApplied)} (nothing
                  re-downloads).
                </p>
              ) : null}
              {report.favorites.unmappedSiteIds.length > 0 ? (
                <div className="grid gap-1 text-sm" data-testid="fmd2-result-unmapped">
                  <p className="font-medium">Skipped — sites not in the catalog (imported everything else):</p>
                  <ul className="list-disc pl-5">
                    {report.favorites.unmappedSiteIds.map((site): ReactElement => (
                      <li key={site.id}>
                        <code>{site.id}</code> — {String(site.count)} favorite(s)
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {report.favorites.skipped.length > 0 ? (
                <details className="text-sm" data-testid="fmd2-result-skipped">
                  <summary className="cursor-pointer text-muted-foreground">
                    {String(report.favorites.skipped.length)} skipped row(s) with reasons
                  </summary>
                  <ul className="mt-1 list-disc pl-5">
                    {report.favorites.skipped.map((row, index): ReactElement => (
                      <li key={String(index)}>
                        <span className="truncate">{row.label}</span> — {row.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {report.credentials.imported.length > 0 ? (
                <p className="text-sm" data-testid="fmd2-result-credentials">
                  Credentials imported for {String(report.credentials.imported.length)} site(s) (usernames:{' '}
                  {report.credentials.imported.map((site): string => site.siteName || site.moduleId).join(', ')}).
                </p>
              ) : null}
              {report.settings.applied.length > 0 ? (
                <div className="grid gap-1 text-sm" data-testid="fmd2-result-settings">
                  <p className="font-medium">Settings applied:</p>
                  <ul className="list-disc pl-5">
                    {report.settings.applied.map((item): ReactElement => (
                      <li key={item.key}>
                        {item.key} — {item.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {report.settings.notImportable.length > 0 ? (
                <details className="text-sm" data-testid="fmd2-result-notimported">
                  <summary className="cursor-pointer text-muted-foreground">
                    {String(report.settings.notImportable.length)} setting(s) not imported (no server equivalent)
                  </summary>
                  <ul className="mt-1 list-disc pl-5">
                    {report.settings.notImportable.map((item, index): ReactElement => (
                      <li key={String(index)}>
                        {item.source} — {item.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {report.favorites.saveToPathsDropped > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {String(report.favorites.saveToPathsDropped)} desktop save-to path(s) were not carried (the
                  server manages its own library layout).
                </p>
              ) : null}
              <div>
                <Button type="button" variant="outline" onClick={reset} data-testid="fmd2-reset">
                  <FileUp aria-hidden="true" />
                  Import more files
                </Button>
              </div>
            </div>
          ) : phase === 'preview' && preview !== undefined ? (
            <div className="grid gap-4 pt-3" data-testid="fmd2-preview">
              <p className="text-sm text-muted-foreground" data-testid="fmd2-preview-files">
                Read {preview.files.join(', ')}
                {preview.ignored.length > 0
                  ? ` · ignored: ${preview.ignored.map((item): string => item.source).join(', ')}`
                  : ''}
              </p>

              <div className="grid gap-1">
                <p className="text-sm font-medium" data-testid="fmd2-preview-favorites">
                  Favorites: {String(preview.favorites.importable)} of {String(preview.favorites.total)} import
                  across {String(preview.favorites.bySite.length)} site(s)
                  {preview.downloadedLedger.rows > 0
                    ? ` · downloaded-chapter history: ${String(preview.downloadedLedger.matched)}/${String(
                        preview.downloadedLedger.rows,
                      )} rows match`
                    : ''}
                </p>
                <ul className="grid gap-1">
                  {preview.favorites.bySite.map((site): ReactElement => (
                    <li key={site.moduleId} className="flex items-center gap-2 text-sm">
                      <Badge variant="outline">{String(site.count)}</Badge>
                      <span>{site.siteName}</span>
                      <code className="text-xs text-muted-foreground">{site.moduleId.slice(0, 10)}…</code>
                    </li>
                  ))}
                </ul>
                {preview.favorites.unmappedSiteIds.length > 0 ? (
                  <div className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm" data-testid="fmd2-preview-unmapped">
                    <p className="flex items-center gap-1 font-medium">
                      <AlertTriangle aria-hidden="true" className="size-4" />
                      Not in the site catalog (skipped, never fatal):
                    </p>
                    <ul className="list-disc pl-5">
                      {preview.favorites.unmappedSiteIds.map((site): ReactElement => (
                        <li key={site.id}>
                          <code>{site.id}</code> — {String(site.count)} favorite(s)
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={importFavorites}
                  onChange={(): void => setImportFavorites((prev): boolean => !prev)}
                  data-testid="fmd2-select-favorites"
                />
                Import favorites (idempotent — re-importing never duplicates)
              </label>

              {preview.settings.mappable.length > 0 ? (
                <fieldset className="grid gap-1" data-testid="fmd2-settings-group">
                  <legend className="text-sm font-medium">Settings</legend>
                  {preview.settings.mappable.map((item): ReactElement => (
                    <label key={item.key} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={settingKeys.has(item.key)}
                        onChange={(): void => setSettingKeys((prev): Set<string> => toggle(prev, item.key))}
                        data-testid={`fmd2-setting-${item.key}`}
                      />
                      <span>
                        {item.label} <span className="text-muted-foreground">({item.preview})</span>
                        {item.requiresCredentials ? (
                          <span className="text-destructive"> — includes a saved login</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}

              {preview.credentials.sites.length > 0 || preview.credentials.globalProxyAuth ? (
                <fieldset className="grid gap-1 rounded-md border p-2" data-testid="fmd2-credentials-group">
                  <legend className="px-1 text-sm font-medium text-destructive">
                    Credentials (OFF by default)
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    Stored logins decrypt with FMD2&apos;s built-in key and import into this server&apos;s
                    account store. Leave unchecked to skip them.
                  </p>
                  {preview.credentials.sites.map((site): ReactElement => (
                    <label key={site.moduleId} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={credentialKeys.has(site.moduleId)}
                        onChange={(): void => setCredentialKeys((prev): Set<string> => toggle(prev, site.moduleId))}
                        data-testid={`fmd2-credential-${site.moduleId}`}
                      />
                      <span>
                        {site.siteName} <span className="text-muted-foreground">({site.fields.join(', ')})</span>
                      </span>
                    </label>
                  ))}
                  {preview.credentials.globalProxyAuth ? (
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={credentialKeys.has('proxy')}
                        onChange={(): void => setCredentialKeys((prev): Set<string> => toggle(prev, 'proxy'))}
                        data-testid="fmd2-credential-proxy"
                      />
                      <span>
                        Global proxy login <span className="text-muted-foreground">(username/password)</span>
                      </span>
                    </label>
                  ) : null}
                </fieldset>
              ) : null}

              {error !== undefined ? <ErrorBanner error={new Error(error)} /> : null}

              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={reset} disabled={busy}>
                  Cancel
                </Button>
                <Button type="button" onClick={(): void => void apply()} disabled={busy} data-testid="fmd2-apply">
                  <UploadCloud aria-hidden="true" />
                  Import
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 pt-3">
              <DragDropZone disabled={busy} onFiles={(files): void => void analyze(files)} />
              {fileNames.length > 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="fmd2-analyzing">
                  Analyzing {fileNames.join(', ')}…
                </p>
              ) : null}
              {error !== undefined ? <ErrorBanner error={new Error(error)} /> : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
