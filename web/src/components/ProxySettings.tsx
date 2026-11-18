/**
 * Settings → Proxy (§9/§10, §5.4 SetProxy parity): the GLOBAL proxy
 * editor collapsed into a drawer — most users never touch a proxy, so
 * the section renders as a one-line summary ("Global proxy: none") +
 * a single Configure affordance; the five-string editor (type
 * HTTP|SOCKS4|SOCKS5, host, port, user, pass) opens in a bottom sheet
 * (R3 mobile-first; the adaptation principle's "bottom sheets not
 * modal dialogs"). The all-empty config is "no proxy" (SetNoProxy);
 * the §5.11 browser sidecar profile badge stays visible at a glance.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { Globe, Settings2 } from 'lucide-react';
import { useSettings, useUpdateProxy, type ProxySettingsT } from '../api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
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

  const summary: string =
    current.type === '' ? 'none' : `${current.type} ${current.host}:${current.port}`;

  return (
    <section role="region" aria-label="Proxy settings" className="mb-6" data-testid="proxy-section">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-surface/40 px-4 py-3">
        <Globe aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Global proxy</span>
        <span className="font-mono text-xs text-muted-foreground" data-testid="proxy-summary">
          {summary}
        </span>
        <ul className="badge-list flex list-none flex-wrap items-center gap-1 p-0" aria-label="Browser sidecar status">
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
        <Sheet>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="ml-auto" data-testid="proxy-drawer-open">
              <Settings2 aria-hidden="true" />
              Configure
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto" data-testid="proxy-drawer">
            <SheetHeader>
              <SheetTitle>Global proxy</SheetTitle>
              <SheetDescription>
                Applies to every module without its own override (per-module overrides live in
                each site's Configure editor).
              </SheetDescription>
            </SheetHeader>
            <form
              className="proxy-form grid max-w-md grid-cols-[max-content_1fr] content-center gap-x-4 gap-y-2 px-4 pb-6"
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
              <p role="status" aria-live="polite" className="px-4 pb-6 text-sm text-muted-foreground">
                Saved. Global proxy: {update.data.proxy.type === '' ? 'none' : `${update.data.proxy.type} ${update.data.proxy.host}:${update.data.proxy.port}`}
                . Modules use the global config unless they carry their own override.
              </p>
            ) : null}
          </SheetContent>
        </Sheet>
      </div>
    </section>
  );
}
