const CACHE_NAME = 'dp-athlete-v193'; // v193: discovery week + stale week refresh
const APP_SHELL = [
  '/index.html', '/styles.css?v=150', '/desktop.css?v=7', '/config.js',
  '/manifest.json', '/icon-192.png?v=3', '/icon-512.png?v=3', '/apple-touch-icon.png?v=3',
  '/js/01-core.js?v=123',
  '/js/02-login-goals.js?v=113',
  '/js/03-nav-nudges.js?v=114',
  '/js/04-checkin.js?v=96',
  '/js/05-handbook.js?v=85',
  '/js/06-nutrition.js?v=91',
  '/js/07-progress.js?v=89',
  '/js/strava-match.js?v=6',
  '/js/08-training-interval-rest.js?v=1',
  '/js/08-training-muscle-coverage.js?v=1',
  '/js/08-training-focus.js?v=1',
  '/js/08-training.js?v=137',
  '/js/09-logging.js?v=121',
  '/accessibility.js?v=1',
  '/js/10-boot.js?v=110',
  '/login.js?v=49', '/icons.css?v=4',
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

const DP_OFFLINE_DB_NAME = 'dp-athlete-portal';
const DP_OFFLINE_DB_VERSION = 2;
const DP_QUEUE_STORE = 'queued_writes';
const DP_STATE_STORE = 'app_state';
const DP_STATE_QUEUE_STORE = 'state_writes';

function openOfflineDb() {
  return new Promise(resolve => {
    let request;
    try { request = indexedDB.open(DP_OFFLINE_DB_NAME, DP_OFFLINE_DB_VERSION); }
    catch (error) { resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DP_QUEUE_STORE)) {
        const queue = db.createObjectStore(DP_QUEUE_STORE, { keyPath: 'id' });
        queue.createIndex('bucket', 'bucket', { unique: false });
      }
      if (!db.objectStoreNames.contains(DP_STATE_STORE)) db.createObjectStore(DP_STATE_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(DP_STATE_QUEUE_STORE)) {
        const stateQueue = db.createObjectStore(DP_STATE_QUEUE_STORE, { keyPath: 'id' });
        stateQueue.createIndex('code', 'code', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function idbTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
  });
}

async function notifyQueueFlushed(count, trigger) {
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  windows.forEach(client => client.postMessage({ type: 'dp-queue-flushed', count, trigger }));
}

function queuedWriteBelongsToAthlete(item, athleteCode) {
  if (String(item && item.bucket || '').toUpperCase() === athleteCode) return true;
  return item && item.bucket === '_unknown' &&
    String(item.payload && item.payload.athleteCode || '').toUpperCase() === athleteCode;
}

// The service worker drains the same outbox as the page, on activate and on
// background sync, but it cannot call into 01-core.js. So the Strava trimming
// is duplicated here rather than imported. Without it this path keeps posting
// the untrimmed logs blob that api/write.js refuses with a 413, and the queue
// entry survives every drain: the page can trim its copy all it likes while
// the worker quietly re-fails behind it.
//
// tests/strava-log-size.test.js asserts this list stays identical to
// STRAVA_MATCH_ACTIVITY_FIELDS in 01-core.js.
const STRAVA_MATCH_ACTIVITY_FIELDS = ['id', 'name', 'type', 'sport_type', 'distance', 'moving_time', 'elapsed_time', 'start_date', 'start_date_local', 'suffer_score', 'relative_effort'];
function pruneStravaMatchPayloads(logsObject) {
  if (!logsObject || typeof logsObject !== 'object') return false;
  let changed = false;
  for (const sessionId of Object.keys(logsObject)) {
    const entry = logsObject[sessionId];
    if (!entry || typeof entry !== 'object') continue;
    const match = entry.__stravaMatch;
    if (!match || typeof match !== 'object' || !match.activity) continue;
    const slim = {};
    for (const field of STRAVA_MATCH_ACTIVITY_FIELDS) {
      if (match.activity[field] !== undefined) slim[field] = match.activity[field];
    }
    if (JSON.stringify(slim) === JSON.stringify(match.activity)) continue;
    match.activity = slim;
    changed = true;
  }
  return changed;
}

async function flushOfflineQueue(trigger) {
  const db = await openOfflineDb();
  if (!db) return 0;
  const tokenRow = await idbRequest(db.transaction(DP_STATE_STORE, 'readonly').objectStore(DP_STATE_STORE).get('dp_auth_token'));
  const token = tokenRow && tokenRow.value;
  const codeRow = await idbRequest(db.transaction(DP_STATE_STORE, 'readonly').objectStore(DP_STATE_STORE).get('dp_auth_athlete_code'));
  const athleteCode = String(codeRow && codeRow.value || '').toUpperCase();
  if (!token || !athleteCode) return 0;
  const queued = await idbRequest(db.transaction(DP_QUEUE_STORE, 'readonly').objectStore(DP_QUEUE_STORE).getAll());
  const stateQueued = await idbRequest(db.transaction(DP_STATE_QUEUE_STORE, 'readonly').objectStore(DP_STATE_QUEUE_STORE).getAll());
  const currentCoachWrites = queued.filter(item => queuedWriteBelongsToAthlete(item, athleteCode));
  const currentStateWrites = stateQueued.filter(item => String(item.code || '').toUpperCase() === athleteCode);
  let synced = 0;
  const coachSuccessIds = new Set();
  for (const item of currentCoachWrites) {
    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ targetUrl: item.url, payload: item.payload }),
      });
      let data = {};
      try { data = await response.clone().json(); } catch (error) {}
      if (!response.ok || data.ok === false) continue;
      coachSuccessIds.add(item.id);
    } catch (error) {}
  }
  async function writePortalState(key, value) {
    try {
      const response = await fetch('/api/portal-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'state-write', key, value }),
      });
      let data = {};
      try { data = await response.clone().json(); } catch (error) {}
      return response.ok && data.ok !== false;
    } catch (error) { return false; }
  }
  // The cloud queue mirror and IndexedDB must advance together. If the mirror
  // cannot be cleared, keep successful local rows: replay is idempotent by
  // clientWriteId, while deleting first could resurrect stale cloud entries.
  const mirrorItem = currentStateWrites.find(item => item.key === 'pending_writes');
  if (coachSuccessIds.size || mirrorItem) {
    const remaining = currentCoachWrites.filter(item => !coachSuccessIds.has(item.id)).map(item => {
      const copy = { ...item }; delete copy.bucket; return copy;
    });
    if (await writePortalState('pending_writes', remaining)) {
      const tx = db.transaction([DP_QUEUE_STORE, DP_STATE_QUEUE_STORE], 'readwrite');
      coachSuccessIds.forEach(id => tx.objectStore(DP_QUEUE_STORE).delete(id));
      if (mirrorItem) tx.objectStore(DP_STATE_QUEUE_STORE).delete(mirrorItem.id);
      await idbTransaction(tx);
      synced += coachSuccessIds.size + (mirrorItem ? 1 : 0);
    }
  }
  for (const item of currentStateWrites.filter(row => row.key !== 'pending_writes')) {
    if (item.key === 'logs') pruneStravaMatchPayloads(item.value);
    if (!await writePortalState(item.key, item.value)) continue;
    const tx = db.transaction(DP_STATE_QUEUE_STORE, 'readwrite');
    tx.objectStore(DP_STATE_QUEUE_STORE).delete(item.id);
    await idbTransaction(tx);
    synced++;
  }
  if (synced) await notifyQueueFlushed(synced, trigger);
  return synced;
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
    await flushOfflineQueue('sync');
  })());
});

self.addEventListener('sync', event => {
  if (event.tag === 'dp-flush-queue') event.waitUntil(flushOfflineQueue('sync'));
});

self.addEventListener('periodicsync', event => {
  if (event.tag === 'dp-flush-queue') event.waitUntil(flushOfflineQueue('sync'));
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
