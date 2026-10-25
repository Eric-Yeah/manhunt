// Schrumpfende Zone: Stufen werden beim Einstellen einmal berechnet (Vorschau für den Host)
// und mit dem Spiel gespeichert. Der Server schaltet nur nach Zeit auf die nächste Stufe.
import { turf, areaM2, fmtKm2 } from './geo.js';

export const MIN_STAGE_M2 = 10_000; // kleiner wird die Zone nicht (0,01 km²)

/**
 * @param {object} area  GeoJSON-Feature (Polygon), properties.shape = 'circle' | 'polygon'
 * @param {object} s     Einstellungen (shrink_enabled, shrink_every_s, shrink_percent, duration_s)
 * @returns {{stages: {at_s:number, geometry:object, area_m2:number}[], warnings: string[]}}
 */
export function computeZoneStages(area, s) {
  const stages = [{ at_s: 0, geometry: area.geometry, area_m2: Math.round(areaM2(area.geometry)) }];
  const warnings = [];
  if (!s.shrink_enabled) return { stages, warnings };
  const every = Math.max(60, s.shrink_every_s | 0);
  const factor = 1 - Math.min(0.9, Math.max(0.01, (s.shrink_percent || 10) / 100));
  const a0 = areaM2(area.geometry);
  const isCircle = area.properties?.shape === 'circle' && Array.isArray(area.properties.center);
  let lastBuffer = 0;

  for (let k = 1; k * every < s.duration_s; k++) {
    const target = a0 * factor ** k;
    if (target < MIN_STAGE_M2) {
      warnings.push(`Ab Stufe ${k} wäre die Zone kleiner als ${fmtKm2(MIN_STAGE_M2)}. Sie schrumpft deshalb nur bis Stufe ${k - 1}.`);
      break;
    }
    let geometry;
    if (isCircle) {
      const r = area.properties.radius_m * Math.sqrt(factor ** k);
      geometry = turf.circle(area.properties.center, r, { steps: 72, units: 'meters' }).geometry;
    } else {
      const res = shrinkPolygon(area, target, lastBuffer);
      if (!res) {
        warnings.push(`In Stufe ${k} verschwindet die Form komplett. Weniger stark schrumpfen oder eine breitere Form wählen.`);
        break;
      }
      lastBuffer = res.distance;
      geometry = res.geometry;
      if (res.parts > 1) {
        warnings.push(`In Stufe ${k} zerfällt die Form in ${res.parts} Teile. Es bleibt nur das größte Stück. Eine kompaktere Form vermeidet das.`);
      }
    }
    stages.push({ at_s: k * every, geometry, area_m2: Math.round(areaM2(geometry)) });
  }
  return { stages, warnings };
}

/** Negativer Puffer per Binärsuche, bis die Fläche ungefähr "target" erreicht. */
function shrinkPolygon(feature, target, minD) {
  const a0 = areaM2(feature.geometry);
  let lo = minD, hi = Math.sqrt(a0 / Math.PI) * 1.2;
  let best = null, bestErr = Infinity;
  for (let i = 0; i < 22; i++) {
    const d = (lo + hi) / 2;
    const buf = safeBuffer(feature, -d);
    const a = buf ? areaM2(buf.geometry) : 0;
    if (a <= 0) { hi = d; continue; }
    const err = Math.abs(a - target);
    if (err < bestErr) { bestErr = err; best = { geometry: buf.geometry, d }; }
    if (a > target) lo = d; else hi = d;
    if (err / target < 0.01) break;
  }
  if (!best || !best.geometry) return null;
  let geometry = best.geometry;
  let parts = 1;
  if (geometry.type === 'MultiPolygon') {
    parts = geometry.coordinates.length;
    let maxA = -1, keep = null;
    for (const coords of geometry.coordinates) {
      const g = { type: 'Polygon', coordinates: coords };
      const a = areaM2(g);
      if (a > maxA) { maxA = a; keep = g; }
    }
    geometry = keep;
  }
  if (areaM2(geometry) < MIN_STAGE_M2 / 2) return null;
  return { geometry: roundGeometry(geometry), distance: best.d, parts };
}

function safeBuffer(feature, d) {
  try {
    const r = turf.buffer(feature, d, { units: 'meters', steps: 8 });
    if (!r || !r.geometry || !r.geometry.coordinates?.length) return null;
    return r;
  } catch {
    return null;
  }
}

/** Koordinaten auf ~1 cm runden, damit die gespeicherte Geometrie klein bleibt. */
export function roundGeometry(g) {
  const r = (c) => [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7];
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.coordinates.map((ring) => ring.map(r)) };
  if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map((ring) => ring.map(r))) };
  return g;
}

/** Aktuelle Stufe zu einem Zeitpunkt (ms seit Jagdbeginn). */
export function stageIndexAt(stages, msSinceHuntStart) {
  let idx = 0;
  if (!Array.isArray(stages)) return 0;
  for (let i = 1; i < stages.length; i++) {
    if (msSinceHuntStart >= stages[i].at_s * 1000) idx = i;
  }
  return idx;
}
