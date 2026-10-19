export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** How often an open app asks the server whether a newer version was published (owner: updates must land at once). */
const UPDATE_CHECK_MS = 60_000;
/** A pending update waits only for the current tap or keystroke to finish. */
const IDLE_BEFORE_RELOAD_MS = 3_000;

let reloadPending = false;
let lastInteraction = Date.now();

/** Someone is typing in a field: reloading now would throw their input away. */
const isEditing = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
};
/** A dialog (scan result, confirmation, form) is open: wait until it is closed. */
const hasOpenDialog = () => Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'));

function reloadIfSafe(force = false) {
  if (!reloadPending) return;
  if (!force && (isEditing() || hasOpenDialog() || Date.now() - lastInteraction < IDLE_BEFORE_RELOAD_MS)) return;
  reloadPending = false;
  window.location.reload();
}

/**
 * Installs the service worker and keeps every open copy of the app on the latest version: it checks
 * for a new version every minute, when the app comes back to the screen or gets focus, and when the
 * connection returns; the new service worker takes over at once (skipWaiting + clientsClaim in sw.ts)
 * and the page reloads right away — unless a field is being typed in or a dialog is open, in which
 * case it waits for that to finish (or for the next page change, or for the app to go to the background).
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  // the very first install also takes control; only a replacement means a new version
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    reloadPending = true;
    if (document.visibilityState === 'hidden') reloadIfSafe(true);
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        const check = () => void reg.update().catch(() => undefined);
        setInterval(check, UPDATE_CHECK_MS);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
          else reloadIfSafe(true);
        });
        window.addEventListener('online', check);
        window.addEventListener('focus', check);
        window.addEventListener('pageshow', check);
        check();
      })
      .catch(() => undefined);
  });

  for (const type of ['pointerdown', 'keydown', 'input', 'scroll'] as const) {
    window.addEventListener(type, () => (lastInteraction = Date.now()), { passive: true, capture: true });
  }
  setInterval(() => reloadIfSafe(), 1_000);
}

/** Called on every in-app page change: the moment between two pages is a safe time to update. */
export function reloadOnNavigationIfUpdated() {
  if (reloadPending && !hasOpenDialog()) reloadIfSafe(true);
}

export function safeStorage() {
  return {
    get(key: string): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage unavailable */
      }
    },
  };
}

export type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/**
 * `beforeinstallprompt` can fire before React mounts, so it is captured at module load
 * and kept here; components subscribe through `useInstallPrompt`.
 */
let deferredInstall: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
const notifyInstall = () => installListeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    notifyInstall();
  });
}

export function subscribeInstall(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredInstall;
}

/** Shows the browser's native install dialog; returns true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferredInstall;
  if (!e) return false;
  await e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
  deferredInstall = null;
  notifyInstall();
  return choice.outcome === 'accepted';
}
