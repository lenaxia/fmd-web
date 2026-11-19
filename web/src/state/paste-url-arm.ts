/**
 * Paste-URL arm channel ([crystal-nectar-pricks] D1 §2 ENTER — the
 * universal front door): the command palette's "Add manga by URL"
 * action is a LAUNCHER, not a second form — it lands the URL in the
 * search home's paste box, where the ONE preview/follow flow lives.
 * This bus bridges the two, exactly like state/search-focus.ts: an
 * arm request that arrives while the home is unmounted (the palette
 * navigates first) sets a PENDING url consumed by the home's mount
 * effect; one that arrives while it is mounted notifies live
 * listeners. Exactly-once either way.
 */
const listeners = new Set<(url: string) => void>();

let pending: string | undefined;

export function subscribePasteUrl(listener: (url: string) => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** Arm the search-home paste box with a URL (palette action). */
export function armPasteUrl(url: string): void {
  pending = url;
  for (const listener of listeners) {
    listener(url);
  }
}

/** Consume the pending arm — the url exactly once per request. */
export function consumePasteUrlArm(): string | undefined {
  const wasPending = pending;
  pending = undefined;
  return wasPending;
}

/**
 * Normalize raw pasted text into an absolute http(s) URL — undefined
 * when the text is not URL-shaped at all. Scheme-less site hosts
 * (`mangadex.org/title/x`) get https:// prepended (paste payloads
 * routinely drop the scheme); `www.` gets the same treatment.
 */
export function normalizePastedUrl(raw: string): string | undefined {
  const text: string = raw.trim();
  if (text === '') {
    return undefined;
  }
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  if (/^(www\.|[\w-]+(\.[\w-]+)+)(\/|$|\?)/.test(text)) {
    return `https://${text}`;
  }
  return undefined;
}
