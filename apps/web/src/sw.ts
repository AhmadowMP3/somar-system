/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';
import { t } from './i18n/ar';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// App shell only: hashed JS/CSS/fonts/icons. API and Supabase responses are never cached.
precacheAndRoute(self.__WB_MANIFEST);

// index.html is fetched from the network first (it carries the runtime config), with the last copy as fallback.
registerRoute(
  new NavigationRoute(new NetworkFirst({ cacheName: 'app-pages', networkTimeoutSeconds: 4 }), {
    denylist: [/^\/api\//],
  }),
);

type PushData = { title?: string; body?: string; url?: string; tag?: string };

self.addEventListener('push', (event) => {
  let data: PushData = {};
  try {
    data = (event.data?.json() ?? {}) as PushData;
  } catch {
    data = { body: event.data?.text() };
  }
  const title = data.title || t.appShortName;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      dir: 'rtl',
      lang: 'ar',
      tag: data.tag,
      data: { url: data.url || '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data as { url?: string } | null)?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await (client as WindowClient).navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
