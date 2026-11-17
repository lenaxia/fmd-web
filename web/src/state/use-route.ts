/**
 * Route-from-hash subscription (tsk-savvy-jockey-ambles): the app
 * shell owns routing (App.tsx), but pages that sync state INTO the URL
 * (Browse's filter state) must re-render on EVERY hash mutation —
 * including replaceState-based ones (typing) and back/forward
 * navigation. `initial` seeds state for renders without a live hash.
 *
 * Implemented over useSyncExternalStore — the React primitive for
 * external-store subscriptions — so listener notifications always
 * commit (a plain setState listener proved flaky under jsdom/act).
 *
 * NAME-STABLE: hash mutations whose parsed route name differs from the
 * initial one are ignored — in production the shell unmounts this page
 * on a name change, so the hook never follows them; ignoring keeps a
 * directly mounted page (tests) stable when the flow navigates
 * elsewhere (e.g. the manga deep-link).
 */
import { useSyncExternalStore } from 'react';
import { parseHash, type Route } from '../router';

interface Snapshot {
  readonly raw: string;
  readonly route: Route;
}

/** Cached parse (stable identity per distinct hash — React requires it). */
let snapshot: Snapshot | null = null;

function currentSnapshot(): Snapshot {
  const raw: string = globalThis.location.hash;
  if (snapshot === null || snapshot.raw !== raw) {
    snapshot = { raw, route: parseHash(raw) };
  }
  return snapshot;
}

const listeners: Set<() => void> = new Set();

function onHashChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('hashchange', onHashChange);
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return (): void => {
    listeners.delete(onStoreChange);
  };
}

export function useRoute(initial: Route): Route {
  const getSnapshot = (): Route => {
    const live: Snapshot = currentSnapshot();
    // Empty live hash (a bare test render) or a foreign route name —
    // keep the prop route.
    if (live.raw === '' || live.route.name !== initial.name) {
      return initial;
    }
    return live.route;
  };
  return useSyncExternalStore(subscribe, getSnapshot, (): Route => initial);
}
