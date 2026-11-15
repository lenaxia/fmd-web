/**
 * Settings (§9/§10): module registry with capability + known-broken
 * badges (§5.10, D3), per-module options editor (combobox INDEX
 * semantics) + cookies editor, sync buttons (modules / all catalogs),
 * and the D20 first-run bootstrap empty state with surfaced progress.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
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
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
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
      className="proxy-override-form"
      aria-label={`Proxy override for ${props.module.name}`}
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor={`proxy-override-${props.module.id}`}>
        <input
          id={`proxy-override-${props.module.id}`}
          type="checkbox"
          checked={override}
          onChange={(e): void => {
            setOverride(e.target.checked);
          }}
        />{' '}
        Module proxy override {override ? '' : '(inherits the global proxy)'}
      </label>
      {override ? (
        <>
          <label htmlFor={`proxy-type-${props.module.id}`}>Type</label>
          <select
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
          </select>
          <label htmlFor={`proxy-host-${props.module.id}`}>Host</label>
          <input
            id={`proxy-host-${props.module.id}`}
            value={draft.host}
            onChange={(e): void => {
              setDraft({ ...draft, host: e.target.value });
            }}
          />
          <label htmlFor={`proxy-port-${props.module.id}`}>Port</label>
          <input
            id={`proxy-port-${props.module.id}`}
            value={draft.port}
            onChange={(e): void => {
              setDraft({ ...draft, port: e.target.value });
            }}
          />
        </>
      ) : null}
      <button type="submit" disabled={update.isPending}>
        Save module proxy
      </button>
    </form>
  );
}

function ModuleEditor(props: { module: ModuleSummaryT; onDone: () => void }): ReactElement {
  const update = useUpdateModule();
  const [cookies, setCookies] = useState('');
  return (
    <div className="module-editor" aria-label={`Editor for ${props.module.name}`}>
      <OptionsEditor
        module={props.module}
        saving={update.isPending}
        onSave={(values): void => {
          update.mutate({ id: props.module.id, options: values });
        }}
      />
      <form
        className="cookies-form"
        aria-label={`Cookies for ${props.module.name}`}
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate({ id: props.module.id, cookies });
        }}
      >
        <label htmlFor={`cookies-${props.module.id}`}>
          Cookies <span className="option-hint">(Cookie header string; User-Agent options live above)</span>
        </label>
        <textarea
          id={`cookies-${props.module.id}`}
          rows={2}
          value={cookies}
          onChange={(e): void => {
            setCookies(e.target.value);
          }}
        />
        <button type="submit" disabled={update.isPending || cookies === ''}>
          Save cookies
        </button>
      </form>
      <ModuleProxyEditor module={props.module} />
      {update.isError ? <ErrorBanner error={update.error} /> : null}
      {update.isSuccess ? (
        <p role="status" aria-live="polite">
          Saved. Module <code>{update.data.id}</code> updated
          {update.data.enabled ? '' : ' (disabled)'}.
        </p>
      ) : null}
      <button
        type="button"
        onClick={(): void => {
          props.onDone();
        }}
      >
        Close
      </button>
    </div>
  );
}

function ModuleRow(props: { module: ModuleSummaryT }): ReactElement {
  const update = useUpdateModule();
  const [open, setOpen] = useState(false);
  return (
    <li className="module-row">
      <div className="module-head">
        <label htmlFor={`enabled-${props.module.id}`}>
          <input
            id={`enabled-${props.module.id}`}
            type="checkbox"
            checked={props.module.enabled}
            onChange={(e): void => {
              update.mutate({ id: props.module.id, enabled: e.target.checked });
            }}
          />{' '}
          {props.module.name}
        </label>
        <span className="module-meta">
          {props.module.category} · {props.module.rootURL}
        </span>
        <CapabilityBadges module={props.module} />
        <button
          type="button"
          aria-expanded={open}
          onClick={(): void => {
            setOpen((prev) => !prev);
          }}
        >
          {open ? 'Hide options' : 'Configure'}
        </button>
      </div>
      {update.isError ? <ErrorBanner error={update.error} /> : null}
      {open ? <ModuleEditor module={props.module} onDone={(): void => setOpen(false)} /> : null}
    </li>
  );
}

export function SettingsPage(): ReactElement {
  const modules = useModules();
  const syncModules = useSyncModules();
  const syncCatalogs = useSyncAllCatalogs();

  const list = modules.data?.modules ?? [];
  const bootstrapRunning = syncModules.isPending || syncCatalogs.isPending;

  if (modules.isPending) {
    return (
      <section aria-label="Settings">
        <p role="status">Loading modules…</p>
      </section>
    );
  }
  if (modules.isError) {
    return (
      <section aria-label="Settings">
        <ErrorBanner error={modules.error} />
      </section>
    );
  }

  if (list.length === 0) {
    return (
      <section aria-label="Settings">
        <EmptyState
          title="No modules registered yet"
          action={
            <button
              type="button"
              onClick={(): void => {
                syncModules.mutate();
              }}
              disabled={syncModules.isPending}
            >
              {syncModules.isPending ? 'Syncing modules…' : 'Run module sync now'}
            </button>
          }
        >
          <p>
            First-run bootstrap (D20): with an empty data dir the server auto-triggers module and
            catalog sync — progress shows here. If the registry is still empty, trigger it
            manually:
          </p>
          {syncModules.isPending ? <p role="status">Module sync running…</p> : null}
          {syncModules.isSuccess ? (
            <p role="status" aria-live="polite">
              Module sync finished: {syncModules.data.summary.registeredFiles}/
              {syncModules.data.summary.totalFiles} files registered,{' '}
              {syncModules.data.summary.totalModules} modules.
            </p>
          ) : null}
          {syncModules.isError ? <ErrorBanner error={syncModules.error} /> : null}
        </EmptyState>
      </section>
    );
  }

  return (
    <section aria-label="Settings">
      <div className="toolbar">
        <button
          type="button"
          onClick={(): void => {
            syncModules.mutate();
          }}
          disabled={bootstrapRunning}
        >
          {syncModules.isPending ? 'Syncing modules…' : 'Sync modules'}
        </button>
        <button
          type="button"
          onClick={(): void => {
            syncCatalogs.mutate();
          }}
          disabled={bootstrapRunning}
        >
          {syncCatalogs.isPending ? 'Syncing catalogs…' : 'Sync all catalogs'}
        </button>
      </div>

      {syncModules.isError ? <ErrorBanner error={syncModules.error} /> : null}
      {syncCatalogs.isError ? <ErrorBanner error={syncCatalogs.error} /> : null}
      {syncModules.isSuccess ? (
        <p role="status" aria-live="polite">
          Module sync: {syncModules.data.summary.registeredFiles}/{syncModules.data.summary.totalFiles}{' '}
          files registered, {syncModules.data.summary.failedFiles} failed,{' '}
          {syncModules.data.summary.totalModules} modules (tree {syncModules.data.summary.treeSha.slice(0, 10)}).
        </p>
      ) : null}
      {syncCatalogs.isSuccess ? (
        <p role="status" aria-live="polite">
          Catalog sync: {syncCatalogs.data.results.length} catalog(s) —{' '}
          {syncCatalogs.data.results.map((r): string => `${r.id.slice(0, 8)}:${r.state}`).join(', ')}.
        </p>
      ) : null}

      <ProxySettingsSection />

      <h2>Modules ({list.length})</h2>
      <ul className="module-list">
        {list.map((module): ReactElement => <ModuleRow key={module.id} module={module} />)}
      </ul>
    </section>
  );
}
