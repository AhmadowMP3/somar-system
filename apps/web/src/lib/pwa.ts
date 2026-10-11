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

/** How often an open app asks the server whether a newer version was published. */
const UPDATE_CHECK_MS = 5 * 60_000;
/** A pending update waits until the user has not touched the screen for this long. */
const IDLE_BEFORE_RELOAD_MS = 20_000;

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
 * for a new version every few minutes and whenever the app comes back to the screen; the new service
 * worker takes over at once (skipWaiting + clientsClaim in sw.ts) and the page then reloads itself at
 * a safe moment — while the app is in the background, on the next page change, or after a short idle
 * time with no field being typed in and no dialog open.
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
      })
      .catch(() => undefined);
  });

  for (const type of ['pointerdown', 'keydown', 'input', 'scroll'] as const) {
    window.addEventListener(type, () => (lastInteraction = Date.now()), { passive: true, capture: true });
  }
  setInterval(() => reloadIfSafe(), 5_000);
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
