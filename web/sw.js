// Service Worker: App-Dateien offline verfügbar machen.
// Eigene Dateien: erst Netz, dann Cache (Updates kommen sofort an).
// Bibliotheken (vendor/): erst Cache. Supabase, Edge Functions und Kartenkacheln: nie cachen.
const CACHE = 'manhunt-v1';
const CORE = ['./', 'index.html', 'css/app.css', 'js/main.js', 'manifest.webmanifest', 'icons/icon.svg',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/turf.esm.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, OSM usw. direkt
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))));
});
