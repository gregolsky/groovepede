const CACHE = 'groovepede-v2';
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
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
