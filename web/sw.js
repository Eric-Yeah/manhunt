// Service Worker: App-Dateien offline verfügbar machen.
// Eigene Dateien: erst Netz, dann Cache (Updates kommen sofort an).
// Bibliotheken (vendor/): erst Cache. Supabase, Edge Functions und Kartenkacheln: nie cachen.
const CACHE = 'manhunt-v2';
// Alle Module stehen hier, damit die App nach dem ersten Besuch auch offline startet
// (tests/core.test.js prüft, dass keine Datei fehlt).
const CORE = [
  './',
  'index.html',
  'css/app.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/turf.esm.js',
  'vendor/supabase.esm.js',
  'vendor/qrcode.esm.js',
  'vendor/jsqr.esm.js',
  'vendor/geoman/leaflet-geoman.min.js',
  'vendor/geoman/leaflet-geoman.css',
  'js/app.js',
  'js/backend/base.js',
  'js/backend/demo.js',
  'js/backend/supabase.js',
  'js/config.js',
  'js/core/engine.js',
  'js/core/geo.js',
  'js/core/kalman.js',
  'js/core/ping.js',
  'js/core/traccar.js',
  'js/core/zone.js',
  'js/location/index.js',
  'js/main.js',
  'js/ui/chat.js',
  'js/ui/components.js',
  'js/ui/help.js',
  'js/ui/map.js',
  'js/ui/scanner.js',
  'js/ui/screens/area.js',
  'js/ui/screens/play.js',
  'js/ui/screens/result.js',
  'js/ui/screens/settings.js',
  'js/ui/screens/start.js',
  'js/ui/screens/waiting.js',
  'js/util/dom.js',
  'js/util/format.js',
  'js/util/icons.js',
  'js/util/storage.js'];

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
  // Netz zuerst, bei schlechtem Empfang nach 4 s der Cache.
  const fromCache = () => caches.match(req).then((hit) => hit || caches.match('index.html'));
  const net = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(fromCache()), 4000));
  e.respondWith(Promise.race([net, timeout]).catch(fromCache));
});
