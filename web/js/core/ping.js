// Ping-Erzeugung: aus der echten (geglätteten) Position wird nur das, was die Sucher sehen dürfen.
// Die echte Position verlässt diese Funktion nie unverändert, außer im Modus "exakter Punkt".
import { destination, distanceM, bearingDeg, compass } from './geo.js';

export const PING_MODES = ['exact', 'circle', 'direction'];

/** Entfernung auf grobe Stufen runden, damit man aus Richtung + Entfernung nicht zurückrechnen kann. */
export function roundDistance(d, coarse = false) {
  if (coarse) {
    if (d < 200) return 100;
    if (d < 2000) return Math.round(d / 200) * 200;
    return Math.round(d / 500) * 500;
  }
  if (d < 100) return 50;
  if (d < 500) return Math.round(d / 50) * 50;
  if (d < 2000) return Math.round(d / 100) * 100;
  return Math.round(d / 250) * 250;
}

/**
 * Mittelpunkt für den ungefähren Kreis: zufällig versetzt, sodass die echte Position
 * irgendwo im Kreis liegt, aber nicht in der Mitte (Abstand 25 bis 85 % des Radius,
 * flächengleich verteilt).
 */
export function offsetCircleCenter(target, radiusM, rng = Math.random) {
  const a = 0.25, b = 0.85;
  const d = radiusM * Math.sqrt(rng() * (b * b - a * a) + a * a);
  return destination(target, d, rng() * 360);
}

/**
 * Baut den sichtbaren Teil eines Pings.
 * @param {'exact'|'circle'|'direction'} mode
 * @param {{lat:number, lon:number}} target  (geglättete) Position des Gejagten bzw. Täuschungsort
 * @param {object} o  { radiusM, ref:{lat,lon}|null, refIsCenter:boolean, double:boolean }
 */
export function buildPing(mode, target, o = {}, rng = Math.random) {
  const radius = o.radiusM || 250;
  if (mode === 'exact') {
    if (o.double) {
      const r = 100;
      const c = offsetCircleCenter(target, r, rng);
      return { mode: 'circle', lat: c.lat, lon: c.lon, radius_m: r };
    }
    return { mode: 'exact', lat: round6(target.lat), lon: round6(target.lon), radius_m: null };
  }
  if (mode === 'circle') {
    const r = o.double ? radius * 2 : radius;
    const c = offsetCircleCenter(target, r, rng);
    return { mode: 'circle', lat: round6(c.lat), lon: round6(c.lon), radius_m: r };
  }
  if (mode === 'direction') {
    const ref = o.ref;
    if (!ref) throw new Error('Richtungs-Ping braucht einen Bezugspunkt');
    const dist = distanceM(ref, target);
    const sectors = o.double ? 4 : 8;
    const dir = compass(bearingDeg(ref, target), sectors);
    return {
      mode: 'direction',
      ref_lat: round6(ref.lat),
      ref_lon: round6(ref.lon),
      ref_is_center: !!o.refIsCenter,
      bearing_deg: dir.center,
      sector_deg: dir.size,
      distance_m: roundDistance(dist, !!o.double),
      dir_label: dir.label,
    };
  }
  throw new Error(`Unbekannter Ping-Modus: ${mode}`);
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** Text für die Anzeige, z. B. "Nordost, ca. 400 m". */
export function directionText(p) {
  if (!p || p.mode !== 'direction') return '';
  const dist = p.distance_m <= 50 ? 'unter 100 m' : `ca. ${p.distance_m.toLocaleString('de-DE')} m`;
  return `${p.dir_label}, ${dist}`;
}
