const CACHE = 'groovepede-v19';
const ASSETS = [
  '/',
  '/index.html',
  '/faq.html',
  '/manifest.json',
  '/favicon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only handle same-origin requests; let cross-origin (APIs) go straight to network.
  if (url.origin !== self.location.origin) return;
  // Network-first for same-origin assets so deploys take effect immediately;
  // fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
