/**
 * Catalog provisioning state machine (site-first browse, FMD2
 * DBUpdaterThread parity): subscribes to the WS hub's `sync` frames for
 * ONE `catalog-sync:<moduleId>` job key and reduces them into a typed
 * terminal state machine:
 *
 *   idle → installing → ready | no-catalog | failed
 *   (any state → cancelled, client-side only — a cancelled provision
 *    never crosses the wire; it is the fetch abort, not a server event)
 *
 * `no-catalog` is the FMD2-DB 404 taxonomy (no prebuilt catalog — offer
 * the §6.8 live-scrape browse); `failed` is transient/network — the
 * retry affordance. Terminal states are settled: later frames for the
 * same job (e.g. a re-provision) are ignored until the hook resets via
 * `reset()`, so a stale toast can never flip back to installing.
 *
 * Transport: the SAME D19 backfill controller the downloads feed uses
 * (shared protocol, dedicated socket while a provision is in flight).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogSyncPhaseT, CatalogSyncProgressT } from '@fmd/contract';
import { wsEndpointUrl } from '../api/client';
import {
  WsBackfillController,
  type WebSocketFactory,
  type WsStatus,
} from './ws-backfill';
import type { SyncEventMessage } from './ws-protocol';

/** The typed provision state machine (terminal states are settled). */
export type ProvisionMachine =
  | { readonly state: 'idle' }
  | {
      readonly state: 'installing';
      readonly phase: CatalogSyncPhaseT;
      readonly detail?: string;
      readonly percent?: number;
    }
  | { readonly state: 'ready' }
  | { readonly state: 'no-catalog'; readonly detail?: string }
  | { readonly state: 'failed'; readonly detail?: string }
  | { readonly state: 'cancelled' };

export const INITIAL_PROVISION: ProvisionMachine = { state: 'idle' };

/** Terminal outcome → machine state (the typed transition table). */
export function reduceProvision(
  state: ProvisionMachine,
  event: CatalogSyncProgressT,
): ProvisionMachine {
  // Terminal states are settled — only an explicit reset() re-arms.
  if (state.state === 'ready' || state.state === 'no-catalog' || state.state === 'failed' || state.state === 'cancelled') {
    return state;
  }
  switch (event.phase) {
    case 'checking':
    case 'downloading':
    case 'extracting':
    case 'installing': {
      // A phase advance without percent keeps the previous coarse
      // measure (monotone floor); detail is per-phase and replaced.
      const prevPercent =
        state.state === 'installing' && event.percent === undefined ? state.percent : undefined;
      const percent = event.percent ?? prevPercent;
      return {
        state: 'installing',
        phase: event.phase,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(percent !== undefined ? { percent } : {}),
      };
    }
    case 'done':
    case 'failed': {
      const outcome = event.phase === 'failed' ? 'failed' : (event.outcome ?? 'updated');
      if (outcome === 'updated' || outcome === 'unchanged') {
        return { state: 'ready' };
      }
      if (outcome === 'no-catalog') {
        return { state: 'no-catalog', ...(event.detail !== undefined ? { detail: event.detail } : {}) };
      }
      return { state: 'failed', ...(event.detail !== undefined ? { detail: event.detail } : {}) };
    }
    default:
      return state;
  }
}

export interface SyncCatalogProgress {
  /** The reduced state machine. */
  readonly machine: ProvisionMachine;
  /** The raw WS connection status (idle until a job key is given). */
  readonly status: WsStatus;
  /** True while the machine is in a non-idle, non-terminal state. */
  readonly inFlight: boolean;
  /** Arm/re-arm the machine (a fresh provision attempt). */
  readonly reset: () => void;
}

export function useSyncCatalogProgress(options: {
  /** Ring correlation key (`catalog-sync:<moduleId>`); undefined = idle. */
  readonly jobId?: string;
  /** Start/stop the socket (defaults to jobId !== undefined). */
  readonly enabled?: boolean;
  readonly webSocketFactory?: WebSocketFactory;
}): SyncCatalogProgress {
  const { jobId } = options;
  const enabled = options.enabled ?? jobId !== undefined;
  const factoryRef = useRef<WebSocketFactory | undefined>(options.webSocketFactory);
  const [machine, setMachine] = useState<ProvisionMachine>(INITIAL_PROVISION);
  const [status, setStatus] = useState<WsStatus>('idle');

  useEffect((): (() => void) => {
    if (!enabled || jobId === undefined) {
      setStatus('idle');
      return (): void => {};
    }
    setMachine(INITIAL_PROVISION);
    const controller = new WsBackfillController({
      url: wsEndpointUrl(),
      ...(factoryRef.current !== undefined ? { webSocketFactory: factoryRef.current } : {}),
      onSyncEvent: (event: SyncEventMessage): void => {
        if (event.sync.jobId !== jobId) return;
        setMachine((prev): ProvisionMachine => reduceProvision(prev, event.sync));
      },
      onResync: (): void => {
        /* D19 resync: progress frames may have been lost — the REST
         * POST resolution remains the source of truth for the terminal
         * outcome; nothing to refetch proactively here. */
      },
    });
    controller.start();
    const poll = setInterval((): void => {
      setStatus((prev): WsStatus => (prev === controller.status ? prev : controller.status));
    }, 250);
    return (): void => {
      clearInterval(poll);
      controller.stop();
    };
  }, [enabled, jobId]);

  const reset = useCallback((): void => {
    setMachine(INITIAL_PROVISION);
  }, []);

  return {
    machine,
    status,
    inFlight: machine.state === 'installing',
    reset,
  };
}
