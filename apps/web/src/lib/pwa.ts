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

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' });
  });
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
