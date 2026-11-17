/**
 * ProvisionToast (site-first browse): the WS-driven sonner progress
 * toast for catalog auto-provisioning (FMD2 DBUpdaterThread dialog
 * parity — web default is AUTO with visible progress + cancel). Maps
 * the typed provision state machine onto toast transitions:
 *
 *   installing → loading toast with phase text + indeterminate bar +
 *                a Cancel action (aborts the REST fetch)
 *   ready      → success (entries open on completion)
 *   no-catalog → friendly "no prebuilt catalog" error
 *   failed     → error with the transient-retry hint
 *   cancelled  → quiet dismissal
 *
 * Built on the same sonner + Progress primitives as the
 * ProgressToast pattern (Settings sync); the Cancel action is the
 * addition the pattern does not carry.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import type { ProvisionMachine } from '../state/use-sync-catalog-progress';
import type { CatalogSyncPhaseT } from '@fmd/contract';

/** Phase → coarse determinate measure (§6.1–§6.3 ordinal order). */
const PHASE_PERCENT: Partial<Record<CatalogSyncPhaseT, number>> = {
  checking: 10,
  downloading: 40,
  extracting: 70,
  installing: 90,
};

const PHASE_TEXT: Record<string, string> = {
  checking: 'Looking for the site’s list…',
  downloading: 'Downloading the site’s list…',
  extracting: 'Unpacking the site’s list…',
  installing: 'Finishing up…',
};

/** Pure message projection (unit-tested): machine → toast (message, determinate %).
 * Plumbing-free by charter: no source names, no mode vocabulary — the
 * user only ever learns that the site is being prepared. */
export function provisionToastMessage(
  machine: ProvisionMachine,
  siteName: string,
): { message: string; progress?: number | undefined } {
  switch (machine.state) {
    case 'idle':
      return { message: `Preparing ${siteName}…` };
    case 'installing':
      return {
        message: `${siteName}: ${PHASE_TEXT[machine.phase] ?? 'Preparing…'}`,
        ...(PHASE_PERCENT[machine.phase] !== undefined ? { progress: PHASE_PERCENT[machine.phase] } : {}),
      };
    case 'ready':
      return { message: `${siteName} is ready.` };
    case 'no-catalog':
      return {
        message: `${siteName}: no list is available for this site yet.`,
      };
    case 'failed':
      return { message: `${siteName}: couldn’t open the site — check your connection and retry.` };
    case 'cancelled':
      return { message: `${siteName}: cancelled.` };
    default:
      return { message: `${siteName}…` };
  }
}

function toastBody(message: string, progress?: number, onCancel?: () => void): ReactElement {
  return (
    <span className="flex w-full flex-col gap-2">
      <span className="provision-toast-message">{message}</span>
      {progress !== undefined ? <Progress value={progress} aria-label={`${String(Math.round(progress))}%`} /> : null}
      {onCancel !== undefined ? (
        <span className="flex justify-end">
          {/* sonner action placement: an explicit, focusable cancel */}
          <button
            type="button"
            className="provision-cancel text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={onCancel}
          >
            Cancel
          </button>
        </span>
      ) : null}
    </span>
  );
}

/**
 * React binding: reduce the machine to toast transitions. One toast id
 * for the whole run; cancel stays available while installing; terminal
 * states resolve the toast and unmount dismisses an unsettled one.
 */
export function ProvisionToast(props: {
  machine: ProvisionMachine;
  siteName: string;
  onCancel: () => void;
}): null {
  const idRef = useRef<string | number | null>(null);
  const cancelRef = useRef(props.onCancel);
  cancelRef.current = props.onCancel;
  const settledRef = useRef(false);

  useEffect((): void => {
    const machine = props.machine;
    if (machine.state === 'idle') return;
    const { message, progress } = provisionToastMessage(machine, props.siteName);
    const installing = machine.state === 'installing';
    if (installing) {
      settledRef.current = false;
    }
    const id = idRef.current;
    if (id === null) {
      idRef.current = toast.loading(
        toastBody(message, progress, installing ? (): void => cancelRef.current() : undefined),
      );
    } else if (machine.state === 'ready') {
      settledRef.current = true;
      toast.success(message, { id });
    } else if (machine.state === 'no-catalog') {
      settledRef.current = true;
      toast.error(message, { id });
    } else if (machine.state === 'failed') {
      settledRef.current = true;
      toast.error(message, { id });
    } else if (machine.state === 'cancelled') {
      settledRef.current = true;
      toast.dismiss(id);
    } else {
      toast.loading(toastBody(message, progress, installing ? (): void => cancelRef.current() : undefined), { id });
    }
  }, [props.machine, props.siteName]);

  useEffect((): (() => void) => {
    return (): void => {
      if (idRef.current !== null && !settledRef.current) {
        toast.dismiss(idRef.current);
      }
    };
  }, []);

  return null;
}
