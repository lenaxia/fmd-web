/**
 * '/'-to-search focus channel (search-first home): the global shortcut
 * lives in the app shell, the input lives in the search home — this
 * tiny bus bridges them. A focus request sets a PENDING flag (a
 * request that arrives while the home is unmounted — e.g. '/' pressed
 * on the Downloads tab, which navigates first — is consumed by the
 * home's mount effect) and then notifies live listeners (the home is
 * already mounted — focus fires immediately). Exactly-once either way.
 */
const listeners = new Set<() => void>();

let pending = false;

export function subscribeSearchFocus(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** Request the search-home input's focus (app shell '/' handler). */
export function requestSearchFocus(): void {
  pending = true;
  for (const listener of listeners) {
    listener();
  }
}

/** Consume the pending request — true exactly once per request. */
export function consumeSearchFocusRequest(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}
