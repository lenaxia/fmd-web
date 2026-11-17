/**
 * PWA install availability store (R5 arrival).
 *
 * Captures the browser's `beforeinstallprompt` (Chromium: fired when
 * the installability criteria are met and the UA is about to show its
 * own affordance) so the APP decides where install surfaces — the
 * Settings → About section and the command palette — instead of a
 * browser-chrome-only path. The captured event is the ONE call to
 * `prompt()`; after it fires (accept or dismiss) the browser will not
 * re-offer until its own cooldown passes, so the store drops to
 * unavailable and the surfaces vanish again.
 *
 * Platform quirks (documented in docs/UX-PARITY.md):
 *   - Chrome/Edge (desktop + Android): beforeinstallprompt fires;
 *     our surfaces appear. iOS Safari NEVER fires it — installation is
 *     the Share → Add to Home Screen path (served by the apple-touch
 *     icon + apple-mobile-web-app meta in the SPA shell), so the app
 *     surfaces stay hidden there by design.
 *   - Firefox/Safari desktop: no event, no surfaces — nothing renders.
 *
 * useSyncExternalStore keeps this React-18-clean (no version tearing,
 * SSR-safe snapshot) with listeners attached at module load — the
 * bundle imports this via the eagerly-loaded app shell.
 */
import { useSyncExternalStore } from 'react';

/** The minimal surface of the non-standard captured event we use. */
interface BeforeInstallPromptLike {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallSnapshot {
  readonly available: boolean;
  readonly installed: boolean;
}

let deferredPrompt: BeforeInstallPromptLike | null = null;
let installed = false;
const listeners = new Set<() => void>();

/**
 * Cached snapshot — useSyncExternalStore requires a STABLE reference
 * until the store actually changes (a fresh object per call is an
 * infinite render loop). Rebuilt only in emit().
 */
let snapshotCache: InstallSnapshot = { available: false, installed: false };

function emit(): void {
  snapshotCache = { available: deferredPrompt !== null, installed };
  for (const listener of listeners) {
    listener();
  }
}

function onBeforeInstallPrompt(event: Event): void {
  // Keep the UA's own mini-infobar out of the picture; we own the UX.
  event.preventDefault();
  const candidate = event as Event & Partial<BeforeInstallPromptLike>;
  if (typeof candidate.prompt !== 'function') {
    // A synthetic/polyfill event without prompt() cannot install —
    // record nothing (surfaces stay hidden; tests dispatch rich events).
    return;
  }
  deferredPrompt = candidate as Event & BeforeInstallPromptLike;
  installed = false;
  emit();
}

function onAppInstalled(): void {
  installed = true;
  deferredPrompt = null;
  emit();
}

if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.addEventListener === 'function') {
  globalThis.window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  globalThis.window.addEventListener('appinstalled', onAppInstalled);
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function installSnapshot(): InstallSnapshot {
  return snapshotCache;
}

/**
 * Surface the install flow: resolves once the browser prompt settles.
 * 'unavailable' when nothing was captured (defensive — callers gate on
 * the snapshot, but race-free code should not assume).
 */
export function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const captured = deferredPrompt;
  if (captured === null) {
    return Promise.resolve('unavailable');
  }
  deferredPrompt = null;
  emit();
  return captured
    .prompt()
    .then((choice): 'accepted' | 'dismissed' => {
      if (choice.outcome === 'accepted') {
        installed = true;
        emit();
      }
      return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
    })
    .catch((): 'dismissed' => 'dismissed');
}

export function useInstallAvailability(): InstallSnapshot {
  return useSyncExternalStore(subscribeInstall, installSnapshot, installSnapshot);
}
