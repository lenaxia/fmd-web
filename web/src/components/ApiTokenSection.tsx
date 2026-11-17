/**
 * R4 Settings → API section: the SINGLE app-wide API token
 * (Sonarr/Radarr model, docs/UX-PARITY.md R4). Masked key with a
 * reveal toggle + copy button + Regenerate behind a confirm dialog
 * ("Revokes the current key immediately — update your scripts").
 * Env-pinned deployments (FMD_WEB_API_TOKEN) show "Managed via
 * environment" and hide Regenerate — the secret lives in the
 * deployment environment, rotation happens there (runbook §API token).
 */
import { useState, type ReactElement } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { useApiToken, useRegenerateApiToken } from '../api/hooks';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function mask(token: string): string {
  return token.length <= 4 ? '••••' : `••••••••••••••••${token.slice(-4)}`;
}

const MODE_LABEL: Record<string, string> = {
  none: 'no auth (open)',
  password: 'password (cookie login)',
  'api-token': 'API token only (API-only mode)',
  'password+api-token': 'password + API token',
};

export function ApiTokenSection(): ReactElement {
  const tokenQuery = useApiToken();
  const regenerate = useRegenerateApiToken();
  const [revealed, setRevealed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const data = tokenQuery.data;

  const copy = async (): Promise<void> => {
    if (data?.token === undefined || data.token === null) {
      return;
    }
    try {
      await globalThis.navigator.clipboard.writeText(data.token);
      setCopied(true);
      toast.success('API token copied');
      setTimeout((): void => {
        setCopied(false);
      }, 1500);
    } catch {
      toast.error('Clipboard unavailable — reveal the key and copy it manually');
    }
  };

  const doRegenerate = (): void => {
    regenerate.mutate(undefined, {
      onSuccess: (): void => {
        setConfirmOpen(false);
        setRevealed(true);
        toast.success('API token regenerated — the old key is revoked, update your scripts');
      },
      onError: (): void => {
        setConfirmOpen(false);
      },
    });
  };

  return (
    <section aria-label="API" className="api-token-settings mb-6" data-testid="api-token-settings">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <KeyRound aria-hidden="true" className="size-4" />
        API
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        The single app-wide API token (Sonarr/Radarr-style) — one key per deployment, used by
        scripts via <code>Authorization: Bearer &lt;token&gt;</code> on every /api route and
        /ws. Cookbook: docs/API.md. Auth mode:{' '}
        <span data-testid="api-token-mode">{data !== undefined ? (MODE_LABEL[data.mode] ?? data.mode) : '…'}</span>
      </p>

      {tokenQuery.isError ? (
        <p role="note" className="rounded-lg border bg-surface/40 p-4 text-sm text-muted-foreground" data-testid="api-token-unavailable">
          API token state unavailable (not reachable or not authenticated).
        </p>
      ) : data === undefined ? (
        <p className="rounded-lg border bg-surface/40 p-4 text-sm text-muted-foreground">Loading…</p>
      ) : data.envManaged ? (
        <div className="rounded-lg border bg-surface/40 p-4">
          <p className="text-sm font-medium" data-testid="api-token-managed">
            Managed via environment
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            FMD_WEB_API_TOKEN pins the key (env overrides the settings store) — read and rotate
            it in the deployment environment; Regenerate is disabled here.
          </p>
        </div>
      ) : data.token === null ? (
        <div className="rounded-lg border bg-surface/40 p-4">
          <p className="text-sm font-medium">No API token</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Auth is off. A token is generated automatically on first start once a password is
            set (FMD_WEB_PASSWORD), or pin one headless via FMD_WEB_API_TOKEN — see
            docs/runbook.md §API token.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-surface/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-sm"
              data-testid="api-token-value"
              aria-label="API token"
            >
              {revealed ? data.token : mask(data.token)}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={revealed ? 'Hide API token' : 'Reveal API token'}
              onClick={(): void => {
                setRevealed(!revealed);
              }}
            >
              {revealed ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Copy API token"
              onClick={(): void => {
                void copy();
              }}
            >
              {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="api-token-regenerate"
              onClick={(): void => {
                setConfirmOpen(true);
              }}
            >
              <RotateCw aria-hidden="true" className="size-4" />
              Regenerate
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Treat it like a password: scripts send it as a Bearer header; regeneration revokes
            the old key on its very next request.
          </p>

          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Regenerate API token?</DialogTitle>
                <DialogDescription>
                  Revokes the current key immediately — update your scripts.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  data-testid="api-token-regenerate-confirm"
                  disabled={regenerate.isPending}
                  onClick={doRegenerate}
                >
                  {regenerate.isPending ? 'Regenerating…' : 'Regenerate'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </section>
  );
}
