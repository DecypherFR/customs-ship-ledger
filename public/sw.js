// Service worker: caches the app shell so the PWA starts offline.
// Data is not cached here: the data layer (js/api.js) keeps its own per-user cache in IndexedDB,
// and requests to Supabase (another origin) pass straight through.
const VERSION = 'ledger-v4';
const SHELL = ['./', './index.html', './config.js', './css/app.css', './js/app.js', './js/api.js', './js/ui.js', './js/views.js', './js/forms.js',
  './js/admin.js', './vendor/supabase-2.117.2.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/customs-logo.png', './icons/favicon.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // Network first so a new deployment reaches every device straight away; cached copy when offline.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || cache.match('./index.html');
    }
  })());
});
