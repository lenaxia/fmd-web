/**
 * AccountsSection (§8.6/D4 — FMD2 frmAccountManager adaptation): one
 * AccountCard per AccountSupport site. FMD2's grid of site rows maps
 * onto cards: username/password (masked, show toggle — the password is
 * write-only server-side, so the field starts EMPTY on every load and
 * Save PUTs only what was typed; omitted credential fields keep the
 * sealed stored values), Remove (DELETE), and 'Check login' (POST
 * /login runs the module's real OnLogin — the returned §5.2 account
 * status renders as a badge: asValid/asInvalid/asUnknown/asChecking).
 * The cookies editor is a link-OUT to the existing per-module cookies
 * form in the module list (§5.3 module_state — one cookie home).
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { Eye, EyeOff, KeyRound, LogIn, Trash2 } from 'lucide-react';
import {
  useAccounts,
  useCheckAccountLogin,
  useRemoveAccount,
  useUpsertAccount,
  type AccountStatusT,
  type ModuleSummaryT,
} from '../api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';

/** §5.2 account-status badge (frmAccountManager state captions). */
function AccountStatusBadge(props: { status: AccountStatusT | undefined }): ReactElement | null {
  if (props.status === undefined) {
    return null;
  }
  const tone: 'default' | 'secondary' | 'destructive' | 'outline' =
    props.status === 'asValid'
      ? 'default'
      : props.status === 'asInvalid'
        ? 'destructive'
        : props.status === 'asChecking'
          ? 'outline'
          : 'secondary';
  const caption: string =
    props.status === 'asValid'
      ? 'Login valid'
      : props.status === 'asInvalid'
        ? 'Login invalid'
        : props.status === 'asChecking'
          ? 'Checking…'
          : 'Unknown';
  return (
    <Badge variant={tone} data-status={props.status} data-testid={`account-status-${props.status}`}>
      {caption}
    </Badge>
  );
}

function AccountCard(props: {
  readonly module: ModuleSummaryT;
  readonly stored?: { readonly username: string; readonly status: AccountStatusT };
  readonly onOpenCookies: (moduleId: string) => void;
}): ReactElement {
  const { module, stored } = props;
  const upsert = useUpsertAccount();
  const remove = useRemoveAccount();
  const check = useCheckAccountLogin();

  const [username, setUsername] = useState(stored?.username ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const status: AccountStatusT | undefined = check.data?.account.status ?? stored?.status;

  const save = (): void => {
    upsert.mutate({
      moduleId: module.id,
      username: username.trim() === '' ? (stored?.username ?? '') : username.trim(),
      ...(password !== '' ? { password } : {}),
    });
    setPassword('');
  };

  return (
    <form
      className="account-card flex flex-col gap-2 rounded-lg border bg-surface/40 p-4"
      aria-label={`Account for ${module.name}`}
      data-module-id={module.id}
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{module.name}</span>
        <AccountStatusBadge status={status} />
        {upsert.isSuccess ? (
          <span role="status" className="text-xs text-muted-foreground">
            Saved
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`account-username-${module.id}`} className="sr-only">
          Username for {module.name}
        </label>
        <Input
          id={`account-username-${module.id}`}
          className="w-44"
          autoComplete="off"
          placeholder="username"
          value={username}
          onChange={(e): void => {
            setUsername(e.target.value);
          }}
        />
        <label htmlFor={`account-password-${module.id}`} className="sr-only">
          Password for {module.name}
        </label>
        <div className="relative">
          <Input
            id={`account-password-${module.id}`}
            className="w-44 pr-9"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={stored !== undefined ? 'password (unchanged)' : 'password'}
            value={password}
            onChange={(e): void => {
              setPassword(e.target.value);
            }}
          />
          <button
            type="button"
            aria-label={showPassword ? `Hide password for ${module.name}` : `Show password for ${module.name}`}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={(): void => {
              setShowPassword((prev) => !prev);
            }}
          >
            {showPassword ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={upsert.isPending || (username.trim() === '' && stored === undefined)}>
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={check.isPending || (stored === undefined && upsert.data === undefined)}
          onClick={(): void => {
            check.mutate(module.id);
          }}
        >
          <LogIn aria-hidden="true" />
          {check.isPending ? 'Checking…' : 'Check login'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          onClick={(): void => {
            props.onOpenCookies(module.id);
          }}
        >
          Cookies…
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto text-destructive hover:text-destructive"
          disabled={remove.isPending || (stored === undefined && upsert.data === undefined)}
          onClick={(): void => {
            remove.mutate(module.id);
          }}
        >
          <Trash2 aria-hidden="true" />
          Remove
        </Button>
      </div>

      {upsert.isError ? <ErrorBanner error={upsert.error} /> : null}
      {remove.isError ? <ErrorBanner error={remove.error} /> : null}
      {check.isError ? <ErrorBanner error={check.error} /> : null}
      {check.isSuccess ? (
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          OnLogin finished for <code className="font-mono">{module.name}</code> — status{' '}
          <code className="font-mono">{check.data.account.status}</code>.
        </p>
      ) : null}
    </form>
  );
}

/**
 * The accounts list: cards for every AccountSupport module, joined
 * against GET /api/accounts for the stored username + login status.
 * FMD2 parity: exactly one account per site (frmAccountManager).
 *
 * Render cap (ADAPT): sites WITH a stored account always render;
 * credential-less sites render the first UNSTORED_CAP with a "Show
 * all" expander — the production registry carries hundreds of
 * account-capable sites and the FMD2 grid never had to virtualize.
 */
export const UNSTORED_ACCOUNT_CAP = 24;

export function AccountsSection(props: {
  readonly modules: readonly ModuleSummaryT[];
  readonly onOpenCookies: (moduleId: string) => void;
}): ReactElement {
  const accounts = useAccounts();
  const [showAll, setShowAll] = useState(false);
  const supported: readonly ModuleSummaryT[] = props.modules.filter((m): boolean => m.accountSupport);
  const byId: Map<string, { username: string; status: AccountStatusT }> = new Map(
    (accounts.data?.accounts ?? []).map((a): [string, { username: string; status: AccountStatusT }] => [
      a.moduleId,
      { username: a.username, status: a.status },
    ]),
  );
  const stored: readonly ModuleSummaryT[] = supported.filter((m): boolean => byId.has(m.id));
  const unstored: readonly ModuleSummaryT[] = supported.filter((m): boolean => !byId.has(m.id));
  const visibleUnstored: readonly ModuleSummaryT[] =
    showAll || unstored.length <= UNSTORED_ACCOUNT_CAP ? unstored : unstored.slice(0, UNSTORED_ACCOUNT_CAP);
  const hidden: number = unstored.length - visibleUnstored.length;

  return (
    <section aria-label="Accounts" className="accounts-section" data-testid="accounts-section">
      <h2 className="mb-2 text-lg font-semibold">
        Accounts{' '}
        <span className="text-sm font-normal text-muted-foreground">
          ({supported.length} site{supported.length === 1 ? '' : 's'} with account support)
        </span>
      </h2>
      {supported.length === 0 ? (
        <EmptyState title="No account-supporting sites registered">
          <p>No registered module declares AccountSupport — there is nothing to manage yet.</p>
        </EmptyState>
      ) : accounts.isError ? (
        <ErrorBanner error={accounts.error} />
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {stored.map((module): ReactElement => {
              const storedAccount = byId.get(module.id);
              return (
                <AccountCard
                  key={module.id}
                  module={module}
                  {...(storedAccount !== undefined ? { stored: storedAccount } : {})}
                  onOpenCookies={props.onOpenCookies}
                />
              );
            })}
            {visibleUnstored.map((module): ReactElement => (
              <AccountCard key={module.id} module={module} onOpenCookies={props.onOpenCookies} />
            ))}
          </div>
          {hidden > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={(): void => {
                setShowAll(true);
              }}
            >
              Show all {String(unstored.length)} sites ({String(hidden)} more)
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
