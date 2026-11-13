// Wiederholung einer Runde: Karte mit Routen, Zeitleiste und Abspielen.
// Wird im Ergebnis-Screen und für gespeicherte Wiederholungen benutzt.
// data: Eintrag aus util/replays.js (area, players, tracks, pings, decoys, started_at, ended_at).
import { h, setChildren } from '../util/dom.js';
import { icon } from '../util/icons.js';
import { mmss } from '../util/format.js';
import { createMap, polygonLayer, dotMarker, labelMarker, fitGeometry } from './map.js';

const PAD_MS = 5000;

/** Baut die Wiederholung in `box`. Gibt { destroy, invalidate } zurück. */
export function mountReplay(box, data) {
  const L = window.L;
  const tracks = (data.tracks || []).filter((t) => t.points?.length);
  const t0 = data.started_at;
  const t1 = Math.max(data.ended_at || t0 + 1, t0 + 1);
  const byId = Object.fromEntries((data.players || []).map((p) => [p.id, p]));
  let tNow = t1, playing = false, raf = 0;

  const mapEl = h('div', { class: 'map' });
  const playBtn = h('button', { class: 'ib', 'aria-label': 'Wiedergabe starten', html: icon('play', 18) });
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: 1000, 'aria-label': 'Zeitpunkt der Wiederholung', class: 'grow' });
  const timeLbl = h('span', { class: 'sub tnum', style: { minWidth: '52px', textAlign: 'right' } }, mmss(t1 - t0));
  setChildren(box,
    h('div', { class: 'replay' }, mapEl),
    h('div', { style: { padding: '10px 14px 12px' } },
      h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Wiederholung'), h('span', { class: 'sub' }, tracks.length ? 'Gejagte orange, Sucher blau' : 'Keine Routen gespeichert')),
      h('div', { class: 'replay-ctl' }, playBtn, slider, timeLbl)));

  const map = createMap(mapEl, { zoom: 14 });
  if (data.area) {
    polygonLayer(data.area, 'lf-bound').addTo(map);
    fitGeometry(map, data.area, [16, 16]);
  }

  // Wer war wann Gejagter oder Sucher? Gefundene Gejagte können später als Sucher weiterlaufen:
  // Punkte nach dem Fundzeitpunkt gehören dann zum Sucher.
  for (const t of tracks) {
    const p = byId[t.player_id];
    const split = p?.start_role === 'hider' && p.role === 'hunter' && p.found_at
      ? t.points.findIndex((q) => q[2] > p.found_at + PAD_MS) : -1;
    const draw = (pts, cls) => pts.length > 1 && L.polyline(pts.map(([x, y]) => [y, x]), { className: `lf-route ${cls}`, interactive: false }).addTo(map);
    if (split > 0) {
      draw(t.points.slice(0, split + 1), 'hider');
      draw(t.points.slice(split), 'hunter');
    } else {
      draw(t.points, p?.role === 'hunter' && p.start_role !== 'hider' ? 'hunter' : 'hider');
    }
  }
  // Fundorte: letzter Punkt vor dem Fundzeitpunkt
  for (const p of (data.players || []).filter((x) => (x.start_role || x.role) === 'hider' && x.found_at)) {
    const tr = tracks.find((t) => t.player_id === p.id);
    const pt = tr && [...tr.points].reverse().find((q) => q[2] <= p.found_at + PAD_MS);
    if (pt) labelMarker({ lat: pt[1], lon: pt[0] }, `✕ ${p.name}`, 'bad').addTo(map);
  }
  const decoys = new Set(data.decoys || []);
  for (const pg of data.pings || []) {
    L.circle([pg.lat, pg.lon], { radius: pg.radius_m, className: `lf-ping old${decoys.has(pg.id) ? ' decoy' : ''}`, interactive: false }).addTo(map);
  }
  const posG = L.layerGroup().addTo(map);

  function drawAt() {
    posG.clearLayers();
    for (const t of tracks) {
      const p = byId[t.player_id];
      let pt = null;
      for (const q of t.points) { if (q[2] <= tNow) pt = q; else break; }
      if (!pt) continue;
      const hunter = p?.role === 'hunter' && (p.start_role !== 'hider' || (p.found_at && pt[2] > p.found_at + PAD_MS));
      const gone = !hunter && p?.found_at && p.found_at <= tNow;
      dotMarker({ lat: pt[1], lon: pt[0] }, `mate ${hunter ? '' : 'hider'}`, gone ? 'found' : '').addTo(posG);
      labelMarker({ lat: pt[1], lon: pt[0] }, p?.name || '?', hunter ? 'ac' : 'hid', -22).addTo(posG);
    }
    slider.value = Math.round(((tNow - t0) / Math.max(1, t1 - t0)) * 1000);
    slider.style.setProperty('--p', `${slider.value / 10}%`);
    timeLbl.textContent = mmss(tNow - t0);
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    playBtn.innerHTML = icon('play', 18);
  }
  function play() {
    if (tNow >= t1) tNow = t0;
    playing = true;
    playBtn.innerHTML = icon('pause', 18);
    const speed = (t1 - t0) / 20000; // ganze Runde in 20 Sekunden
    let last = performance.now();
    const stepFn = (now) => {
      if (!playing) return;
      tNow = Math.min(t1, tNow + (now - last) * speed);
      last = now;
      drawAt();
      if (tNow >= t1) return stop();
      raf = requestAnimationFrame(stepFn);
    };
    raf = requestAnimationFrame(stepFn);
  }

  slider.addEventListener('input', () => {
    stop();
    tNow = t0 + ((t1 - t0) * Number(slider.value)) / 1000;
    drawAt();
  });
  playBtn.addEventListener('click', () => (playing ? stop() : play()));
  drawAt();

  return {
    destroy() {
      stop();
      map.remove();
    },
    invalidate() {
      map.invalidateSize();
    },
  };
}
