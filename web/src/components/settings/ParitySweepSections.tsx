/**
 * [parity-sweep] Settings sections (audit M2/M4/M10/M12/M13):
 * Performance (Connections-parity knobs), Job-history retention,
 * Filename policy (D5 mode), Diagnostics (log enable/level + ops
 * links) and About (server version + project links). Every control
 * PUTs a real server setting — no dead controls (server-unsupported
 * FMD2 fields are documented SKIPs in docs/UX-PARITY.md Part 4).
 */
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Activity, FileClock, FileText, HeartPulse, Info } from 'lucide-react';
import { toast } from 'sonner';
import { promptInstall, useInstallAvailability } from '../../state/pwa-install';
import {
  useHealthz,
  useSettings,
  useUpdateDiagnostics,
  useUpdateFilenamePolicy,
  useUpdatePerformance,
  useUpdateRetention,
  type DiagnosticsSettingsT,
  type PerformanceSettingsT,
} from '../../api/hooks';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';

/** Repo/release constants (About links — M12). */
const REPO_URL = 'https://github.com/anomalyco/fmd-web';
const RELEASES_URL = `${REPO_URL}/releases`;

function SavedHint(props: { show: boolean }): ReactElement | null {
  if (!props.show) {
    return null;
  }
  return (
    <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
      Saved
    </span>
  );
}

export function PerformanceSection(): ReactElement {
  const settings = useSettings();
  const update = useUpdatePerformance();
  const [draft, setDraft] = useState<PerformanceSettingsT>({
    requestTimeoutSeconds: 15,
    retryCount: 2,
    parallelChapters: 1,
    threadsPerChapter: 1,
  });
  // Partial-snapshot safe: seed only when the group is present.
  const serverPerformance = settings.data?.performance;
  useEffect((): void => {
    if (serverPerformance !== undefined) {
      setDraft(serverPerformance);
    }
  }, [serverPerformance]);
  const num = (value: string, min: number, max: number): number => {
    const n: number = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : min;
  };
  return (
    <section aria-label="Performance" className="performance-settings mb-6" data-testid="performance-settings">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Activity aria-hidden="true" className="size-4" />
        Performance
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        FMD2 Connections parity (the server-exposeable subset). Parallel chapters applies on
        server restart (lane slots are fixed at boot); the rest applies to new requests/jobs.
      </p>
      {settings.isError ? <ErrorBanner error={settings.error} /> : null}
      <form
        className="flex flex-wrap items-end gap-4 rounded-lg border bg-surface/40 p-4"
        aria-label="Performance settings form"
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate(draft);
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          Request timeout (s)
          <Input
            aria-label="Request timeout seconds"
            type="number"
            min={1}
            max={300}
            className="w-24"
            value={draft.requestTimeoutSeconds}
            onChange={(e): void => {
              setDraft({ ...draft, requestTimeoutSeconds: num(e.target.value, 1, 300) });
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Retry count
          <Input
            aria-label="Retry count"
            type="number"
            min={0}
            max={10}
            className="w-20"
            value={draft.retryCount}
            onChange={(e): void => {
              setDraft({ ...draft, retryCount: num(e.target.value, 0, 10) });
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Parallel chapters
          <Input
            aria-label="Parallel chapters"
            type="number"
            min={1}
            max={8}
            className="w-20"
            value={draft.parallelChapters}
            onChange={(e): void => {
              setDraft({ ...draft, parallelChapters: num(e.target.value, 1, 8) });
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Threads per chapter
          <Input
            aria-label="Threads per chapter"
            type="number"
            min={1}
            max={8}
            className="w-20"
            value={draft.threadsPerChapter}
            onChange={(e): void => {
              setDraft({ ...draft, threadsPerChapter: num(e.target.value, 1, 8) });
            }}
          />
        </label>
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <SavedHint show={update.isSuccess} />
        {update.isError ? <ErrorBanner error={update.error} /> : null}
      </form>
    </section>
  );
}

export function RetentionSection(): ReactElement {
  const settings = useSettings();
  const update = useUpdateRetention();
  const [days, setDays] = useState(30);
  const [forever, setForever] = useState(false);
  // Partial-snapshot safe: seed only when the group is present.
  const serverRetention = settings.data?.retention;
  useEffect((): void => {
    if (serverRetention !== undefined) {
      setDays(serverRetention.days === 0 ? 30 : serverRetention.days);
      setForever(serverRetention.days === 0);
    }
  }, [serverRetention]);
  return (
    <section aria-label="Job history" className="retention-settings mb-6" data-testid="retention-settings">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <FileClock aria-hidden="true" className="size-4" />
        Job history
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Auto-delete finished job history after N days (checked hourly). FMD2 delete-completed-tasks parity.
      </p>
      <form
        className="flex flex-wrap items-end gap-4 rounded-lg border bg-surface/40 p-4"
        aria-label="Job history retention form"
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate({ days: forever ? 0 : days });
        }}
      >
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            aria-label="Keep job history forever"
            checked={forever}
            onCheckedChange={(): void => {
              setForever((prev): boolean => !prev);
            }}
          />
          Keep forever
        </label>
        {!forever ? (
          <label className="flex flex-col gap-1 text-sm font-medium">
            Delete finished jobs after (days)
            <Input
              aria-label="Retention days"
              type="number"
              min={1}
              max={3650}
              className="w-24"
              value={days}
              onChange={(e): void => {
                const n: number = Number.parseInt(e.target.value, 10);
                setDays(Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 1);
              }}
            />
          </label>
        ) : null}
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <SavedHint show={update.isSuccess} />
        {update.isError ? <ErrorBanner error={update.error} /> : null}
      </form>
    </section>
  );
}

export function FilenamePolicySection(): ReactElement {
  const settings = useSettings();
  const update = useUpdateFilenamePolicy();
  const [normalizePaths, setNormalizePaths] = useState(false);
  // Partial-snapshot safe: seed only when the group is present.
  const serverPolicy = settings.data?.filenamePolicy;
  useEffect((): void => {
    if (serverPolicy !== undefined) {
      setNormalizePaths(serverPolicy.normalizePaths);
    }
  }, [serverPolicy]);
  return (
    <section aria-label="Filename policy" className="filename-policy mb-6" data-testid="filename-policy">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <FileText aria-hidden="true" className="size-4" />
        Filename policy
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Linux-normalized filenames vs the FMD2-desktop-parity default. Precedence: the
        FMD_NORMALIZE_PATHS environment variable overrides this setting when set.
      </p>
      <form
        className="flex flex-wrap items-center gap-4 rounded-lg border bg-surface/40 p-4"
        aria-label="Filename policy form"
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate({ normalizePaths });
        }}
      >
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            aria-label="Linux-normalized filenames"
            checked={normalizePaths}
            onCheckedChange={(): void => {
              setNormalizePaths((prev): boolean => !prev);
            }}
          />
          Linux-normalized filenames
        </label>
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <SavedHint show={update.isSuccess} />
        {update.isError ? <ErrorBanner error={update.error} /> : null}
      </form>
    </section>
  );
}

export function DiagnosticsSection(): ReactElement {
  const settings = useSettings();
  const update = useUpdateDiagnostics();
  const [draft, setDraft] = useState<DiagnosticsSettingsT>({ logEnabled: true, logLevel: 'info' });
  // Partial-snapshot safe: seed only when the group is present.
  const serverDiagnostics = settings.data?.diagnostics;
  useEffect((): void => {
    if (serverDiagnostics !== undefined) {
      setDraft(serverDiagnostics);
    }
  }, [serverDiagnostics]);
  return (
    <section aria-label="Diagnostics" className="diagnostics-settings mb-6" data-testid="diagnostics-settings">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <HeartPulse aria-hidden="true" className="size-4" />
        Diagnostics
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Structured logging (applies live). The live log viewer is planned for v0.4.
      </p>
      <form
        className="flex flex-wrap items-end gap-4 rounded-lg border bg-surface/40 p-4"
        aria-label="Diagnostics settings form"
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate(draft);
        }}
      >
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            aria-label="Enable structured logging"
            checked={draft.logEnabled}
            onCheckedChange={(): void => {
              setDraft({ ...draft, logEnabled: !draft.logEnabled });
            }}
          />
          Enable logging
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Minimum level
          <NativeSelect
            aria-label="Minimum log level"
            className="w-28"
            value={draft.logLevel}
            disabled={!draft.logEnabled}
            onChange={(e): void => {
              setDraft({ ...draft, logLevel: e.target.value as DiagnosticsSettingsT['logLevel'] });
            }}
          >
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </NativeSelect>
        </label>
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <SavedHint show={update.isSuccess} />
        {update.isError ? <ErrorBanner error={update.error} /> : null}
      </form>
      <p className="mt-2 flex flex-wrap gap-4 text-sm">
        <a className="underline underline-offset-4" href="/metrics" target="_blank" rel="noreferrer">
          Prometheus metrics
        </a>
        <a
          className="underline underline-offset-4"
          href="https://github.com/anomalyco/fmd-web/blob/main/docs/runbook.md"
          target="_blank"
          rel="noreferrer"
        >
          Operations runbook
        </a>
      </p>
    </section>
  );
}

export function AboutSection(): ReactElement {
  const health = useHealthz();
  const version: string = health.data?.version ?? '…';
  // R5 arrival: the install surface appears ONLY when the browser
  // fired beforeinstallprompt (Chromium installability); iOS Safari's
  // share-sheet path never does, by design (docs/UX-PARITY.md).
  const install = useInstallAvailability();
  const onInstall = (): void => {
    void promptInstall().then((outcome): void => {
      if (outcome === 'accepted') {
        toast.success('FMD Web installed: find it on your home screen / desktop.');
      } else if (outcome === 'dismissed') {
        toast.message('Install dismissed: the browser re-offers after its cooldown.');
      }
    });
  };
  return (
    <section aria-label="About" className="about-section mb-6" data-testid="about-section">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Info aria-hidden="true" className="size-4" />
        About
      </h2>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-surface/40 p-4 text-sm">
        <span>
          fmd-web <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">{version}</code>
        </span>
        {install.available && !install.installed ? (
          <Button
            type="button"
            size="sm"
            data-testid="install-app-action"
            onClick={onInstall}
          >
            Install app
          </Button>
        ) : null}
        <a className="underline underline-offset-4" href={RELEASES_URL} target="_blank" rel="noreferrer">
          Releases
        </a>
        <a
          className="underline underline-offset-4"
          href="https://github.com/anomalyco/fmd-web/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noreferrer"
        >
          Changelog
        </a>
        <a className="underline underline-offset-4" href={REPO_URL} target="_blank" rel="noreferrer">
          Repository
        </a>
      </div>
    </section>
  );
}
