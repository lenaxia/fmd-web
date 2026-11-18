/**
 * FavoritesSettingsForm (favorites-parity): the FMD2 Options → Updates
 * surface the server supports — the scheduled-check interval in
 * minutes (`OptionAutoCheckFavIntervalMinutes` analog; 0 = scheduled
 * checks off, applies LIVE to the running scheduler) and the
 * check-at-startup toggle (`OptionCheckFavoritesAtStart`, gates the
 * next boot's initial sweep). Auto-remove-completed and the download
 * thread cap are documented deferred (see UX-PARITY.md).
 */
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Timer } from 'lucide-react';
import { useSettings, useUpdateFavoritesSchedulerSettings } from '../api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';

const DEFAULTS = { intervalMinutes: 60, checkAtStartup: true };

export function FavoritesSettingsForm(): ReactElement {
  const settings = useSettings();
  const update = useUpdateFavoritesSchedulerSettings();

  const [interval, setIntervalMinutes] = useState(DEFAULTS.intervalMinutes);
  const [checkAtStartup, setCheckAtStartup] = useState(DEFAULTS.checkAtStartup);

  // Seed the draft from the server snapshot once it lands; a snapshot
  // without the favorites group (older server / mid-rollout) keeps the
  // defaults — the form never crashes on a partial response.
  const server = settings.data?.favorites;
  useEffect((): void => {
    if (server !== undefined) {
      setIntervalMinutes(server.intervalMinutes);
      setCheckAtStartup(server.checkAtStartup);
    }
  }, [server]);

  const dirty: boolean =
    server !== undefined &&
    (interval !== server.intervalMinutes ||
      checkAtStartup !== server.checkAtStartup);

  if (settings.isError) {
    return (
      <section aria-label="Favorites checks" className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Favorites checks</h2>
        <ErrorBanner error={settings.error} />
      </section>
    );
  }

  return (
    <section aria-label="Favorites checks" className="favorites-settings-form mb-6" data-testid="favorites-settings-form">
      <h2 className="mb-2 text-lg font-semibold">Favorites checks</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        The scheduled new-chapter checks (bounded concurrency, per-check
        jitter). The interval applies immediately; 0 turns scheduled checks
        off (Check now keeps working).
      </p>
      <form
        className="grid max-w-md gap-3"
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate({ intervalMinutes: interval, checkAtStartup });
        }}
      >
        <label htmlFor="favorites-interval" className="grid gap-1 text-sm font-medium">
          Check interval (minutes, 0 = off)
          <Input
            id="favorites-interval"
            type="number"
            min={0}
            max={20160}
            className="max-w-40"
            data-testid="favorites-interval-input"
            value={interval}
            disabled={settings.isPending}
            onChange={(event): void => {
              const parsed = Number.parseInt(event.target.value, 10);
              setIntervalMinutes(Number.isNaN(parsed) ? 0 : parsed);
            }}
          />
        </label>
        <label htmlFor="favorites-startup" className="flex items-center gap-2 text-sm font-medium" data-testid="favorites-startup-label">
          <Checkbox
            id="favorites-startup"
            checked={checkAtStartup}
            onCheckedChange={(value): void => setCheckAtStartup(value === true)}
            data-testid="favorites-startup-checkbox"
            disabled={settings.isPending}
          />
          Check favorites at startup
        </label>
        {update.isError ? <ErrorBanner error={update.error} /> : null}
        {update.isSuccess && !dirty ? (
          <p role="status" className="text-sm text-primary" data-testid="favorites-settings-saved">
            Saved. The new cadence applies to the running scheduler.
          </p>
        ) : null}
        <div>
          <Button type="submit" size="sm" disabled={settings.isPending || update.isPending || !dirty} data-testid="favorites-settings-save">
            <Timer aria-hidden="true" />
            {update.isPending ? 'Saving…' : 'Save favorites settings'}
          </Button>
        </div>
      </form>
    </section>
  );
}
