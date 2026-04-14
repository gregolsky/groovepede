const CACHE = 'groovepede-v11';
const ASSETS = [
  '/groovepede/',
  '/groovepede/index.html',
  '/groovepede/manifest.json',
  '/groovepede/favicon.png',
  '/groovepede/js/config.js',
  '/groovepede/js/auth.js',
  '/groovepede/js/storage.js',
  '/groovepede/js/api.js',
  '/groovepede/js/render.js',
  '/groovepede/js/app.js',
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
  // Network-first for same-origin assets so deploys take effect immediately;
  // fall back to cache when offline.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(fetch(e.request));
  }
});
