// Geometrie-Helfer für Manhunt.
// Läuft im Browser (Turf über Import-Map), in Node (Tests) und in den Edge Functions (Deno).
// Koordinaten: Objekte {lat, lon}; GeoJSON nutzt wie üblich [lon, lat].
import * as turf from '@turf/turf';

export const EARTH_RADIUS_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function isValidLatLon(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) // 0/0 ist fast immer ein Fehlwert
  );
}

/** Großkreis-Entfernung in Metern. */
export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Peilung von a nach b in Grad (0 = Norden, im Uhrzeigersinn). */
export function bearingDeg(a, b) {
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Punkt in gegebener Entfernung und Richtung. */
export function destination(p, distM, bearing) {
  const d = distM / EARTH_RADIUS_M, b = toRad(bearing), p1 = toRad(p.lat), l1 = toRad(p.lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}

const COMPASS8 = [
  ['Nord', 'N'], ['Nordost', 'NO'], ['Ost', 'O'], ['Südost', 'SO'],
  ['Süd', 'S'], ['Südwest', 'SW'], ['West', 'W'], ['Nordwest', 'NW'],
];
const COMPASS4 = [['Nord', 'N'], ['Ost', 'O'], ['Süd', 'S'], ['West', 'W']];

/** Richtung auf 8 (oder 4) Sektoren gerundet. center = Sektormitte in Grad. */
export function compass(bearing, sectors = 8) {
  const list = sectors === 4 ? COMPASS4 : COMPASS8;
  const size = 360 / list.length;
  const idx = Math.round((((bearing % 360) + 360) % 360) / size) % list.length;
  return { label: list[idx][0], short: list[idx][1], center: idx * size, size };
}

/** Alle Ringe einer Polygon- oder MultiPolygon-Geometrie. */
export function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Feature') return ringsOf(geometry.geometry);
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function geomOf(g) {
  return g && g.type === 'Feature' ? g.geometry : g;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/** Kürzeste Entfernung (m) von einem Punkt zum Rand einer Fläche. Genau genug für Spielfelder bis ~20 km. */
export function distanceToBoundaryM(pt, geometry) {
  const kx = Math.cos(toRad(pt.lat)) * 111320;
  const ky = 110574;
  let min = Infinity;
  for (const ring of ringsOf(geometry)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      const d = segDist(0, 0, (a[0] - pt.lon) * kx, (a[1] - pt.lat) * ky, (b[0] - pt.lon) * kx, (b[1] - pt.lat) * ky);
      if (d < min) min = d;
    }
  }
  return min;
}

export function pointInGeometry(pt, geometry) {
  const g = geomOf(geometry);
  if (!g) return false;
  return turf.booleanPointInPolygon(turf.point([pt.lon, pt.lat]), g);
}

/**
 * Grenzprüfung mit Toleranz.
 * - Außerhalb gilt erst, wenn der Punkt mehr als (Toleranz + min(Genauigkeit, 30 m)) außerhalb liegt.
 * - Sperrzone gilt, wenn der Punkt in der Zone liegt und tiefer als max(0, min(Genauigkeit,30) - Toleranz) drin ist.
 * Liefert edgeDistM: positiv = so weit innerhalb des Spielgebiets, negativ = so weit außerhalb.
 */
export function boundaryStatus(pt, zoneGeometry, exclusions = [], toleranceM = 20) {
  const acc = Math.min(Number.isFinite(pt.accuracy) ? pt.accuracy : 15, 30);
  const zone = geomOf(zoneGeometry);
  if (!zone) return { inside: true, edgeDistM: null, violation: null, exclusion: null };
  const inZone = pointInGeometry(pt, zone);
  const edge = distanceToBoundaryM(pt, zone);
  const edgeDistM = inZone ? edge : -edge;
  let violation = null;
  if (!inZone && edge > toleranceM + acc) violation = 'outside';
  let exclusionName = null;
  if (!violation) {
    for (const ex of exclusions || []) {
      const g = geomOf(ex);
      if (!g) continue;
      if (pointInGeometry(pt, g)) {
        const depth = distanceToBoundaryM(pt, g);
        if (depth >= Math.max(0, acc - toleranceM)) {
          violation = 'exclusion';
          exclusionName = (ex.properties && ex.properties.name) || 'Sperrzone';
          break;
        }
      }
    }
  }
  return { inside: inZone, edgeDistM, violation, exclusion: exclusionName };
}

/** Kreis als GeoJSON-Polygon (Feature) mit Metadaten für die Bearbeitung. */
export function circleFeature(center, radiusM, steps = 72) {
  const f = turf.circle([center.lon, center.lat], radiusM, { steps, units: 'meters' });
  f.properties = { shape: 'circle', center: [center.lon, center.lat], radius_m: Math.round(radiusM) };
  return f;
}

/** Polygon-Feature aus [{lat, lon}, ...] (Ring wird geschlossen). */
export function polygonFeature(points, properties = {}) {
  const ring = points.map((p) => [p.lon, p.lat]);
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
    ring.push([...ring[0]]);
  }
  return { type: 'Feature', properties: { shape: 'polygon', ...properties }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export function areaM2(geometry) {
  const g = geomOf(geometry);
  return g ? turf.area(g) : 0;
}

export function centroidOf(geometry) {
  const g = geomOf(geometry);
  const c = turf.centroid(g).geometry.coordinates;
  return { lat: c[1], lon: c[0] };
}

export function bboxOf(geometry) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(geomOf(geometry));
  return { minLon, minLat, maxLon, maxLat };
}

/** Zufälliger Punkt in der Fläche, optional in einem Abstandsband um "near". */
export function randomPointInGeometry(geometry, rng = Math.random, near = null, minD = 0, maxD = Infinity) {
  const g = geomOf(geometry);
  const b = bboxOf(g);
  for (let i = 0; i < 400; i++) {
    let p;
    if (near && Number.isFinite(maxD) && i < 300) {
      const d = minD + rng() * (maxD - minD);
      p = destination(near, d, rng() * 360);
    } else {
      p = { lat: b.minLat + rng() * (b.maxLat - b.minLat), lon: b.minLon + rng() * (b.maxLon - b.minLon) };
    }
    if (pointInGeometry(p, g)) return p;
  }
  return centroidOf(g);
}

export const AREA_LIMITS = {
  minM2: 20_000, // 0,02 km² (etwa 140 × 140 m)
  warnM2: 5_000_000, // 5 km²
  strongWarnM2: 15_000_000, // 15 km²
};

/** Prüft ein Spielgebiet und liefert Fehler (blockierend) und Warnungen (Hinweis). */
export function validateArea(feature) {
  const errors = [], warnings = [];
  const g = geomOf(feature);
  if (!g || g.type !== 'Polygon' || !g.coordinates?.[0] || g.coordinates[0].length < 4) {
    errors.push('Das Spielgebiet braucht mindestens drei Punkte.');
    return { errors, warnings, areaM2: 0 };
  }
  if (g.coordinates[0].length > 400) errors.push('Die Form hat zu viele Punkte (max. 400).');
  const kinks = turf.kinks(g);
  if (kinks.features.length) errors.push('Die Grenze kreuzt sich selbst. Verschiebe die Punkte, bis sich keine Linien schneiden.');
  const a = turf.area(g);
  if (a < AREA_LIMITS.minM2) errors.push('Das Spielgebiet ist zu klein (mindestens 0,02 km²).');
  if (a > AREA_LIMITS.strongWarnM2) warnings.push(`Sehr großes Gebiet (${fmtKm2(a)}). Zu Fuß findet man sich da kaum. Für 3 bis 10 Spieler passen meist 0,5 bis 3 km².`);
  else if (a > AREA_LIMITS.warnM2) warnings.push(`Großes Gebiet (${fmtKm2(a)}). Für 3 bis 10 Spieler zu Fuß passen meist 0,5 bis 3 km².`);
  return { errors, warnings, areaM2: a };
}

export function fmtKm2(m2) {
  const km2 = m2 / 1e6;
  return `${km2.toLocaleString('de-DE', { maximumFractionDigits: km2 < 10 ? 2 : 1 })} km²`;
}

/** Ring-Sektor (z. B. für Richtungs-Pings): Fläche zwischen rMin und rMax im Winkelbereich. */
export function bandSector(center, rMin, rMax, fromDeg, toDeg2, steps = 24) {
  const outer = [], inner = [];
  for (let i = 0; i <= steps; i++) {
    const b = fromDeg + ((toDeg2 - fromDeg) * i) / steps;
    const o = destination(center, rMax, b);
    outer.push([o.lon, o.lat]);
    if (rMin > 0) {
      const n = destination(center, rMin, b);
      inner.unshift([n.lon, n.lat]);
    }
  }
  const ring = rMin > 0 ? [...outer, ...inner] : [[center.lon, center.lat], ...outer];
  ring.push([...ring[0]]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export { turf };
