/* ============================================================
   DP Coaches Dashboard - Service Worker
   Vanilla SW, no build step, safe for Vercel static hosting.

   Strategy summary:
   - App shell (index.html)          : network-first, cache fallback
   - Same-origin static assets       : stale-while-revalidate
   - Google Fonts files              : cache-first (immutable)
   - CDN scripts (jsdelivr)          : stale-while-revalidate
   - /api/* and *.supabase.co        : NETWORK ONLY, never cached
     (coach/athlete data is authenticated + dynamic - caching it
      would risk showing stale or cross-coach data offline)
   ============================================================ */

const VERSION = 'dp-coaches-v5';
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const FONT_CACHE = `${VERSION}-fonts`;

// Everything needed for first paint of the shell.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/dashboard-redesign.js',
  '/dashboard-redesign.css',
  '/dashboard-detail-cleanup.css',
  '/dashboard-mobile.css',
  '/dashboard-mobilenav.js',
  '/manifest.webmanifest',
  '/dp-mark-blue.png',
  '/dp-mark-light.png',
  '/dp-mark-dark.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Hosts whose responses must never be cached (dynamic / authenticated).
const NEVER_CACHE_HOSTS = ['supabase.co', 'supabase.in'];

// Cross-origin hosts we DO allow runtime caching for.
const FONT_HOSTS = ['fonts.gstatic.com'];
const CDN_HOSTS = ['fonts.googleapis.com', 'cdn.jsdelivr.net'];

/* ---------- install: precache the shell ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll is atomic; if one asset 404s the install fails,
      // so fetch individually and tolerate misses.
      Promise.allSettled(
        SHELL_ASSETS.map((url) =>
          fetch(url, { cache: 'no-cache' }).then((res) => {
            if (res.ok) return cache.put(url, res);
          })
        )
      )
    )
  );
  // Do NOT skipWaiting here - app.js triggers it after the user
  // accepts the update, so we never swap SW mid-session silently.
});

/* ---------- activate: drop old caches ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(VERSION))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ---------- messages from the page ---------- */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ---------- fetch routing ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever touch GET requests. POST/PATCH etc. pass straight through.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Never intercept authenticated/dynamic data.
  //    /api/* on our origin, or anything on Supabase.
  if (
    (url.origin === self.location.origin && url.pathname.startsWith('/api/')) ||
    NEVER_CACHE_HOSTS.some((h) => url.hostname.endsWith(h))
  ) {
    // Network-first with no cache fallback: fresh or a clear offline error.
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(
            JSON.stringify({ error: 'offline', message: 'No network connection.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
    return;
  }

  // 2. Navigations: network-first, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() =>
          caches.match('/index.html').then(
            (cached) =>
              cached ||
              new Response('Offline and no cached shell available.', {
                status: 503,
                headers: { 'Content-Type': 'text/plain' }
              })
          )
        )
    );
    return;
  }

  // 3. Font files: cache-first (versioned + immutable by Google).
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // 4. Same-origin static assets + allowed CDNs: stale-while-revalidate.
  const isOwnStatic = url.origin === self.location.origin;
  const isAllowedCdn = CDN_HOSTS.includes(url.hostname);
  if (isOwnStatic || isAllowedCdn) {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // 5. Anything else (unknown third parties): don't intercept at all.
});

/* ---------- strategies ---------- */
function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        })
    )
  );
}

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached); // offline: fall back to cache if we have it
      return cached || network;
    })
  );
}
