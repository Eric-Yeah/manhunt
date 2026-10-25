// Leaflet-Helfer: Karte, Grenzen, Maske außerhalb, Punkte und Beschriftungen.
import { CONFIG } from '../config.js';

const Lf = () => window.L;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function createMap(el, { center = CONFIG.DEFAULT_CENTER, zoom = 15, interactive = true } = {}) {
  const L = Lf();
  const detached = !el.isConnected;
  const map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    dragging: interactive,
    touchZoom: interactive,
    scrollWheelZoom: interactive,
    doubleClickZoom: interactive,
    boxZoom: false,
    keyboard: interactive,
    tapHold: true,
    zoomSnap: 0.25,
  });
  L.tileLayer(CONFIG.TILE_URL, { maxZoom: 19, attribution: CONFIG.TILE_ATTRIBUTION }).addTo(map);
  map.attributionControl.setPrefix(false);
  // Leaflet setzt bei noch nicht eingehängten Elementen "position: relative" – das würde unser CSS überschreiben
  if (detached) el.style.position = '';
  map.setView([center.lat, center.lon], zoom);
  // Leaflet muss die Größe neu messen, sobald der Container sichtbar ist
  requestAnimationFrame(() => map.invalidateSize());
  return map;
}

/** GeoJSON-Geometrie → Leaflet-Koordinaten ([lat, lon]). */
export function geomToLatLngs(g) {
  if (!g) return [];
  if (g.type === 'Feature') return geomToLatLngs(g.geometry);
  if (g.type === 'Polygon') return g.coordinates.map((ring) => ring.map(([x, y]) => [y, x]));
  if (g.type === 'MultiPolygon') return g.coordinates.map((poly) => poly.map((ring) => ring.map(([x, y]) => [y, x])));
  return [];
}

export function polygonLayer(geometry, className, extra = {}) {
  return Lf().polygon(geomToLatLngs(geometry), { className, interactive: false, ...extra });
}

/** Abdunklung außerhalb des Spielgebiets (Weltfläche mit Loch). */
export function outsideMask(geometry) {
  const world = [[85, -540], [85, 540], [-85, 540], [-85, -540]];
  const g = geometry?.type === 'Feature' ? geometry.geometry : geometry;
  if (!g) return null;
  const holes = g.type === 'Polygon' ? [geomToLatLngs(g)[0]] : geomToLatLngs(g).map((p) => p[0]);
  return Lf().polygon([world, ...holes], { className: 'lf-outside', interactive: false });
}

export function dotIcon(kind = '', extra = '') {
  return Lf().divIcon({ className: 'lf-plain', html: `<div class="lf-dot ${kind} ${extra}"><i></i></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

export function dotMarker(p, kind = '', extra = '') {
  return Lf().marker([p.lat, p.lon], { icon: dotIcon(kind, extra), interactive: false, keyboard: false });
}

export function labelMarker(p, text, cls = '', dy = 0) {
  const icon = Lf().divIcon({ className: 'lf-plain', html: `<span class="lf-label ${cls}" style="margin-top:${dy}px">${escapeHtml(text)}</span>`, iconSize: [0, 0] });
  return Lf().marker([p.lat, p.lon], { icon, interactive: false, keyboard: false });
}

export function fitGeometry(map, geometry, padding = [24, 24], opts = {}) {
  const ll = geomToLatLngs(geometry);
  if (!ll.length) return;
  map.fitBounds(Lf().polygon(ll).getBounds(), { padding, animate: false, ...opts });
}

/** Lädt ein klassisches Skript (z. B. Leaflet-Geoman) einmalig nach. */
const loaded = {};
export function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Konnte ${src} nicht laden`));
      document.head.append(s);
    });
  }
  return loaded[src];
}

export function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.append(l);
}

export async function loadGeoman() {
  loadCss('vendor/geoman/leaflet-geoman.css');
  await loadScript('vendor/geoman/leaflet-geoman.min.js');
}
