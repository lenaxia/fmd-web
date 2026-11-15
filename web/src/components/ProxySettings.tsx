/**
 * Settings → Proxy section (§9/§10, §5.4 SetProxy parity): the GLOBAL
 * proxy editor (type HTTP|SOCKS4|SOCKS5, host, port, user, pass) and
 * the §5.11 browser sidecar profile state badge. All field semantics
 * are the FMD2 SetProxy five strings; the all-empty config is "no
 * proxy" (SetNoProxy).
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { useSettings, useUpdateProxy, type ProxySettingsT } from '../api/hooks';
import { Badge } from './CapabilityBadges';
import { ErrorBanner } from './ErrorBanner';

const EMPTY_PROXY: ProxySettingsT = { type: '', host: '', port: '', user: '', pass: '' };

export function ProxySettingsSection(): ReactElement {
  const settings = useSettings();
  const update = useUpdateProxy();
  const [draft, setDraft] = useState<ProxySettingsT | undefined>(undefined);

  const current = draft ?? settings.data?.proxy ?? EMPTY_PROXY;
  const browser = settings.data?.browser;

  const setType = (type: string): void => {
    // switching to "none" clears the whole config (SetNoProxy parity)
    setDraft(type === '' ? EMPTY_PROXY : { ...current, type: type as ProxySettingsT['type'] });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    update.mutate(current);
  };

  return (
    <section className="proxy-settings" aria-label="Proxy settings">
      <h2>Proxy</h2>
      <ul className="badge-list" aria-label="Browser sidecar status">
        {browser?.enabled ? (
          <li>
            <Badge
              kind="capability"
              label="browser sidecar: enabled"
              title={`Browser sidecar profile active (§5.11): ${browser.url} — satisfied known-broken flags are flipped`}
            />
          </li>
        ) : (
          <li>
            <Badge
              kind="broken"
              label="browser sidecar: off"
              title="The compose browser profile (§5.11) is not active; browser-dependent modules stay known-broken"
            />
          </li>
        )}
      </ul>
      <form className="proxy-form" aria-label="Global proxy" onSubmit={submit}>
        <label htmlFor="proxy-type">Type</label>
        <select
          id="proxy-type"
          value={current.type}
          onChange={(e): void => {
            setType(e.target.value);
          }}
        >
          <option value="">none</option>
          <option value="HTTP">HTTP</option>
          <option value="SOCKS4">SOCKS4</option>
          <option value="SOCKS5">SOCKS5</option>
        </select>
        <label htmlFor="proxy-host">Host</label>
        <input
          id="proxy-host"
          value={current.host}
          disabled={current.type === ''}
          onChange={(e): void => {
            setDraft({ ...current, host: e.target.value });
          }}
        />
        <label htmlFor="proxy-port">Port</label>
        <input
          id="proxy-port"
          value={current.port}
          disabled={current.type === ''}
          onChange={(e): void => {
            setDraft({ ...current, port: e.target.value });
          }}
        />
        <label htmlFor="proxy-user">User</label>
        <input
          id="proxy-user"
          value={current.user}
          disabled={current.type === ''}
          onChange={(e): void => {
            setDraft({ ...current, user: e.target.value });
          }}
        />
        <label htmlFor="proxy-pass">Password</label>
        <input
          id="proxy-pass"
          type="password"
          value={current.pass}
          disabled={current.type === ''}
          onChange={(e): void => {
            setDraft({ ...current, pass: e.target.value });
          }}
        />
        <button type="submit" disabled={update.isPending || draft === undefined}>
          {update.isPending ? 'Saving…' : 'Save proxy'}
        </button>
      </form>
      {update.isError ? <ErrorBanner error={update.error} /> : null}
      {update.isSuccess ? (
        <p role="status" aria-live="polite">
          Saved. Global proxy: {update.data.proxy.type === '' ? 'none' : `${update.data.proxy.type} ${update.data.proxy.host}:${update.data.proxy.port}`}
          . Modules use the global config unless they carry their own override.
        </p>
      ) : null}
    </section>
  );
}
