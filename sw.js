const CACHE_NAME = 'callzap-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/login.html',
  '/signup.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
