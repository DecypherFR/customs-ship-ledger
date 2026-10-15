// Service worker: app shell is cached for offline start; API reads are network-first
// with the last good response served when offline (marked with x-from-cache).
const VERSION = 'ledger-v1';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/api.js', '/js/ui.js', '/js/views.js', '/js/forms.js',
  '/js/admin.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'api').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => {
  if (e.data === 'clear-api-cache') caches.delete('api');
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/api/export')) return;
    e.respondWith(networkFirst(e.request));
    return;
  }
  // App shell: network first so a new deployment reaches every device straight away;
  // the cached copy is used only when offline. SPA routes fall back to index.html.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || cache.match('/index.html');
    }
  })());
});

async function networkFirst(req) {
  const cache = await caches.open('api');
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (!hit) return new Response(JSON.stringify({ error: 'You are offline and this page has not been opened on this device before.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
    const h = new Headers(hit.headers); h.set('x-from-cache', '1');
    return new Response(await hit.blob(), { status: 200, headers: h });
  }
}
