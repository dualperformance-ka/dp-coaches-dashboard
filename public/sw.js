const CACHE_NAME = 'dp-athlete-v122'; // v122: muscle-group coverage, swap tracking and variation-churn guidance
const APP_SHELL = [
  '/index.html', '/styles.css?v=104', '/desktop.css?v=4', '/config.js',
  '/manifest.json', '/icon-192.png?v=3', '/icon-512.png?v=3', '/apple-touch-icon.png?v=3',
  '/js/01-core.js?v=99',
  '/js/02-login-goals.js?v=95',
  '/js/03-nav-nudges.js?v=93',
  '/js/04-checkin.js?v=86',
  '/js/05-handbook.js?v=82',
  '/js/06-nutrition.js?v=86',
  '/js/07-progress.js?v=86',
  '/js/strava-match.js?v=4',
  '/js/08-training.js?v=108',
  '/js/09-logging.js?v=102',
  '/accessibility.js?v=1',
  '/js/10-boot.js?v=92',
  '/login.js?v=47', '/icons.css?v=3',
  '/dual_performance_one_line_filled_logo_black_preview.png',
  '/dp_baby_blue_transparent_512x512.png'
];

self.addEventListener('install', event => {
  // Cache files individually: one missing file must never block the install
  // (cache.addAll is all-or-nothing and a single 404 bricks the service worker).
  event.waitUntil(caches.open(CACHE_NAME).then(cache =>
    Promise.allSettled(APP_SHELL.map(url => cache.add(url)))
  ));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Versioned JS/CSS: CACHE-FIRST. Every changed shell file gets a new ?v=
  // value in index.html, so a deploy naturally misses the old cache and fetches
  // the new file. Installed PWAs can therefore launch without waiting for a
  // network round trip while never caching API or athlete-data responses.
  const isVersionedShellAsset = /\.(?:css|js)$/.test(url.pathname) && url.searchParams.has('v');
  if (isVersionedShellAsset) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    })));
    return;
  }

  // Installed-PWA navigations: return the cached shell immediately and refresh
  // it in the background. The service-worker update check plus versioned asset
  // URLs still advances deployments safely, while weak connections no longer
  // hold a home-screen launch behind an HTML round trip.
  if (request.mode === 'navigate' || url.pathname === '/') {
    const cacheKey = '/index.html';
    const networkResponse = fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
      }
      return response;
    });
    event.waitUntil(networkResponse.then(() => undefined).catch(() => undefined));
    event.respondWith(caches.match(cacheKey).then(cached => cached || networkResponse));
    return;
  }

  // Unversioned runtime files (notably config.js): NETWORK-FIRST so runtime
  // configuration changes remain immediate.
  const isShell = /\.(?:html|css|js)$/.test(url.pathname);

  if (isShell) {
    const cacheKey = request;
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
        }
        return response;
      }).catch(() => caches.match(cacheKey))
    );
    return;
  }

  // Everything else (images, fonts, icons): cache-first — they're versioned
  // or immutable, so serving from cache is fine and fast.
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});

// ── PUSH REMINDERS ───────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'Dual Performance';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/dp_baby_blue_transparent_512x512.png',
    badge: '/dp_baby_blue_transparent_512x512.png',
    tag: data.tag || 'dp-reminder',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ('focus' in client) { client.navigate(url); return client.focus(); }
    }
    return clients.openWindow(url);
  }));
});
