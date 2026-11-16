/**
 * Settings (§9/§10): module registry with capability + known-broken
 * badges (§5.10, D3), per-module options editor (combobox INDEX
 * semantics) + cookies editor, sync buttons (modules / all catalogs),
 * and the D20 first-run bootstrap empty state with surfaced progress.
 *
 * Design-system retrofit: PageHeader + toolbar Buttons (with sonner
 * progress toasts — additive, distinct from the pinned inline status
 * texts) + Proxy Card + the virtualized module list. The registry is
 * 454 sites in production — ListPanel virtualizes it above the
 * threshold while fixture-sized lists stay plain DOM.
 */
import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { RefreshCw, X } from 'lucide-react';
import {
  useModules,
  useSyncAllCatalogs,
  useSyncModules,
  useUpdateModule,
  type ModuleSummaryT,
  type ProxySettingsT,
} from '../api/hooks';
import { CapabilityBadges } from '../components/CapabilityBadges';
import { ProxySettingsSection } from '../components/ProxySettings';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { progressToast, type ProgressToastHandle } from '@/components/patterns/ProgressToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { OptionsEditor } from '../components/OptionsEditor';

const EMPTY_PROXY: ProxySettingsT = { type: '', host: '', port: '', user: '', pass: '' };

function ModuleProxyEditor(props: { module: ModuleSummaryT }): ReactElement {
  const update = useUpdateModule();
  const [override, setOverride] = useState(props.module.proxy !== null);
  const [draft, setDraft] = useState<ProxySettingsT>(props.module.proxy ?? EMPTY_PROXY);

  const save = (): void => {
    // unchecked = inherit the global config (explicit null clears the override)
    update.mutate({ id: props.module.id, proxy: override ? draft : null });
  };

  return (
    <form
      className="proxy-override-form mt-3 grid max-w-md grid-cols-[max-content_1fr] content-center gap-x-4 gap-y-2"
      aria-label={`Proxy override for ${props.module.name}`}
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor={`proxy-override-${props.module.id}`} className="col-span-2 flex items-center gap-2 text-sm font-medium">
        <input
          id={`proxy-override-${props.module.id}`}
          type="checkbox"
          className="size-4 accent-(--primary)"
          checked={override}
          onChange={(e): void => {
            setOverride(e.target.checked);
          }}
        />{' '}
        Module proxy override {override ? '' : '(inherits the global proxy)'}
      </label>
      {override ? (
        <>
          <label htmlFor={`proxy-type-${props.module.id}`} className="text-sm font-medium leading-9">Type</label>
          <NativeSelect
            id={`proxy-type-${props.module.id}`}
            value={draft.type}
            onChange={(e): void => {
              const type = e.target.value as ProxySettingsT['type'];
              setDraft(type === '' ? EMPTY_PROXY : { ...draft, type });
            }}
          >
            <option value="">none</option>
            <option value="HTTP">HTTP</option>
            <option value="SOCKS4">SOCKS4</option>
            <option value="SOCKS5">SOCKS5</option>
          </NativeSelect>
          <label htmlFor={`proxy-host-${props.module.id}`} className="text-sm font-medium leading-9">Host</label>
          <Input
            id={`proxy-host-${props.module.id}`}
            value={draft.host}
            onChange={(e): void => {
              setDraft({ ...draft, host: e.target.value });
            }}
          />
          <label htmlFor={`proxy-port-${props.module.id}`} className="text-sm font-medium leading-9">Port</label>
          <Input
            id={`proxy-port-${props.module.id}`}
            value={draft.port}
            onChange={(e): void => {
              setDraft({ ...draft, port: e.target.value });
            }}
          />
        </>
      ) : null}
      <div className="col-start-2 mt-2">
        <Button type="submit" size="sm" disabled={update.isPending}>
          Save module proxy
        </Button>
      </div>
    </form>
  );
}

function ModuleEditor(props: { module: ModuleSummaryT; onDone: () => void }): ReactElement {
  const update = useUpdateModule();
  const [cookies, setCookies] = useState('');
  return (
    <div className="module-editor mt-3 rounded-lg border bg-surface/40 p-4" aria-label={`Editor for ${props.module.name}`}>
      <OptionsEditor
        module={props.module}
        saving={update.isPending}
        onSave={(values): void => {
          update.mutate({ id: props.module.id, options: values });
        }}
      />
      <form
        className="cookies-form mt-3 flex flex-col items-start gap-2"
        aria-label={`Cookies for ${props.module.name}`}
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate({ id: props.module.id, cookies });
        }}
      >
        <label htmlFor={`cookies-${props.module.id}`} className="text-sm font-medium">
          Cookies <span className="option-hint text-xs font-normal text-muted-foreground">(Cookie header string; User-Agent options live above)</span>
        </label>
        <textarea
          id={`cookies-${props.module.id}`}
          rows={2}
          className="w-full max-w-md rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          value={cookies}
          onChange={(e): void => {
            setCookies(e.target.value);
          }}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={update.isPending || cookies === ''}>
          Save cookies
        </Button>
      </form>
      <ModuleProxyEditor module={props.module} />
      {update.isError ? <ErrorBanner error={update.error} /> : null}
      {update.isSuccess ? (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground">
          Saved. Module <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{update.data.id}</code> updated
          {update.data.enabled ? '' : ' (disabled)'}.
        </p>
      ) : null}
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={(): void => { props.onDone(); }}>
        <X aria-hidden="true" />
        Close
      </Button>
    </div>
  );
}

function ModuleRow(props: { module: ModuleSummaryT }): ReactElement {
  const update = useUpdateModule();
  const [open, setOpen] = useState(false);
  return (
    <div className="module-row w-full">
      <div className="module-head flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
        <label htmlFor={`enabled-${props.module.id}`} className="flex items-center gap-2 text-sm font-medium">
          <input
            id={`enabled-${props.module.id}`}
            type="checkbox"
            className="size-4 accent-(--primary)"
            checked={props.module.enabled}
            onChange={(e): void => {
              update.mutate({ id: props.module.id, enabled: e.target.checked });
            }}
          />{' '}
          {props.module.name}
        </label>
        <span className="module-meta text-xs text-muted-foreground">
          {props.module.category} · {props.module.rootURL}
        </span>
        <CapabilityBadges module={props.module} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-7"
          aria-expanded={open}
          onClick={(): void => {
            setOpen((prev) => !prev);
          }}
        >
          {open ? 'Hide options' : 'Configure'}
        </Button>
      </div>
      {update.isError ? <ErrorBanner error={update.error} /> : null}
      {open ? <ModuleEditor module={props.module} onDone={(): void => setOpen(false)} /> : null}
    </div>
  );
}

export function SettingsPage(): ReactElement {
  const modules = useModules();
  const syncModules = useSyncModules();
  const syncCatalogs = useSyncAllCatalogs();

  const moduleToast = useRef<ProgressToastHandle | null>(null);
  const catalogToast = useRef<ProgressToastHandle | null>(null);

  const list = modules.data?.modules ?? [];
  const bootstrapRunning = syncModules.isPending || syncCatalogs.isPending;

  const runSyncModules = (): void => {
    moduleToast.current = progressToast.start('Module sync running…');
    syncModules.mutate(undefined, {
      onSuccess: (data): void => {
        if (moduleToast.current !== null) {
          progressToast.done(moduleToast.current, `Module sync complete — ${data.summary.totalModules} modules`);
        }
      },
      onError: (): void => {
        if (moduleToast.current !== null) {
          progressToast.fail(moduleToast.current, 'Module sync failed');
        }
      },
    });
  };

  const runSyncCatalogs = (): void => {
    catalogToast.current = progressToast.start('Catalog sync running…');
    syncCatalogs.mutate(undefined, {
      onSuccess: (data): void => {
        if (catalogToast.current !== null) {
          progressToast.done(catalogToast.current, `Catalog sync complete — ${data.results.length} catalog(s)`);
        }
      },
      onError: (): void => {
        if (catalogToast.current !== null) {
          progressToast.fail(catalogToast.current, 'Catalog sync failed');
        }
      },
    });
  };

  if (modules.isPending) {
    return (
      <section aria-label="Settings">
        <PageHeader title="Settings" description="Module registry, options, proxy and sync." />
        <p role="status" className="text-sm text-muted-foreground">Loading modules…</p>
      </section>
    );
  }
  if (modules.isError) {
    return (
      <section aria-label="Settings">
        <PageHeader title="Settings" description="Module registry, options, proxy and sync." />
        <ErrorBanner error={modules.error} />
      </section>
    );
  }

  if (list.length === 0) {
    return (
      <section aria-label="Settings">
        <PageHeader title="Settings" description="Module registry, options, proxy and sync." />
        <EmptyState
          title="No modules registered yet"
          action={
            <Button
              type="button"
              onClick={(): void => {
                runSyncModules();
              }}
              disabled={syncModules.isPending}
            >
              <RefreshCw aria-hidden="true" />
              {syncModules.isPending ? 'Syncing modules…' : 'Run module sync now'}
            </Button>
          }
        >
          <p>
            First-run bootstrap (D20): with an empty data dir the server auto-triggers module and
            catalog sync — progress shows here. If the registry is still empty, trigger it
            manually:
          </p>
          {syncModules.isPending ? <p role="status">Module sync running…</p> : null}
          {syncModules.isSuccess ? (
            <>
              <p role="status" aria-live="polite">
                Module sync finished: {syncModules.data.summary.registeredFiles}/
                {syncModules.data.summary.totalFiles} files registered,{' '}
                {syncModules.data.summary.totalModules} modules.
              </p>
              {syncModules.data.summary.failures.length > 0 ? (
                <p role="status">
                  {String(syncModules.data.summary.failures.length)} upstream-broken file(s) tolerated —
                  see the full list under Settings after the registry loads.
                </p>
              ) : null}
            </>
          ) : null}
          {syncModules.isError ? <ErrorBanner error={syncModules.error} /> : null}
        </EmptyState>
      </section>
    );
  }

  return (
    <section aria-label="Settings">
      <PageHeader
        title="Settings"
        description="Module registry, options, proxy and sync."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => {
                runSyncModules();
              }}
              disabled={bootstrapRunning}
            >
              <RefreshCw aria-hidden="true" />
              {syncModules.isPending ? 'Syncing modules…' : 'Sync modules'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => {
                runSyncCatalogs();
              }}
              disabled={bootstrapRunning}
            >
              <RefreshCw aria-hidden="true" />
              {syncCatalogs.isPending ? 'Syncing catalogs…' : 'Sync all catalogs'}
            </Button>
          </>
        }
      />

      {syncModules.isError ? <ErrorBanner error={syncModules.error} /> : null}
      {syncCatalogs.isError ? <ErrorBanner error={syncCatalogs.error} /> : null}
      {syncModules.isSuccess ? (
        <>
          <p role="status" aria-live="polite">
            Module sync: {syncModules.data.summary.registeredFiles}/{syncModules.data.summary.totalFiles}{' '}
            files registered, {syncModules.data.summary.failedFiles} failed,{' '}
            {syncModules.data.summary.totalModules} modules (tree {syncModules.data.summary.treeSha.slice(0, 10)}).
          </p>
          {syncModules.data.summary.failures.length > 0 ? (
            <div className="sync-failures">
              <p>
                {String(syncModules.data.summary.failures.length)} upstream-broken file(s) tolerated (excluded
                from the registry):
              </p>
              <ul aria-label="Tolerated broken module files">
                {syncModules.data.summary.failures.map((failure): ReactElement => (
                  <li key={failure.file}>
                    <code>{failure.file}</code>: {failure.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {syncCatalogs.isSuccess ? (
        <p role="status" aria-live="polite" className="mb-3 text-sm text-muted-foreground">
          Catalog sync: {syncCatalogs.data.results.length} catalog(s) —{' '}
          {syncCatalogs.data.results.map((r): string => `${r.id.slice(0, 8)}:${r.state}`).join(', ')}.
        </p>
      ) : null}

      <ProxySettingsSection />

      <h2 className="mb-2 text-lg font-semibold">Modules ({list.length})</h2>
      <ListPanel
        className="module-list"
        ariaLabel="Site modules"
        items={list}
        itemKey={(module): string => module.id}
        rowClassName="module-row"
        renderItem={(module): ReactElement => <ModuleRow module={module} />}
      />
    </section>
  );
}
