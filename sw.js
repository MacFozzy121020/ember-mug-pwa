const CACHE_NAME = 'ember-pwa-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ember-ble.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Fetch fresh copies from network during install
      return Promise.all(
        ASSETS.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => cache.add(url))
        )
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'APPLY_UPDATE' });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./');
      }
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
