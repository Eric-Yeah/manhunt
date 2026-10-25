// Screen 7: Ergebnis mit Routen-Wiederholung und Revanche.
import { h, busy, setChildren } from '../../util/dom.js';
import { icon } from '../../util/icons.js';
import { mmss, ts, dateTime } from '../../util/format.js';
import { save } from '../../util/storage.js';
import { createMap, polygonLayer, dotMarker, labelMarker, fitGeometry } from '../map.js';
import { avatar } from '../components.js';

export function resultScreen(ctx) {
  const L = window.L;
  const el = h('div', { class: 'scr' });
  const replayBox = h('div', { class: 'card', style: { padding: '0', overflow: 'hidden' } });
  let map = null, replay = null, playing = false, raf = 0, tNow = 0, t0 = 0, t1 = 0;
  let posG = null, slider = null, timeLbl = null, playBtn = null;
  let built = false;

  function summary(snap) {
    const g = snap.game;
    const hiders = snap.players.filter((p) => p.role === 'hider');
    return {
      winner: g.winner,
      reason: g.end_reason,
      durationMs: Math.max(0, ts(g.ended_at) - ts(g.started_at)),
      found: hiders.filter((p) => p.status === 'found' || p.status === 'eliminated').length,
      hiders: hiders.length,
      pings: Math.max(0, ...snap.pings.map((p) => p.seq)),
    };
  }

  function rememberRound(snap) {
    const s = summary(snap);
    save('lastRound', {
      title: snap.game.area?.properties?.name || `Runde mit ${snap.players.length} Spielern`,
      winner: s.winner, duration_ms: s.durationMs, players: snap.players.filter((p) => p.status !== 'left').length,
      at: ts(snap.game.ended_at) || Date.now(),
    });
  }

  async function buildReplay(snap) {
    try {
      replay = await ctx.backend.getReplay();
    } catch (e) {
      setChildren(replayBox, h('p', { class: 'sub', style: { padding: '16px' } }, `Wiederholung nicht verfügbar: ${e.message}`));
      return;
    }
    const tracks = (replay.tracks || []).filter((t) => t.points?.length);
    t0 = ts(replay.started_at) || ts(snap.game.started_at);
    t1 = ts(replay.ended_at) || ts(snap.game.ended_at);
    tNow = t1;
    const mapEl = h('div', { class: 'map' });
    playBtn = h('button', { class: 'ib', 'aria-label': 'Wiedergabe starten', html: icon('play', 18) });
    slider = h('input', { type: 'range', min: 0, max: 1000, value: 1000, 'aria-label': 'Zeitpunkt der Wiederholung', class: 'grow' });
    timeLbl = h('span', { class: 'sub tnum', style: { minWidth: '52px', textAlign: 'right' } }, mmss(t1 - t0));
    setChildren(replayBox,
      h('div', { class: 'replay' }, mapEl),
      h('div', { style: { padding: '10px 14px 12px' } },
        h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Wiederholung'), h('span', { class: 'sub' }, tracks.length ? 'Gejagte orange, Sucher blau' : 'Keine Routen gespeichert')),
        h('div', { class: 'replay-ctl' }, playBtn, slider, timeLbl)));
    map = createMap(mapEl, { zoom: 14 });
    const g = snap.game;
    if (g.area) {
      polygonLayer(g.area.geometry, 'lf-bound').addTo(map);
      fitGeometry(map, g.area.geometry, [16, 16]);
    }
    const nameOf = (id) => snap.players.find((p) => p.id === id);
    for (const t of tracks) {
      const p = nameOf(t.player_id);
      L.polyline(t.points.map(([x, y]) => [y, x]), { className: `lf-route ${p?.role === 'hunter' ? 'hunter' : 'hider'}`, interactive: false }).addTo(map);
    }
    // Gefunden-Orte: letzter Punkt vor dem Fundzeitpunkt
    for (const p of snap.players.filter((x) => x.role === 'hider' && x.found_at)) {
      const tr = tracks.find((t) => t.player_id === p.id);
      const pt = tr && [...tr.points].reverse().find((q) => q[2] <= ts(p.found_at) + 5000);
      if (pt) labelMarker({ lat: pt[1], lon: pt[0] }, `✕ ${p.name}`, 'bad').addTo(map);
    }
    // Pings blass dazu, Täuschungen markiert
    const decoys = new Set(replay.decoys || []);
    for (const pg of snap.pings.filter((x) => x.mode === 'circle' && !x.recipient_id)) {
      L.circle([pg.lat, pg.lon], { radius: pg.radius_m, className: `lf-ping old${decoys.has(pg.id) ? ' decoy' : ''}`, interactive: false }).addTo(map);
    }
    posG = L.layerGroup().addTo(map);
    slider.addEventListener('input', () => {
      stop();
      tNow = t0 + ((t1 - t0) * Number(slider.value)) / 1000;
      drawAt(snap, tracks);
    });
    playBtn.addEventListener('click', () => (playing ? stop() : play(snap, tracks)));
    drawAt(snap, tracks);
  }

  function drawAt(snap, tracks) {
    posG.clearLayers();
    for (const t of tracks) {
      const p = snap.players.find((x) => x.id === t.player_id);
      let pt = null;
      for (const q of t.points) { if (q[2] <= tNow) pt = q; else break; }
      if (!pt) continue;
      const gone = p?.found_at && ts(p.found_at) <= tNow;
      dotMarker({ lat: pt[1], lon: pt[0] }, `mate ${p?.role === 'hunter' ? '' : 'hider'}`, gone ? 'found' : '').addTo(posG);
      labelMarker({ lat: pt[1], lon: pt[0] }, p?.name || '?', p?.role === 'hunter' ? 'ac' : 'hid', -22).addTo(posG);
    }
    slider.value = Math.round(((tNow - t0) / Math.max(1, t1 - t0)) * 1000);
    slider.style.setProperty('--p', `${slider.value / 10}%`);
    timeLbl.textContent = mmss(tNow - t0);
  }

  function play(snap, tracks) {
    if (tNow >= t1) tNow = t0;
    playing = true;
    playBtn.innerHTML = icon('pause', 18);
    const speed = (t1 - t0) / 20000; // ganze Runde in 20 Sekunden
    let last = performance.now();
    const stepFn = (now) => {
      if (!playing) return;
      tNow = Math.min(t1, tNow + (now - last) * speed);
      last = now;
      drawAt(snap, tracks);
      if (tNow >= t1) return stop();
      raf = requestAnimationFrame(stepFn);
    };
    raf = requestAnimationFrame(stepFn);
  }
  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    if (playBtn) playBtn.innerHTML = icon('play', 18);
  }

  let lastKey = null;
  function render(snap) {
    const g = snap.game, me = snap.me;
    if (!g || !me) return;
    const key = JSON.stringify([g.status, g.winner, g.rematch_id, g.purge_at, me.is_host, snap.pings.length, snap.players.map((p) => [p.id, p.status, p.role])]);
    if (key === lastKey) return;
    lastKey = key;
    const s = summary(snap);
    const hidersWin = s.winner === 'hiders';
    const title = s.winner === 'hiders' ? 'Gejagte gewinnen' : s.winner === 'hunters' ? 'Sucher gewinnen' : 'Spiel abgebrochen';
    const reason = s.reason === 'time' ? 'Zeit abgelaufen' : s.reason === 'all_found' ? 'Alle gefunden' : 'Vom Host beendet';
    const survivors = snap.players.filter((p) => p.role === 'hider' && p.status === 'active').map((p) => p.name);
    const huntDur = Math.max(0, ts(g.ended_at) - ts(g.hunt_starts_at));
    const sub = s.winner === 'hiders'
      ? `${survivors.join(' und ') || 'Die Gejagten'} ${survivors.length === 1 ? 'blieb' : 'blieben'} ${mmss(huntDur)} unentdeckt.`
      : s.winner === 'hunters' ? `Alle Gejagten nach ${mmss(huntDur)} Jagd gefunden.` : 'Ohne Sieger.';
    const rematchBtn = h('button', { class: 'btn pri', disabled: !me.is_host }, 'Revanche');
    rematchBtn.addEventListener('click', busy(rematchBtn, async () => {
      rememberRound(snap);
      await ctx.backend.rematch();
    }));
    const lobbyBtn = h('button', { class: 'btn sec', onclick: () => { rememberRound(snap); ctx.dismissResult(g.id); } }, 'Zur Lobby');
    const hiders = snap.players.filter((p) => p.role === 'hider');
    const hunters = snap.players.filter((p) => p.role === 'hunter');

    const parts = [
      h('div', { class: `trophy ${hidersWin ? 'hid' : ''}` }, h('span', { class: 'tr', html: icon('trophy', 42) })),
      h('div', { class: 'center' }, h('span', { class: 'lbl' }, `Runde beendet · ${reason}`), h('h1', { class: s.winner === 'hiders' ? 'win-hiders' : s.winner === 'hunters' ? 'win-hunters' : '' }, title), h('p', { class: 'sub' }, sub)),
      h('div', { class: 'tiles3 on-bg' },
        tileEl('Dauer', mmss(s.durationMs)), tileEl('Gefunden', `${s.found} / ${s.hiders}`), tileEl('Pings', String(s.pings))),
      g.rematch_id ? h('div', { class: 'card tight', style: { border: '1.5px solid var(--ac)' } },
        h('b', {}, 'Der Host hat eine Revanche gestartet'),
        h('p', { class: 'sub' }, 'Gleiche Regeln, gleiches Gebiet, Rollen getauscht. Du bist schon eingetragen.'),
        h('button', { class: 'btn pri', onclick: () => ctx.openGameById(g.rematch_id) }, 'Zum Warteraum')) : null,
      replayBox,
      h('span', { class: 'lbl' }, 'Ergebnis Gejagte'),
      h('div', { class: 'card list' }, hiders.map((p) => h('div', { class: 'pl' }, avatar(p),
        h('div', { class: 'grow' }, h('b', {}, p.name), h('small', {}, p.status === 'found' ? `gefunden bei ${mmss(ts(p.found_at) - ts(g.hunt_starts_at))}` : p.status === 'eliminated' ? 'ausgeschieden (Grenze)' : p.status === 'left' ? 'hat verlassen' : `überlebt ${mmss(huntDur)}`)),
        h('span', { class: `pill ${p.status === 'active' ? (s.winner ? 'ok' : '') : 'bad'}` }, p.status === 'active' ? (s.winner ? 'Sieg' : 'frei') : p.status === 'found' ? 'Gefunden' : 'Raus')))),
      h('span', { class: 'lbl' }, 'Sucher'),
      h('div', { class: 'card list' }, hunters.map((p) => h('div', { class: 'pl' }, avatar(p), h('div', { class: 'grow' }, h('b', {}, p.name)), h('span', { class: `pill ${s.winner === 'hunters' ? 'ok' : ''}` }, s.winner === 'hunters' ? 'Sieg' : 'Sucher')))),
      h('button', { class: 'btn sec', html: `${icon('chat', 18)} Chat ansehen (jetzt alle Kanäle)`, onclick: () => ctx.openChat() }),
      h('div', { class: 'two' }, lobbyBtn, rematchBtn),
      h('p', { class: 'hint' }, me.is_host ? 'Revanche tauscht die Rollen. Gleiche Regeln, gleiches Gebiet.' : 'Die Revanche startet der Host.'),
      g.purge_at ? h('p', { class: 'hint' }, `Standorte, Pings und Chat werden ${dateTime(ts(g.purge_at))} Uhr automatisch gelöscht.`) : null,
    ];
    // Wiederholungs-Karte nicht bei jedem Update neu aufbauen
    const keep = replayBox;
    setChildren(el, ...parts);
    if (!built) {
      built = true;
      setChildren(keep, h('p', { class: 'sub', style: { padding: '16px' } }, 'Lade Wiederholung …'));
      buildReplay(snap);
    }
    map?.invalidateSize();
  }

  function tileEl(lbl, v) {
    return h('div', { class: 'tile' }, h('span', { class: 'lbl' }, lbl), h('span', { class: 'v' }, v));
  }

  render(ctx.snap());
  rememberRound(ctx.snap());
  return {
    el,
    update: render,
    destroy() {
      stop();
      map?.remove();
    },
  };
}

