// ── Bump CACHE_VER with every deploy so stale caches are wiped ──
const CACHE_VER = 'baseline-v318';

const PRECACHE = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.svg',
];

// Install: pre-cache static assets, take over immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VER)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete every old cache, claim all tabs
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // External APIs and Supabase: always pass through, never cache
  if (url.hostname !== location.hostname) {
    e.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  // HTML (index.html, root, any .html): network-first so refreshes always load latest
  const acceptsHTML = req.headers.get('Accept')?.includes('text/html');
  const isHTML = acceptsHTML || url.pathname.endsWith('.html') || url.pathname === '/';
  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) caches.open(CACHE_VER).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Versioned assets (app.js?v=309, style.css?v=309): cache-first - safe because version param changes with each deploy
  if (url.search.includes('v=')) {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res.ok) caches.open(CACHE_VER).then(c => c.put(req, res.clone()));
          return res;
        });
      })
    );
    return;
  }

  // Everything else (icons, manifest, fonts): network-first, cache as fallback
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) caches.open(CACHE_VER).then(c => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
