// Service Worker — one.seil.space
// Základní install prompt, bez offline cache (systém vyžaduje připojení k DB)

const CACHE_NAME = 'one-seil-v1';

// Při instalaci — předcache jen statické assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/static/css/variables.css', '/static/css/layout.css', '/static/css/components.css'])
    )
  );
  self.skipWaiting();
});

// Aktivace — smaž staré cache
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, fallback na cache pro statiku
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Statické soubory: cache first
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Vše ostatní: network only (dynamické stránky, API)
  event.respondWith(fetch(event.request));
});
