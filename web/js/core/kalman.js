// Einfacher Kalman-Filter für GPS-Positionen (ein gemeinsamer Varianzwert für beide Achsen).
// Glättet Rauschen und verwirft unplausible Sprünge, ohne echte Bewegung zu verschlucken.
import { distanceM } from './geo.js';

export const KALMAN_DEFAULTS = {
  processNoise: 4, // m/s: wie schnell sich die Unsicherheit ohne Messung vergrößert (zu Fuß/rennend)
  maxSpeed: 25, // m/s: schnellere Sprünge gelten als GPS-Ausreißer
  resetAfterRejects: 3, // nach so vielen verworfenen Messungen in Folge neu beginnen
  resetAfterGapS: 180, // nach längerer Pause neu beginnen
};

/**
 * @param {object|null} state {lat, lon, var, at, rejects}
 * @param {object} m Messung {lat, lon, accuracy, at} (at in ms)
 * @returns {{state: object, accepted: boolean, reason?: string}}
 */
export function kalmanUpdate(state, m, opts = {}) {
  const o = { ...KALMAN_DEFAULTS, ...opts };
  const acc = Math.max(3, Number.isFinite(m.accuracy) ? m.accuracy : 30);
  const fresh = { lat: m.lat, lon: m.lon, var: acc * acc, at: m.at, rejects: 0 };
  if (!state || !Number.isFinite(state.lat) || !Number.isFinite(state.at)) return { state: fresh, accepted: true };

  const dt = (m.at - state.at) / 1000;
  if (dt < 0) return { state, accepted: false, reason: 'veraltet' };
  if (dt > o.resetAfterGapS) return { state: fresh, accepted: true };

  const predVar = state.var + Math.max(dt, 0.5) * o.processNoise * o.processNoise;
  const d = distanceM(state, m);
  // Abstand, den man realistisch erklären kann: Messunsicherheit + maximale Geschwindigkeit
  const explainable = 2 * Math.sqrt(predVar) + 2 * acc + o.maxSpeed * Math.max(dt, 1);
  if (d > explainable) {
    const rejects = (state.rejects || 0) + 1;
    if (rejects >= o.resetAfterRejects) return { state: fresh, accepted: true, reason: 'neu gestartet' };
    return { state: { ...state, rejects }, accepted: false, reason: 'Ausreißer' };
  }
  const k = predVar / (predVar + acc * acc);
  return {
    accepted: true,
    state: {
      lat: state.lat + k * (m.lat - state.lat),
      lon: state.lon + k * (m.lon - state.lon),
      var: (1 - k) * predVar,
      at: m.at,
      rejects: 0,
    },
  };
}
