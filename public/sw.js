// Service Worker — one.seil.space
// Základní install prompt, bez offline cache (systém vyžaduje připojení k DB)

// Verzi je nutné zvednout při každé změně CSS/JS ve /static/. Do v2 se
// statika servírovala cache-first z nikdy neměněné cache, takže nainstalovaná
// PWA držela první stažené CSS napořád a nové styly se k ní nikdy nedostaly.
const CACHE_NAME = 'one-seil-v2';

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

// Push notifikace
self.addEventListener('push', event => {
  let data = { title: 'Nová objednávka', body: '', url: '/ucetnictvi/objednavky' };
  try { data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/static/img/icon-192.png',
      badge: '/static/img/icon-192.png',
      data: { url: data.url },
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin) && 'focus' in c);
      if (existing) return existing.focus().then(c => c.navigate(url));
      return clients.openWindow(url);
    })
  );
});

// Fetch — network first, fallback na cache pro statiku
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Statické soubory: network first, cache jen jako záloha pro offline.
  // Cache-first tu byla chyba — po nasazení nových stylů PWA dál servírovala
  // ty staré a rozbité rozložení šlo spravit jen přeinstalováním aplikace.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(event.request).then(cached => cached || Response.error()))
    );
    return;
  }

  // Vše ostatní: network only (dynamické stránky, API)
  event.respondWith(fetch(event.request));
});
