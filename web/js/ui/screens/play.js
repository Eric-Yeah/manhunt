// Screens 5 und 6: Sucher- und Gejagten-Ansicht während des Spiels.
import { h, toast, confirmDialog, modal, setChildren, vibrate, busy } from '../../util/dom.js';
import { icon, ringSvg } from '../../util/icons.js';
import { mmss, ago, meters, minutes, ts } from '../../util/format.js';
import { normalizeSettings, zoneIndexAt, zoneGeometryAt, HIDER_JOKERS, HUNTER_JOKERS, jokerUsed, startRole } from '../../core/engine.js';
import { boundaryStatus, bandSector, destination } from '../../core/geo.js';
import { directionText, distanceText, isNotice } from '../../core/ping.js';
import { playAlarm } from '../../util/sound.js';
import { createMap, outsideMask, polygonLayer, dotMarker, labelMarker, fitGeometry } from '../map.js';
import { holdButton, signalEl, avatar, ROLE, demoBanner } from '../components.js';

export function playScreen(ctx) {
  const L = window.L;
  const el = h('div', { class: 'mapscr' });
  const mapEl = h('div', { class: 'map' });
  const hud = h('div', { class: 'hudtop', 'aria-live': 'polite' });
  const fabs = h('div', { class: 'fabs' });
  const sheet = h('div', { class: 'sheet' });
  const veil = h('div', { class: 'paused-veil', hidden: true });
  el.append(mapEl, hud, fabs, sheet, veil);

  const first = ctx.snap();
  const map = createMap(mapEl, { center: first.game.area ? undefined : ctx.cfg.DEFAULT_CENTER, zoom: 15 });
  if (first.game.area) fitGeometry(map, first.game.area.geometry, [40, 40], { paddingBottomRight: [40, 220] });
  const zoneG = L.layerGroup().addTo(map);
  const exclG = L.layerGroup().addTo(map);
  const pingG = L.layerGroup().addTo(map);
  const mateG = L.layerGroup().addTo(map);
  const revG = L.layerGroup().addTo(map);
  const meG = L.layerGroup().addTo(map);
  let meMarker = null, meAcc = null;
  let meRole = first.me?.role;
  let keys = {};
  // Ping-Menü: 'normal' (Standard), 'open' (alles zeigen) oder 'peek' (nach unten weggewischt, nur der Griff bleibt)
  let sheetState = 'normal';
  let sheetOpen = false;
  let lastPingId = null;
  let lastEventId = (first.events || []).reduce((m, e) => Math.max(m, e.id), 0);
  let lastStatus = first.game.status;
  let snap = first;

  // Demo: Antippen der Karte bewegt die eigene Figur
  if (ctx.backend.mode === 'demo') {
    map.on('click', (e) => ctx.backend.moveMe?.({ lat: e.latlng.lat, lon: e.latlng.lng }));
  }

  // ---------- Feste Elemente ----------
  const hold = holdButton({
    label: 'Ich wurde gefunden',
    onDone: async () => {
      try {
        await ctx.backend.markFound();
        toast('Gefunden! Du schaust jetzt zu.');
      } catch (e) {
        toast(e.message, 'bad');
      }
    },
  });
  const holdHint = h('p', { class: 'hint' }, 'Gedrückt halten (2 s) zum Bestätigen. Es gibt kein automatisches Fangen per GPS.');
  const grab = h('button', { class: 'grab', 'aria-label': 'Ping-Menü: antippen zum Ein- und Ausklappen, nach unten wischen zum Wegschieben' }, h('span', { class: 'peek-label' }, 'Hochwischen für Pings & Joker'));
  const sheetHead = h('div', { class: 'stack', style: { touchAction: 'none' } });
  const foundBox = h('div', { class: 'stack' });
  const tileBox = h('div', { class: 'tiles3' });
  const histBox = h('div', { class: 'stack' });
  const jokerBox = h('div', { class: 'stack' });
  const moreList = h('div', { class: 'stack' });
  const moreActions = h('div', { class: 'stack' });
  const moreBox = h('div', { class: 'stack more-only', style: { flexDirection: 'column' } }, moreList, moreActions);
  sheet.append(grab, sheetHead, tileBox, histBox, jokerBox, foundBox, h('div', { class: 'stack hider-only' }, hold, holdHint), moreBox);

  const PEEK_PX = 54;
  const hiddenOffset = () => Math.max(0, sheet.offsetHeight - PEEK_PX);
  const fitAttr = () => {
    const visible = sheetState === 'peek' ? PEEK_PX : sheet.offsetHeight;
    mapEl.style.setProperty('--attr-offset', `${visible}px`);
    el.style.setProperty('--sheet-h', `${visible}px`);
  };
  function applySheet() {
    sheetOpen = sheetState === 'open';
    sheet.classList.remove('dragging');
    sheet.classList.toggle('open', sheetOpen);
    sheet.classList.toggle('peek', sheetState === 'peek');
    sheet.style.transform = sheetState === 'peek' ? `translateY(${hiddenOffset()}px)` : '';
    fitAttr();
  }
  const ro = new ResizeObserver(() => {
    if (sheetState === 'peek' && !sheet.classList.contains('dragging')) sheet.style.transform = `translateY(${hiddenOffset()}px)`;
    fitAttr();
  });
  ro.observe(sheet);

  // Wischen am Griff und am Kopf des Menüs: nach unten wegschieben, nach oben aufziehen. Antippen des Griffs klappt auf/zu.
  let drag = null;
  const dragDown = (e) => {
    if (e.button > 0 || drag) return;
    drag = { id: e.pointerId, y0: e.clientY, t0: performance.now(), moved: false, base: sheetState === 'peek' ? hiddenOffset() : 0, el: e.currentTarget };
  };
  const dragMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.abs(dy) < 6) return;
      drag.moved = true;
      try { drag.el.setPointerCapture(e.pointerId); } catch { /* egal */ }
      sheet.classList.add('dragging');
    }
    sheet.style.transform = `translateY(${Math.min(hiddenOffset(), Math.max(0, drag.base + dy))}px)`;
  };
  const dragEnd = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    const dy = e.clientY - d.y0;
    const v = dy / Math.max(1, performance.now() - d.t0); // px pro ms, positiv = nach unten
    if (e.type === 'pointercancel') { /* nichts ändern */ }
    else if (!d.moved) { if (d.el === grab) sheetState = sheetState === 'normal' ? 'open' : 'normal'; }
    else if (sheetState === 'peek') { if (dy < -30 || v < -0.4) sheetState = 'normal'; }
    else if (sheetState === 'normal') { if (dy > 60 || v > 0.5) sheetState = 'peek'; else if (dy < -50 || v < -0.5) sheetState = 'open'; }
    else if (dy > 160 || v > 1.1) sheetState = 'peek';
    else if (dy > 50 || v > 0.4) sheetState = 'normal';
    applySheet();
  };
  for (const target of [grab, sheetHead]) {
    target.addEventListener('pointerdown', dragDown);
    target.addEventListener('pointermove', dragMove);
    target.addEventListener('pointerup', dragEnd);
    target.addEventListener('pointercancel', dragEnd);
  }
  grab.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    sheetState = sheetState === 'normal' ? 'open' : 'normal';
    applySheet();
  });

  const chatFab = h('button', { class: 'fab', 'aria-label': 'Chat öffnen', onclick: () => ctx.openChat() });
  fabs.append(
    h('button', { class: 'fab', 'aria-label': 'Auf mich zentrieren', html: icon('locate'), onclick: () => {
      const p = ctx.pos();
      if (p) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
      else toast(ctx.locError() || 'Noch kein Standort.', 'bad');
    } }),
    h('button', { class: 'fab', 'aria-label': 'Spielgebiet zeigen', html: icon('area'), onclick: () => {
      const z = zoneGeometryAt(gms(snap.game), effNow());
      if (z) fitGeometry(map, z, [30, 30], { paddingBottomRight: [30, sheet.offsetHeight + 20] });
    } }),
    chatFab,
    h('button', { class: 'fab sos', 'aria-label': 'Pause oder SOS', html: icon('pause'), onclick: pauseMenu }),
  );

  async function pauseMenu() {
    if (snap.game.status !== 'running') return;
    const choice = await modal({
      title: 'Spiel anhalten?',
      body: 'Das Spiel pausiert für alle. Countdown und Pings stoppen, bis der Host oder du fortsetzt.',
      buttons: [
        { label: 'Pause', value: 'Pause', kind: 'pri' },
        { label: 'SOS – ich brauche Hilfe', value: 'SOS', kind: 'danger' },
        { label: 'Abbrechen', value: null, kind: 'ghost' },
      ],
    });
    if (!choice) return;
    try {
      await ctx.backend.pause(choice);
      if (choice === 'SOS') vibrate([200, 100, 200]);
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  // ---------- Hilfsfunktionen ----------
  function gms(g) {
    return { zone_stages: g.zone_stages, hunt_starts_at: ts(g.hunt_starts_at), area: g.area, zone_index: g.zone_index };
  }
  function effNow() {
    return snap.game.status === 'paused' && snap.game.paused_at ? ts(snap.game.paused_at) : ctx.now();
  }
  const nameOf = (id) => snap.players.find((p) => p.id === id)?.name || '?';

  function pingText(p) {
    if (p.kind === 'joker_skip') return 'übersprungen (Joker)';
    if (p.kind === 'joker_sound') return 'Sound-Joker: genauer Standort';
    if (p.no_signal || p.mode === 'none') return p.recipient_id ? 'dein Standort fehlte' : 'kein Signal';
    let t = p.mode === 'distance' ? distanceText(p) : p.mode === 'exact' ? 'exakter Punkt' : p.mode === 'circle' ? `Kreis ~${Math.round(p.radius_m)} m` : directionText(p);
    if (p.joker === 'double') t += ' (Joker)';
    if (p.ref_is_center) t += ' vom Mittelpunkt';
    if (p.age_s > 120) t += ` · Position ${minutes(p.age_s)} alt`;
    return t;
  }

  // ---------- Karte ----------
  function drawZone(s) {
    const g = snap.game;
    const now = effNow();
    const stages = Array.isArray(g.zone_stages) ? g.zone_stages : [];
    const idx = Math.max(g.zone_index || 0, zoneIndexAt(gms(g), now));
    const next = stages[idx + 1];
    const nextAt = next ? ts(g.hunt_starts_at) + next.at_s * 1000 : null;
    const showNext = next && nextAt - now <= 120_000;
    const bad = snap.me?.role === 'hider' && !!snap.priv?.oob_deadline;
    const key = `${idx}|${showNext}|${bad}|${stages.length}`;
    if (keys.zone === key) return;
    keys.zone = key;
    zoneG.clearLayers();
    const geom = stages[idx]?.geometry || g.area?.geometry;
    if (!geom) return;
    outsideMask(geom).addTo(zoneG);
    polygonLayer(geom, `lf-bound${bad ? ' bad' : ''}`).addTo(zoneG);
    if (showNext) polygonLayer(next.geometry, 'lf-next').addTo(zoneG);
    if (keys.excl !== (g.exclusions || []).length) {
      keys.excl = (g.exclusions || []).length;
      exclG.clearLayers();
      for (const ex of g.exclusions || []) {
        polygonLayer(ex.geometry, 'lf-excl').addTo(exclG);
      }
    }
  }

  function drawPings() {
    const me = snap.me;
    const ended = snap.game.status === 'ended';
    const visible = snap.pings.filter((p) => p.mode !== 'none' && !isNotice(p));
    const key = `${visible.length}|${visible.at(-1)?.id}|${me.role}|${Math.floor(ctx.now() / 30000)}`;
    if (keys.pings === key) return;
    keys.pings = key;
    pingG.clearLayers();
    const byHider = {};
    for (const p of visible) (byHider[p.hider_id] ||= []).push(p);
    const now = ctx.now();
    const decoys = new Set(snap.secrets.filter((x) => x.is_decoy).map((x) => x.ping_id));
    for (const [hid, list] of Object.entries(byHider)) {
      const recent = list.sort((a, b) => b.id - a.id).slice(0, me.role === 'hunter' ? 3 : 1);
      recent.forEach((p, i) => {
        const latest = i === 0;
        const own = p.hider_id === me.id;
        const age = now - ts(p.created_at);
        const cls = ['lf-ping', latest ? (age < 90_000 ? 'pulse' : '') : 'old', own ? 'own' : '', decoys.has(p.id) && (own || ended) ? 'decoy' : ''].join(' ');
        const sound = p.kind === 'joker_sound';
        const label = sound ? `🔊 ${own ? 'du' : nameOf(hid)}` : `#${p.seq}${p.kind === 'penalty' ? '+' : ''} ${own ? 'du' : nameOf(hid)}${decoys.has(p.id) && (own || ended) ? ' (Täuschung)' : ''}`;
        if (p.mode === 'distance') {
          // Nur die Entfernung ist bekannt: Ring um die Position des Suchers beim Ping
          const ref = { lat: p.ref_lat, lon: p.ref_lon };
          L.circle([ref.lat, ref.lon], { radius: Math.max(2, p.distance_m), className: `lf-dist${latest ? (age < 90_000 ? ' pulse' : '') : ' old'}${decoys.has(p.id) && ended ? ' decoy' : ''}`, interactive: false }).addTo(pingG);
          labelMarker(destination(ref, Math.max(2, p.distance_m), 0), `${label}: ${distanceText(p)}`, latest ? 'ac' : 'mut').addTo(pingG);
          if (latest) dotMarker(ref, '', 'stale').addTo(pingG);
        } else if (p.mode === 'circle') {
          L.circle([p.lat, p.lon], { radius: p.radius_m, className: cls, interactive: false }).addTo(pingG);
          if (latest || me.role === 'hunter') labelMarker(p, label, latest ? 'ac' : 'mut').addTo(pingG);
        } else if (p.mode === 'exact') {
          dotMarker(p, 'hider', latest ? '' : 'stale').addTo(pingG);
          labelMarker(p, label, latest ? 'hid' : 'mut', -24).addTo(pingG);
          if (sound && latest) L.circle([p.lat, p.lon], { radius: 12, className: 'lf-ping pulse', interactive: false }).addTo(pingG);
        } else if (p.mode === 'direction') {
          const ref = { lat: p.ref_lat, lon: p.ref_lon };
          const half = (p.sector_deg || 45) / 2;
          // Doppelter Kreis rundet grob: "100" steht für alles unter 200 m.
          const span = p.distance_m <= 50 ? [0, 100] : p.joker === 'double' && p.distance_m <= 100 ? [0, 200] : [Math.max(0, p.distance_m * 0.75), p.distance_m * 1.25 + 50];
          const band = bandSector(ref, span[0], span[1], p.bearing_deg - half, p.bearing_deg + half);
          polygonLayer(band.geometry, cls).addTo(pingG);
          if (latest) {
            const mid = band.geometry.coordinates[0][Math.floor(band.geometry.coordinates[0].length / 4)];
            labelMarker({ lat: mid[1], lon: mid[0] }, `${label}: ${directionText(p)}`, 'ac').addTo(pingG);
            if (p.ref_is_center) dotMarker(ref, '', 'stale').addTo(pingG);
          }
        }
      });
    }
  }

  function drawMates() {
    const me = snap.me;
    const now = ctx.now();
    const entries = Object.entries(snap.teammates || {}).filter(([id]) => id !== me.id);
    const key = entries.map(([id, t]) => `${id}:${t.at}`).join('|') + `|${me.role}|${Math.floor(now / 30000)}`;
    if (keys.mates === key) return;
    keys.mates = key;
    mateG.clearLayers();
    for (const [id, t] of entries) {
      const p = snap.players.find((x) => x.id === id);
      if (!p || p.status === 'left') continue;
      const stale = now - t.at > 120_000;
      dotMarker(t, `mate ${p.role === 'hider' ? 'hider' : ''}`, stale ? 'stale' : '').addTo(mateG);
      labelMarker(t, `${p.name}${stale ? ` · ${ago(now - t.at)}` : ''}`, p.role === 'hider' ? 'hid' : 'ac', -22).addTo(mateG);
    }
  }

  // Sucher-Radar: Momentaufnahme der Sucher-Positionen (nur für den Gejagten, der den Joker eingesetzt hat)
  function drawReveal() {
    const ev = [...(snap.events || [])].reverse().find((e) => e.kind === 'reveal');
    const now = ctx.now();
    const age = ev ? now - ts(ev.created_at) : Infinity;
    const show = !!ev && snap.me.role === 'hider' && age < 5 * 60_000;
    const key = show ? `${ev.id}|${Math.floor(now / 10000)}` : 'none';
    if (keys.rev === key) return;
    keys.rev = key;
    revG.clearLayers();
    if (!show) return;
    for (const pos of ev.positions || []) {
      const t = age + (pos.age_s || 0) * 1000;
      dotMarker(pos, 'mate', t > 120_000 ? 'stale' : '').addTo(revG);
      labelMarker(pos, `${pos.name} · ${ago(t)}`, 'ac', -22).addTo(revG);
    }
  }

  function drawMe(pos) {
    if (!pos) return;
    const role = snap.me?.role === 'hider' ? 'hider' : '';
    if (!meMarker) {
      meAcc = L.circle([pos.lat, pos.lon], { radius: pos.accuracy || 10, className: `lf-acc ${role ? 'hid' : ''}`, interactive: false }).addTo(meG);
      meMarker = dotMarker(pos, role).addTo(meG);
    } else {
      meMarker.setLatLng([pos.lat, pos.lon]);
      meAcc.setLatLng([pos.lat, pos.lon]);
      meAcc.setRadius(Math.min(pos.accuracy || 10, 200));
    }
  }

  // ---------- HUD & Sheet ----------
  function renderHud() {
    const g = snap.game, me = snap.me, pv = snap.priv;
    if (!me) return;
    const s = normalizeSettings(g.settings);
    const now = effNow();
    const huntStart = ts(g.hunt_starts_at), nextPing = ts(g.next_ping_at);
    const paused = g.status === 'paused';
    const inHead = now < huntStart;
    const isHunter = me.role === 'hunter', isHider = me.role === 'hider';
    const out = me.status !== 'active';
    const parts = [];

    if (isHider && !out && pv?.violation && pv?.oob_deadline) {
      const left = ts(pv.oob_deadline) - ctx.now();
      parts.push(h('div', { class: 'card warncard' },
        h('span', { class: 'wi', html: icon('warn', 26) }),
        h('div', { class: 'grow' },
          h('b', { style: { display: 'block', fontSize: '15px' } }, pv.violation === 'exclusion' ? `In der Sperrzone „${pv.violation_name || 'Sperrzone'}“!` : 'Außerhalb des Spielgebiets!'),
          h('small', {}, s.boundary_penalty === 'eliminate' ? 'Sofort zurück, sonst scheidest du aus.' : 'Sofort zurück, sonst bekommen die Sucher einen Extra-Ping.')),
        h('b', { class: 'cd bad' }, left > 0 ? mmss(left) : '0:00')));
      parts.push(h('div', { class: 'wbar' }, h('i', { style: { width: `${Math.max(0, Math.min(100, (left / (s.boundary_warn_s * 1000)) * 100))}%` } })));
    } else if (pv?.violation && !out) {
      parts.push(h('div', { class: 'card warncard soft' },
        h('span', { class: 'wi', html: icon('warn', 24) }),
        h('div', { class: 'grow' }, h('b', {}, pv.violation === 'exclusion' ? `Sperrzone „${pv.violation_name || ''}“ – bitte verlassen!` : 'Du bist außerhalb des Spielgebiets.'),
          h('small', {}, isHunter ? 'Für Sucher gibt es keine Strafe.' : 'Zurück in die Zone.'))));
    }

    if (out) {
      parts.push(h('div', { class: 'card tight', style: { boxShadow: 'var(--shadow)' } },
        h('b', {}, me.status === 'found' ? 'Du wurdest gefunden.' : me.status === 'eliminated' ? 'Du bist ausgeschieden.' : 'Du hast das Spiel verlassen.'),
        h('small', {}, me.status === 'found' ? 'Du kannst zuschauen und chatten – oder unten als Sucher mitjagen.' : 'Du kannst weiter zuschauen und chatten.')));
    } else {
      const total = inHead ? Math.max(1, s.headstart_s * 1000) : s.ping_interval_s * 1000;
      const left = Math.max(0, (inHead ? huntStart : nextPing) - now);
      const label = paused ? 'Pausiert' : inHead ? (isHunter ? 'Jagd beginnt in' : 'Vorsprung noch') : isHunter ? 'Nächster Ping in' : 'Sucher-Ping in';
      parts.push(h('div', { class: 'card pingcd' },
        h('div', { html: ringSvg(left / total, minutes(Math.round(total / 1000))) }),
        h('div', { class: 'grow' }, h('span', { class: 'lbl' }, label), h('b', { class: 'cd' }, left > 0 ? mmss(left) : 'jetzt')),
        h('span', { class: `pill ${ROLE[me.role]?.cls || ''}` }, ROLE[me.role]?.label || '')));
    }

    if (isHunter) {
      const real = snap.pings.filter((p) => !isNotice(p) && p.kind !== 'joker_sound');
      const last = [...real].reverse().find((p) => p.kind !== 'penalty') || real.at(-1);
      parts.push(h('span', { class: 'pill glass' }, last ? `Letzter Ping #${last.seq} ${ago(ctx.now() - ts(last.created_at))} · ${nameOf(last.hider_id)} ${pingText(last)}` : inHead ? 'Die Gejagten verstecken sich gerade.' : 'Noch kein Ping'));
    } else {
      const pos = ctx.pos();
      const zone = zoneGeometryAt(gms(g), now);
      let txt = ctx.locError() || 'Warte auf GPS …';
      if (pos && zone) {
        const b = boundaryStatus(pos, zone, g.exclusions || [], s.boundary_tolerance_m);
        txt = b.edgeDistM >= 0 ? `Innerhalb der Grenze · ${meters(b.edgeDistM)} bis zum Rand` : `${meters(-b.edgeDistM)} außerhalb der Grenze`;
      }
      if (!out) parts.push(h('span', { class: 'pill glass' }, txt));
    }

    const stages = Array.isArray(g.zone_stages) ? g.zone_stages : [];
    const idx = zoneIndexAt(gms(g), now);
    if (stages[idx + 1]) {
      const at = huntStart + stages[idx + 1].at_s * 1000;
      if (at - now <= 120_000) parts.push(h('span', { class: 'pill warn', style: { alignSelf: 'flex-start', boxShadow: 'var(--shadow)' } }, `Zone schrumpft in ${mmss(at - now)} (gestrichelt)`));
    }
    if (snap.offline) parts.push(h('span', { class: 'pill bad', style: { alignSelf: 'flex-start' } }, 'Verbindung unterbrochen – wird neu verbunden …'));
    setChildren(hud, ...parts);
  }

  async function clickJoker(type, j, on) {
    if (on) {
      if (await confirmDialog('Joker zurücknehmen?', 'Du kannst ihn danach noch einmal einsetzen.', 'Zurücknehmen')) await ctx.backend.cancelJoker();
      return;
    }
    if (type === 'sound') return soundJoker();
    if (type === 'reveal') {
      if (!(await confirmDialog('Sucher-Radar einsetzen?', `${j.sub} Das geht nur einmal pro Runde.`, 'Einsetzen'))) return;
      await ctx.backend.useJoker('reveal');
      toast('Sucher-Radar: Die Sucher sind auf der Karte markiert.', 'ok');
      return;
    }
    if (!(await confirmDialog(`${j.label} einsetzen?`, `${j.sub} Das geht nur einmal pro Runde.`, 'Einsetzen'))) return;
    await ctx.backend.useJoker(type);
    toast('Joker aktiv');
  }

  async function soundJoker() {
    const targets = snap.players.filter((p) => p.role === 'hider' && p.status === 'active');
    if (!targets.length) throw new Error('Es ist kein Gejagter mehr frei.');
    const choice = await modal({
      title: 'Sound-Joker einsetzen',
      body: 'Bei wem soll der Ton abgespielt werden? Alle Sucher sehen danach seinen genauen Standort, egal wo er ist. Das geht nur einmal pro Runde.',
      buttons: [...targets.map((t) => ({ label: t.name, value: t.id, kind: 'pri' })), { label: 'Abbrechen', value: null, kind: 'ghost' }],
    });
    if (!choice) return;
    await ctx.backend.useHunterJoker(choice);
    toast('Sound-Joker eingesetzt. Der genaue Standort erscheint auf der Karte.', 'ok');
    if (ctx.backend.mode === 'demo') {
      toast('Demo: So klingt der Ton beim Gejagten.');
      playAlarm();
    }
  }

  function renderSheet() {
    const g = snap.game, me = snap.me, pv = snap.priv;
    if (!me) return;
    const s = normalizeSettings(g.settings);
    const now = effNow();
    const isHider = me.role === 'hider';
    const hiders = snap.players.filter((p) => startRole(p) === 'hider' && p.status !== 'left');
    const free = hiders.filter((p) => p.role === 'hider' && p.status === 'active').length;
    const timeLeft = Math.max(0, ts(g.ends_at) - now);
    const inHead = now < ts(g.hunt_starts_at);

    const headKey = `${me.status}|${me.role}|${inHead}|${sheetOpen}`;
    if (keys.head !== headKey && (keys.head = headKey)) setChildren(sheetHead,
      ctx.backend.mode === 'demo' && sheetOpen ? demoBanner(() => ctx.switchBackend('supabase')) : null,
      h('div', { class: 'row between' },
        h('div', { class: 'row' }, avatar(me), h('div', {}, h('b', {}, isHider ? 'Du bist Gejagter' : 'Du bist Sucher'),
          h('small', { style: { display: 'block' } }, me.status === 'active' ? (inHead ? (isHider ? 'Versteck dich!' : 'Warte auf das Ende des Vorsprungs') : isHider ? 'Status: frei' : 'Finde die Gejagten') : me.status === 'found' ? 'gefunden' : 'ausgeschieden'))),
        h('span', { class: `pill ${me.status === 'active' ? 'ok' : 'bad'}` }, me.status === 'active' ? (isHider ? 'frei' : 'jagt') : me.status === 'found' ? 'gefunden' : 'raus')));

    setChildren(tileBox,
      tile('Zeit übrig', mmss(timeLeft)),
      tile('Gejagte frei', `${free} / ${hiders.length}`),
      isHider ? tile('Ping in', now < ts(g.hunt_starts_at) ? mmss(ts(g.hunt_starts_at) - now) : mmss(Math.max(0, ts(g.next_ping_at) - now)))
        : (() => {
          const zone = zoneGeometryAt(gms(g), now);
          const pos = ctx.pos();
          if (!pos || !zone) return tile('Grenze', '–');
          const b = boundaryStatus(pos, zone, g.exclusions || [], s.boundary_tolerance_m);
          return tile('Grenze', b.violation === 'exclusion' ? 'Sperrzone' : b.violation ? 'außen' : 'innen', b.edgeDistM != null ? `${meters(Math.abs(b.edgeDistM))} ${b.edgeDistM >= 0 ? 'Rand' : 'draußen'}` : '', b.violation ? 'bad' : 'ok');
        })());

    // Ping-Verlauf (Sucher) – nur neu bauen, wenn sich etwas ändert (sonst gehen Tipps verloren)
    const histKey = `${isHider}|${snap.pings.length}|${snap.pings.at(-1)?.id}|${sheetOpen}|${Math.floor(Date.now() / 15000)}|${inHead}`;
    if (keys.hist !== histKey && (keys.hist = histKey) && !isHider) {
      const rows = snap.pings.filter((p) => !isNotice(p)).sort((a, b) => b.id - a.id).slice(0, sheetOpen ? 12 : 3);
      setChildren(histBox,
        h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Ping-Verlauf'), h('span', { class: 'sub' }, inHead ? 'Vorsprung läuft' : `Ping alle ${minutes(s.ping_interval_s)}`)),
        rows.length ? h('div', { class: 'hist' }, rows.map((p, i) => h('button', {
          class: `hrow${i === 0 && ctx.now() - ts(p.created_at) < 90_000 ? ' now' : ''}`,
          onclick: () => {
            if (p.mode === 'circle' || p.mode === 'exact') map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
            else if (p.mode === 'distance') map.setView([p.ref_lat, p.ref_lon], 16);
            else if (p.mode === 'direction') map.setView([p.ref_lat, p.ref_lon], 15);
          },
        }, h('span', { class: 'hn' }, p.kind === 'joker_sound' ? '🔊' : `#${p.seq}`), h('b', {}, nameOf(p.hider_id)), h('small', {}, `${p.kind === 'penalty' ? 'Extra-Ping · ' : ''}${pingText(p)} · ${ago(ctx.now() - ts(p.created_at))}`)))) : h('p', { class: 'sub' }, 'Noch keine Pings.'));
    } else if (isHider) {
      histBox.replaceChildren();
    }

    // Joker: Gejagte haben vier, Sucher den Sound-Joker. Jeder einmal pro Runde, von Anfang an.
    const active = me.status === 'active';
    const defs = !active ? null : isHider ? HIDER_JOKERS : me.role === 'hunter' ? HUNTER_JOKERS : null;
    const usedKeys = Object.keys(pv?.joker_used || {}).sort().join();
    const jokerKey = `${me.status}|${me.role}|${pv?.joker_pending}|${usedKeys}|${g.status}`;
    if (keys.joker !== jokerKey) {
      keys.joker = jokerKey;
      if (!defs) jokerBox.replaceChildren();
      else {
        setChildren(jokerBox,
          h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Joker'), h('span', { class: 'sub' }, pv?.joker_pending ? 'Aktiv für den nächsten Ping' : 'jeder 1× pro Runde')),
          h('div', { class: 'joker-row', style: { gridTemplateColumns: `repeat(${Math.min(4, Object.keys(defs).length)}, 1fr)` } }, Object.entries(defs).map(([type, j]) => {
            const on = pv?.joker_pending === type;
            const used = jokerUsed(pv, type) && !on;
            const blocked = g.status !== 'running' || (j.pending && !!pv?.joker_pending && !on);
            const b = h('button', { class: `joker${on ? ' on' : ''}${used ? ' done' : ''}`, disabled: used || (!on && blocked), html: `${icon(j.icon, 20)}<span></span><small class="joker-sub"></small>` });
            b.querySelector('span').textContent = j.label;
            b.querySelector('small').textContent = on ? 'aktiv – zurücknehmen' : used ? 'benutzt' : 'bereit';
            b.addEventListener('click', busy(b, () => clickJoker(type, j, on)));
            return b;
          })));
      }
    }

    // Gefundene Gejagte können als Sucher weitermachen
    const canJoin = isHider && me.status === 'found' && ['running', 'paused'].includes(g.status);
    if (keys.found !== canJoin) {
      keys.found = canJoin;
      const joinBtn = h('button', { class: 'btn pri', html: `${icon('target', 18)} <span></span>` });
      joinBtn.querySelector('span').textContent = 'Als Sucher mitjagen';
      joinBtn.addEventListener('click', busy(joinBtn, async () => {
        if (!(await confirmDialog('Als Sucher mitjagen?', 'Du wechselst ins Sucher-Team und suchst die anderen Gejagten. Dein Standort wird dann wieder an die Sucher weitergegeben, und du siehst den Gejagten-Chat nicht mehr. Das lässt sich nicht rückgängig machen.', 'Mitjagen'))) return;
        await ctx.backend.becomeHunter();
        toast('Du jagst jetzt als Sucher mit!', 'ok');
      }));
      setChildren(foundBox, canJoin ? h('div', { class: 'card tight' },
        h('b', {}, 'Weiter als Sucher?'),
        h('p', { class: 'sub' }, 'Du kannst zuschauen oder ab jetzt mit den Suchern die anderen Gejagten jagen.'),
        joinBtn) : null);
    }

    sheet.querySelector('.hider-only').hidden = !(isHider && me.status === 'active');

    // Mehr (aufgeklappt): Spieler, Beenden/Verlassen
    const now2 = ctx.now();
    const team = snap.players.filter((p) => p.status !== 'left');
    const moreKey = team.map((p) => `${p.id}${p.status}${p.last_signal_at}${p.last_traccar_at}`).join() + `|${Math.floor(Date.now() / 15000)}`;
    if (keys.more !== moreKey && (keys.more = moreKey)) setChildren(moreList,
      h('span', { class: 'lbl' }, 'Spieler'),
      h('div', { class: 'card list' }, team.map((p) => h('div', { class: 'pl' },
        avatar(p, true),
        h('div', { class: 'grow' }, h('b', {}, p.name, p.id === me.id ? h('span', { class: 'sub' }, '(du)') : null),
          h('small', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('span', {}, p.role === 'hider' ? (p.status === 'active' ? 'frei' : p.status === 'found' ? 'gefunden' : 'raus') : p.found_at ? 'Sucher (war gefunden)' : 'Sucher'),
            signalEl(p, now2))),
        h('span', { class: `pill ${ROLE[p.role]?.cls || ''}` }, ROLE[p.role]?.label || '')))));
    // Knöpfe nur neu bauen, wenn sich die Rolle ändert (sonst gehen Fingertipps verloren)
    const actKey = `${me.is_host}|${me.role}|${me.status}`;
    if (keys.act !== actKey && (keys.act = actKey)) setChildren(moreActions,
      me.is_host ? h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmDialog('Spiel beenden?', 'Das Spiel endet sofort für alle, ohne Sieger.', 'Beenden', true)) ctx.backend.endGame().catch((e) => toast(e.message, 'bad'));
      } }, 'Spiel für alle beenden') : null,
      h('button', { class: 'btn ghost', onclick: async () => {
        if (await confirmDialog('Spiel verlassen?', me.role === 'hider' && me.status === 'active' ? 'Du zählst dann als raus.' : 'Du kannst danach nicht mehr zurück.', 'Verlassen', true)) ctx.backend.leaveGame().catch((e) => toast(e.message, 'bad'));
      } }, 'Spiel verlassen'));
    fitAttr();
  }

  function tile(lbl, v, small, cls = '') {
    return h('div', { class: `tile ${cls}` }, h('span', { class: 'lbl' }, lbl), h('span', { class: 'v' }, v), small ? h('small', {}, small) : null);
  }

  function renderVeil() {
    const g = snap.game;
    if (g.status !== 'paused') {
      veil.hidden = true;
      keys.veil = null;
      return;
    }
    veil.hidden = false;
    const me = snap.me;
    const veilKey = `${g.paused_at}|${g.paused_by}|${me.is_host}`;
    if (keys.veil === veilKey) return;
    keys.veil = veilKey;
    const by = snap.players.find((p) => p.id === g.paused_by);
    const canResume = me.is_host || g.paused_by === me.id;
    const sos = (g.pause_reason || '').toUpperCase() === 'SOS';
    const resume = h('button', { class: 'btn pri', html: `${icon('play', 18)} Fortsetzen` });
    resume.addEventListener('click', busy(resume, () => ctx.backend.resume()));
    setChildren(veil, h('div', { class: `card ${sos ? 'badbox' : ''}` },
      h('div', { class: `ico-b ${sos ? 'bad' : ''}`, html: icon(sos ? 'warn' : 'pause', 22) }),
      h('h2', {}, sos ? 'SOS – Spiel angehalten' : 'Spiel pausiert'),
      h('p', { class: 'sub' }, `${by ? by.name : 'Jemand'} hat ${sos ? 'SOS gedrückt' : `pausiert: ${g.pause_reason || ''}`} (${ago(ctx.now() - ts(g.paused_at))}).`),
      h('p', { class: 'sub' }, 'Countdown, Pings und Strafen stehen still. Klärt die Lage im Chat.'),
      canResume ? resume : h('p', { class: 'hint' }, 'Fortsetzen kann der Host oder wer pausiert hat.'),
      h('button', { class: 'btn sec', html: `${icon('chat', 18)} Chat öffnen`, onclick: () => ctx.openChat() })));
  }

  function notify() {
    const me = snap.me;
    const newest = snap.pings.at(-1);
    if (newest && lastPingId != null && newest.id > lastPingId) {
      const fresh = snap.pings.filter((p) => p.id > lastPingId);
      const sound = fresh.find((p) => p.kind === 'joker_sound');
      const regular = fresh.filter((p) => p.kind !== 'joker_sound');
      if (me.role === 'hunter') {
        const names = [...new Set(regular.filter((p) => !isNotice(p)).map((p) => nameOf(p.hider_id)))];
        if (names.length) {
          toast(`Neuer Ping: ${names.join(', ')}`, 'ok');
          vibrate([60, 40, 60]);
        }
        if (sound) {
          toast(`Sound-Joker: Standort von ${nameOf(sound.hider_id)} ist auf der Karte.`, 'ok');
          vibrate([60, 40, 60]);
          map.setView([sound.lat, sound.lon], Math.max(map.getZoom(), 17));
        }
      } else if (regular.some((p) => p.hider_id === me.id)) {
        toast('Die Sucher haben dich gerade geortet.', 'ok');
        vibrate(120);
      }
    }
    lastPingId = newest?.id ?? lastPingId ?? 0;
    notifyEvents();
    if (snap.game.status !== lastStatus) {
      if (snap.game.status === 'paused') vibrate([200, 100, 200]);
      lastStatus = snap.game.status;
    }
  }

  // Joker-Ereignisse nur für mich: Ton beim Sound-Joker, Karte beim Sucher-Radar
  function notifyEvents() {
    const me = snap.me;
    const events = snap.events || [];
    const fresh = events.filter((e) => e.id > lastEventId);
    if (!fresh.length) return;
    lastEventId = Math.max(lastEventId, ...events.map((e) => e.id));
    for (const e of fresh) {
      if (ts(e.created_at) < ctx.now() - 10 * 60_000) continue; // alte Ereignisse nicht nachholen
      if (e.kind === 'sound' && me.role === 'hider') {
        toast(`🔊 ${nameOf(e.caller_id)} hat den Sound-Joker gegen dich eingesetzt. Die Sucher sehen jetzt deinen genauen Standort!`, 'bad');
        vibrate([300, 100, 300, 100, 300]);
        playAlarm().then((ok) => {
          if (!ok) toast('Der Browser hat den Ton blockiert. Tippe einmal in die App, dann klappt er beim nächsten Mal.', 'bad');
        });
      } else if (e.kind === 'reveal' && me.role === 'hider' && e.positions?.length) {
        const pts = e.positions.map((p) => [p.lat, p.lon]);
        const mine = ctx.pos();
        if (mine) pts.push([mine.lat, mine.lon]);
        map.fitBounds(pts, { padding: [50, 50], maxZoom: 17, paddingBottomRight: [50, sheet.offsetHeight + 20] });
      }
    }
  }

  function pokeIfDue() {
    const g = snap.game;
    if (g.status !== 'running') return;
    const now = ctx.now();
    const due = [ts(g.next_ping_at), ts(g.ends_at), g.hunt_announced ? null : ts(g.hunt_starts_at), ts(snap.priv?.oob_deadline)]
      .filter(Boolean)
      .some((t) => now > t + 2500 && now < t + 180_000);
    if (due) ctx.backend.pokeTick?.();
  }

  function update(next) {
    snap = next;
    if (!snap.game || !snap.me) return;
    notify();
    if (meMarker && snap.me.role !== meRole) {
      // Rolle gewechselt (gefunden → Sucher): Farbe der eigenen Figur neu zeichnen
      meRole = snap.me.role;
      meG.clearLayers();
      meMarker = null;
      meAcc = null;
      drawMe(ctx.pos());
    }
    drawZone();
    drawPings();
    drawMates();
    drawReveal();
    renderHud();
    renderSheet();
    renderVeil();
    chatFab.innerHTML = icon('chat') + (ctx.unread() ? '<span class="dot"></span>' : '');
  }

  const unsubPos = ctx.onPos((p) => {
    drawMe(p);
  });
  const timer = setInterval(() => {
    if (!snap.game) return;
    renderHud();
    // Kacheln und Zeiten jede Sekunde aktualisieren, ohne den Halte-Knopf neu zu bauen
    renderSheet();
    drawZone();
    drawReveal();
    pokeIfDue();
  }, 1000);

  lastPingId = first.pings.at(-1)?.id ?? 0;
  update(first);
  drawMe(ctx.pos());

  return {
    el,
    update,
    mounted() {
      // Erst jetzt hat die Karte ihre echte Größe
      map.invalidateSize();
      const z = zoneGeometryAt(gms(snap.game), effNow()) || snap.game.area?.geometry;
      if (z) fitGeometry(map, z, [30, 30], { paddingTopLeft: [20, 150], paddingBottomRight: [20, sheet.offsetHeight + 10] });
      fitAttr();
    },
    destroy() {
      clearInterval(timer);
      unsubPos();
      ro.disconnect();
      map.remove();
    },
  };
}

