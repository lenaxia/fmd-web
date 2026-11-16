/**
 * Settings → Proxy section (§9/§10, §5.4 SetProxy parity): the GLOBAL
 * proxy editor (type HTTP|SOCKS4|SOCKS5, host, port, user, pass) and
 * the §5.11 browser sidecar profile state badge. All field semantics
 * are the FMD2 SetProxy five strings; the all-empty config is "no
 * proxy" (SetNoProxy).
 *
 * Design-system retrofit: Card + NativeSelect/Input on tokens; labels,
 * disabled semantics and status texts unchanged.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { useSettings, useUpdateProxy, type ProxySettingsT } from '../api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';

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
    <Card role="region" aria-label="Proxy settings" className="mb-6">
      <CardHeader>
        <CardTitle className="text-lg">Proxy</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="badge-list mb-4 flex list-none flex-wrap items-center gap-1 p-0" aria-label="Browser sidecar status">
          {browser?.enabled ? (
            <li>
              <Badge
                variant="secondary"
                className="badge-capability"
                title={`Browser sidecar profile active (§5.11): ${browser.url} — satisfied known-broken flags are flipped`}
              >
                browser sidecar: enabled
              </Badge>
            </li>
          ) : (
            <li>
              <Badge
                variant="destructive"
                className="badge-broken"
                title="The compose browser profile (§5.11) is not active; browser-dependent modules stay known-broken"
              >
                browser sidecar: off
              </Badge>
            </li>
          )}
        </ul>
        <form
          className="proxy-form grid max-w-md grid-cols-[max-content_1fr] content-center gap-x-4 gap-y-2"
          aria-label="Global proxy"
          onSubmit={submit}
        >
          <label htmlFor="proxy-type" className="text-sm font-medium leading-9">Type</label>
          <NativeSelect
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
          </NativeSelect>
          <label htmlFor="proxy-host" className="text-sm font-medium leading-9">Host</label>
          <Input
            id="proxy-host"
            value={current.host}
            disabled={current.type === ''}
            onChange={(e): void => {
              setDraft({ ...current, host: e.target.value });
            }}
          />
          <label htmlFor="proxy-port" className="text-sm font-medium leading-9">Port</label>
          <Input
            id="proxy-port"
            value={current.port}
            disabled={current.type === ''}
            onChange={(e): void => {
              setDraft({ ...current, port: e.target.value });
            }}
          />
          <label htmlFor="proxy-user" className="text-sm font-medium leading-9">User</label>
          <Input
            id="proxy-user"
            value={current.user}
            disabled={current.type === ''}
            onChange={(e): void => {
              setDraft({ ...current, user: e.target.value });
            }}
          />
          <label htmlFor="proxy-pass" className="text-sm font-medium leading-9">Password</label>
          <Input
            id="proxy-pass"
            type="password"
            value={current.pass}
            disabled={current.type === ''}
            onChange={(e): void => {
              setDraft({ ...current, pass: e.target.value });
            }}
          />
          <div className="col-start-2 mt-2">
            <Button type="submit" size="sm" disabled={update.isPending || draft === undefined}>
              {update.isPending ? 'Saving…' : 'Save proxy'}
            </Button>
          </div>
        </form>
        {update.isError ? <ErrorBanner error={update.error} /> : null}
        {update.isSuccess ? (
          <p role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground">
            Saved. Global proxy: {update.data.proxy.type === '' ? 'none' : `${update.data.proxy.type} ${update.data.proxy.host}:${update.data.proxy.port}`}
            . Modules use the global config unless they carry their own override.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
