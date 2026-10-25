// Screen 3: Spielgebiet festlegen (Kreis, eigene Form, Sperrzonen, gespeicherte Gebiete).
import { h, busy, toast, promptDialog, confirmDialog, setChildren } from '../../util/dom.js';
import { icon } from '../../util/icons.js';
import { meters } from '../../util/format.js';
import { normalizeSettings } from '../../core/engine.js';
import { circleFeature, validateArea, areaM2, fmtKm2, distanceM, destination, centroidOf } from '../../core/geo.js';
import { computeZoneStages, roundGeometry } from '../../core/zone.js';
import { createMap, loadGeoman, outsideMask, polygonLayer, fitGeometry, labelMarker, escapeHtml } from '../map.js';
import { header, seg, tiles, range } from '../components.js';

const R_MIN = 200, R_MAX = 5000;
const toSlider = (r) => Math.round((1000 * Math.log(r / R_MIN)) / Math.log(R_MAX / R_MIN));
const fromSlider = (v) => {
  const r = R_MIN * (R_MAX / R_MIN) ** (v / 1000);
  return r < 1000 ? Math.round(r / 10) * 10 : Math.round(r / 50) * 50;
};

export function areaScreen(ctx) {
  const L = window.L;
  const game = ctx.snap().game;
  const settings = normalizeSettings(game.settings);
  const existing = game.area;
  const myPos = ctx.pos();

  let mode = existing && existing.properties?.shape !== 'circle' ? 'polygon' : 'circle';
  const circle = existing?.properties?.shape === 'circle'
    ? { center: { lon: existing.properties.center[0], lat: existing.properties.center[1] }, radius: existing.properties.radius_m, fromUser: true }
    : { center: existing ? centroidOf(existing) : myPos || ctx.cfg.DEFAULT_CENTER, radius: 800, fromUser: !!existing || !!myPos };
  let polyLayer = null;
  let exclusions = (game.exclusions || []).map((f) => ({ feature: f, layer: null }));
  let drawing = null; // 'area' | 'exclusion'
  let vertexCount = 0;
  let saved = null;
  let stagesInfo = { stages: [], warnings: [] };
  let map;
  let destroyed = false;

  const el = h('div', { class: 'mapscr' });
  const mapEl = h('div', { class: 'map half' });
  const panel = h('div', { class: 'panel' });
  const stepEl = h('span', { class: 'step' });
  el.append(mapEl, header({ floaty: true, onBack: () => ctx.setHostStep('settings'), title: 'Spielgebiet', step: '' }), panel);
  el.querySelector('.hdr .ht').replaceChildren(h('h2', {}, 'Spielgebiet'), stepEl);

  // Kartenebenen
  let mask = null, circleLayer = null, centerMarker = null, handleMarker = null, radiusLabel = null;
  let stagesGroup = null, exclGroup = null;

  function currentArea() {
    if (mode === 'circle') return circleFeature(circle.center, circle.radius);
    if (!polyLayer) return null;
    const f = polyLayer.toGeoJSON();
    return { type: 'Feature', properties: { shape: 'polygon' }, geometry: roundGeometry(f.geometry) };
  }

  function redrawMask() {
    if (!map) return;
    if (mask) mask.remove();
    mask = null;
    const a = currentArea();
    if (a) mask = outsideMask(a.geometry).addTo(map);
    mask?.bringToBack();
  }

  let stageTimer = null;
  function scheduleStages() {
    clearTimeout(stageTimer);
    stageTimer = setTimeout(() => {
      if (destroyed) return;
      stagesGroup.clearLayers();
      const a = currentArea();
      stagesInfo = a && settings.shrink_enabled ? computeZoneStages(a, settings) : { stages: [], warnings: [] };
      stagesInfo.stages.slice(1).forEach((st) => polygonLayer(st.geometry, 'lf-stage').addTo(stagesGroup));
      renderStageBox();
    }, 350);
  }

  function changed() {
    redrawMask();
    scheduleStages();
    renderPanel();
  }

  // ---------- Kreis ----------
  function handlePos() {
    return destination(circle.center, circle.radius, 45);
  }
  function showCircle() {
    hideCircle();
    const ll = [circle.center.lat, circle.center.lon];
    circleLayer = L.circle(ll, { radius: circle.radius, className: 'lf-bound', interactive: false }).addTo(map);
    centerMarker = L.marker(ll, { draggable: true, icon: L.divIcon({ className: 'lf-plain', html: '<div class="lf-center"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), title: 'Mittelpunkt verschieben' }).addTo(map);
    const hp = handlePos();
    handleMarker = L.marker([hp.lat, hp.lon], { draggable: true, icon: L.divIcon({ className: 'lf-plain', html: '<div class="lf-handle"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), title: 'Radius ändern' }).addTo(map);
    radiusLabel = labelMarker(hp, meters(circle.radius), 'ac', -40).addTo(map);
    centerMarker.on('drag', (e) => {
      const p = e.target.getLatLng();
      circle.center = { lat: p.lat, lon: p.lng };
      circle.fromUser = true;
      syncCircle();
    });
    centerMarker.on('dragend', changed);
    handleMarker.on('drag', (e) => {
      const p = e.target.getLatLng();
      circle.radius = Math.max(R_MIN, Math.min(R_MAX, Math.round(distanceM(circle.center, { lat: p.lat, lon: p.lng }) / 10) * 10));
      circleLayer.setRadius(circle.radius);
      radiusLabel.setLatLng(p);
      radiusLabel.setIcon(labelIcon(meters(circle.radius)));
      updateRadiusUi();
    });
    handleMarker.on('dragend', () => { syncCircle(); changed(); });
  }
  function labelIcon(text) {
    return L.divIcon({ className: 'lf-plain', html: `<span class="lf-label ac" style="margin-top:-40px">${escapeHtml(text)}</span>`, iconSize: [0, 0] });
  }
  function syncCircle() {
    if (!circleLayer) return;
    circleLayer.setLatLng([circle.center.lat, circle.center.lon]);
    circleLayer.setRadius(circle.radius);
    const hp = handlePos();
    handleMarker.setLatLng([hp.lat, hp.lon]);
    radiusLabel.setLatLng([hp.lat, hp.lon]);
    radiusLabel.setIcon(labelIcon(meters(circle.radius)));
    updateRadiusUi();
  }
  function hideCircle() {
    for (const l of [circleLayer, centerMarker, handleMarker, radiusLabel]) l?.remove();
    circleLayer = centerMarker = handleMarker = radiusLabel = null;
  }
  let radiusVal = null, radiusSlider = null;
  function updateRadiusUi() {
    if (radiusVal) radiusVal.textContent = meters(circle.radius);
    if (radiusSlider && document.activeElement !== radiusSlider) {
      radiusSlider.value = toSlider(circle.radius);
      radiusSlider.style.setProperty('--p', `${radiusSlider.value / 10}%`);
    }
  }

  // ---------- Form (Leaflet-Geoman) ----------
  function wirePolygon(layer) {
    polyLayer = layer;
    layer.pm.enable({ allowSelfIntersection: false, draggable: false, removeVertexOn: 'contextmenu' });
    for (const ev of ['pm:edit', 'pm:vertexremoved', 'pm:markerdragend', 'pm:vertexadded']) layer.on(ev, changed);
  }
  function startDraw(kind) {
    if (!map) return; // Karte lädt noch
    if (drawing) map.pm.disableDraw();
    drawing = kind;
    vertexCount = 0;
    if (kind === 'area' && polyLayer) { polyLayer.remove(); polyLayer = null; redrawMask(); }
    if (polyLayer) polyLayer.pm.disable();
    map.pm.enableDraw('Polygon', {
      snappable: false,
      allowSelfIntersection: false,
      finishOn: null,
      tooltips: false,
      pathOptions: { className: kind === 'area' ? 'lf-bound' : 'lf-excl' },
      templineStyle: { color: kind === 'area' ? '#4c9aff' : '#f87171' },
      hintlineStyle: { color: kind === 'area' ? '#4c9aff' : '#f87171', dashArray: [5, 5] },
    });
    renderPanel();
  }
  function stopDraw() {
    map.pm.disableDraw();
    drawing = null;
    if (polyLayer) polyLayer.pm.enable({ allowSelfIntersection: false, draggable: false, removeVertexOn: 'contextmenu' });
    renderPanel();
  }
  function undoVertex() {
    const d = map.pm.Draw.Polygon;
    if (d && typeof d._removeLastVertex === 'function') d._removeLastVertex();
    vertexCount = Math.max(0, vertexCount - 1);
    renderPanel();
  }
  function finishDraw() {
    if (vertexCount < 3) return toast('Setze mindestens drei Punkte.', 'bad');
    const d = map.pm.Draw.Polygon;
    if (d && typeof d._finishShape === 'function') d._finishShape();
  }
  async function onCreate(e) {
    if (e.shape !== 'Polygon') return;
    const kind = drawing;
    drawing = null;
    map.pm.disableDraw();
    if (kind === 'exclusion') {
      e.layer.pm.disable();
      const name = (await promptDialog('Sperrzone benennen', { label: 'Zum Beispiel „Bahngleise“ oder „Privatgelände“', value: `Sperrzone ${exclusions.length + 1}`, okLabel: 'Speichern' })) || `Sperrzone ${exclusions.length + 1}`;
      e.layer.remove();
      const f = e.layer.toGeoJSON();
      const feature = { type: 'Feature', properties: { name: name.slice(0, 40) }, geometry: roundGeometry(f.geometry) };
      exclusions.push({ feature, layer: null });
      drawExclusions();
      if (polyLayer) polyLayer.pm.enable({ allowSelfIntersection: false, draggable: false, removeVertexOn: 'contextmenu' });
    } else {
      wirePolygon(e.layer);
    }
    changed();
  }
  function drawExclusions() {
    exclGroup.clearLayers();
    exclusions.forEach((x) => {
      x.layer = polygonLayer(x.feature.geometry, 'lf-excl').addTo(exclGroup);
      labelMarker(centroidOf(x.feature.geometry), x.feature.properties?.name || 'Sperrzone', 'bad').addTo(exclGroup);
    });
  }

  // ---------- Modus wechseln ----------
  function setMode(m) {
    if (drawing) stopDraw();
    mode = m === 'saved' ? mode : m;
    panelMode = m;
    if (m === 'circle') {
      if (polyLayer) {
        polyLayer.pm.disable();
        polyLayer.remove();
      }
      showCircle();
    } else if (m === 'polygon') {
      hideCircle();
      if (polyLayer) {
        polyLayer.addTo(map);
        polyLayer.pm.enable({ allowSelfIntersection: false, draggable: false, removeVertexOn: 'contextmenu' });
      } else {
        startDraw('area');
      }
    } else if (m === 'saved' && !saved) {
      ctx.backend.listSavedAreas().then((list) => { saved = list; renderPanel(); }).catch((err) => { saved = []; toast(err.message, 'bad'); });
    }
    changed();
  }
  let panelMode = mode;

  function loadSaved(item) {
    const a = item.area;
    exclusions = (item.exclusions || []).map((f) => ({ feature: f, layer: null }));
    drawExclusions();
    if (a.properties?.shape === 'circle') {
      circle.center = { lon: a.properties.center[0], lat: a.properties.center[1] };
      circle.radius = a.properties.radius_m;
      circle.fromUser = true;
      if (polyLayer) { polyLayer.remove(); polyLayer = null; }
      mode = 'circle';
      setMode('circle');
    } else {
      hideCircle();
      if (polyLayer) polyLayer.remove();
      const layer = L.polygon(a.geometry.coordinates.map((r) => r.map(([x, y]) => [y, x])), { className: 'lf-bound' }).addTo(map);
      mode = 'polygon';
      wirePolygon(layer);
      setMode('polygon');
    }
    fitGeometry(map, a.geometry, [30, 30]);
    toast(`„${item.name}“ geladen`);
  }

  // ---------- Panel ----------
  // Die Zonen-Vorschau wird separat aktualisiert, damit das Panel nicht unter dem Finger neu gebaut wird.
  const stageBox = h('div', { class: 'stack' });
  function renderStageBox() {
    const st = stagesInfo.stages;
    if (!settings.shrink_enabled || !currentArea()) return stageBox.replaceChildren();
    setChildren(stageBox, h('div', { class: 'card tight' },
      h('div', { class: 'row between' }, h('b', {}, 'Vorschau schrumpfende Zone'), h('span', { class: 'pill warn' }, st.length ? `${Math.max(0, st.length - 1)} Stufen` : 'rechnet …')),
      h('p', { class: 'sub' }, st.length > 1 ? `Gestrichelt auf der Karte. Am Ende noch ${fmtKm2(st[st.length - 1].area_m2)} (${Math.round((st[st.length - 1].area_m2 / st[0].area_m2) * 100)} %).` : st.length ? 'Bei dieser Spieldauer schrumpft die Zone nicht.' : ''),
      stagesInfo.warnings.map((w) => h('p', { class: 'sub', style: { color: 'var(--warn)' } }, `⚠ ${w}`))));
  }

  function renderPanel() {
    if (destroyed) return;
    stepEl.textContent = `Schritt 2 von 3 · ${panelMode === 'circle' ? 'Kreis' : panelMode === 'polygon' ? 'Eigene Form' : 'Gespeicherte Gebiete'}`;
    const area = currentArea();
    const v = area ? validateArea(area) : { errors: ['Zeichne zuerst eine Form.'], warnings: [] };
    const parts = [seg({
      options: [{ label: 'Kreis', value: 'circle' }, { label: 'Form zeichnen', value: 'polygon' }, { label: 'Gespeichert', value: 'saved' }],
      value: panelMode, onChange: setMode, label: 'Art des Spielgebiets',
    })];

    if (drawing) {
      parts.push(h('div', { class: 'card tight', style: { background: drawing === 'exclusion' ? 'var(--bad-soft)' : 'var(--ac-soft)' } },
        h('b', {}, drawing === 'exclusion' ? 'Sperrzone zeichnen' : 'Grenze zeichnen'),
        h('p', { class: 'sub' }, `Tippe Punkte auf die Karte (${vertexCount} gesetzt). Zum Schließen auf den ersten Punkt tippen oder „Fertig“.`)),
      h('div', { class: 'three' },
        h('button', { class: 'btn sec sm', html: `${icon('undo', 16)} Zurück`, onclick: undoVertex }),
        h('button', { class: 'btn sec sm', html: `${icon('close', 16)} Abbrechen`, onclick: () => { stopDraw(); if (panelMode === 'polygon' && !polyLayer) setMode('circle'); } }),
        h('button', { class: 'btn pri sm', html: `${icon('check', 16)} Fertig`, onclick: finishDraw })));
      setChildren(panel, ...parts);
      return;
    }

    if (panelMode === 'saved') {
      const saveBtn = h('button', { class: 'btn sec', html: `${icon('save', 18)} Aktuelles Gebiet speichern` });
      saveBtn.addEventListener('click', busy(saveBtn, async () => {
        if (!area || v.errors.length) throw new Error(v.errors[0] || 'Kein Gebiet.');
        const name = await promptDialog('Gebiet speichern', { label: 'Name, z. B. „Stadtpark“', okLabel: 'Speichern' });
        if (!name) return;
        await ctx.backend.saveArea(name.slice(0, 40), area, exclusions.map((x) => x.feature));
        saved = await ctx.backend.listSavedAreas();
        toast('Gespeichert');
        renderPanel();
      }));
      parts.push(saveBtn, h('span', { class: 'lbl' }, 'Gespeicherte Gebiete'));
      if (!saved) parts.push(h('p', { class: 'sub' }, 'Lädt …'));
      else if (!saved.length) parts.push(h('p', { class: 'empty' }, 'Noch keine gespeicherten Gebiete.'));
      else parts.push(h('div', { class: 'card list' }, saved.map((s) => h('div', { class: 'pl' },
        h('div', { class: 'ico-b sm', html: icon(s.area.properties?.shape === 'circle' ? 'circle' : 'area', 18) }),
        h('div', { class: 'grow' }, h('b', {}, s.name), h('small', {}, `${s.area.properties?.shape === 'circle' ? `Kreis ${meters(s.area.properties.radius_m)}` : `Form ${fmtKm2(areaM2(s.area))}`}${s.exclusions?.length ? ` · ${s.exclusions.length} Sperrzone(n)` : ''}`)),
        h('button', { class: 'btn sec sm', style: { width: 'auto' }, onclick: () => loadSaved(s) }, 'Laden'),
        h('button', { class: 'ib sm', 'aria-label': `${s.name} löschen`, html: icon('trash', 16), onclick: async () => {
          if (!(await confirmDialog('Löschen?', `„${s.name}“ wird gelöscht.`, 'Löschen', true))) return;
          await ctx.backend.deleteSavedArea(s.id).catch((e) => toast(e.message, 'bad'));
          saved = saved.filter((x) => x.id !== s.id);
          renderPanel();
        } })))));
      setChildren(panel, ...parts);
      return;
    }

    if (panelMode === 'circle') {
      radiusVal = h('span', { class: 'val big' }, meters(circle.radius));
      radiusSlider = range({ min: 0, max: 1000, step: 1, value: circle.radius, label: 'Radius', toSlider, fromSlider, onInput: (r) => { circle.radius = r; circle.fromUser = true; syncCircle(); } });
      radiusSlider.addEventListener('change', changed);
      const meBtn = h('button', { class: 'btn sec sm', html: `${icon('locate', 16)} Mittelpunkt: mein Standort` });
      meBtn.addEventListener('click', () => {
        const p = ctx.pos();
        if (!p) return toast('Noch kein Standort. Erlaube den Standortzugriff.', 'bad');
        circle.center = { lat: p.lat, lon: p.lon };
        circle.fromUser = true;
        syncCircle();
        map?.setView([p.lat, p.lon]);
        changed();
      });
      parts.push(
        h('div', { class: 'cl' }, h('span', { class: 'lbl' }, 'Radius'), radiusVal), radiusSlider,
        h('div', { class: 'scale' }, h('span', {}, '200 m'), h('span', {}, '1 km'), h('span', {}, '5 km')),
        h('p', { class: 'sub' }, 'Tippe auf die Karte, um den Mittelpunkt zu setzen. Am weißen Griff ziehst du den Radius.'),
        meBtn);
    } else {
      parts.push(h('div', { class: 'two' },
        h('button', { class: 'btn sec sm', html: `${icon('edit', 16)} Neu zeichnen`, onclick: () => startDraw('area') }),
        h('button', { class: 'btn sec sm', html: `${icon('area', 16)} Ganze Form zeigen`, onclick: () => area && fitGeometry(map, area.geometry, [30, 30]) })),
      h('p', { class: 'sub' }, 'Punkte ziehen zum Verschieben, lange drücken zum Löschen. Ein Tipp auf den Mittelpunkt einer Linie fügt einen Punkt ein.'));
    }

    parts.push(h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Sperrzonen'), h('span', { class: `pill ${exclusions.length ? 'bad' : ''}` }, exclusions.length ? `${exclusions.length} aktiv` : 'keine')));
    exclusions.forEach((x, i) => parts.push(h('div', { class: 'row', style: { background: 'var(--card)', borderRadius: '16px', padding: '10px 12px', border: '1px solid var(--bad)' } },
      h('span', { style: { width: '26px', height: '26px', borderRadius: '8px', flex: 'none', background: 'repeating-linear-gradient(45deg,var(--bad-soft) 0 4px,var(--bad) 4px 6px)' } }),
      h('div', { class: 'grow' }, h('b', {}, x.feature.properties?.name || `Sperrzone ${i + 1}`), h('small', {}, `${fmtKm2(areaM2(x.feature))} · Betreten verboten, Warnung mit Countdown`)),
      h('button', { class: 'ib sm', 'aria-label': 'Sperrzone löschen', html: icon('trash', 16), onclick: () => { exclusions.splice(i, 1); drawExclusions(); renderPanel(); } }))));
    parts.push(h('button', { class: 'btn sec', html: `${icon('plus', 18)} Sperrzone zeichnen`, disabled: exclusions.length >= 20, onclick: () => startDraw('exclusion') }));

    const pointCount = mode === 'polygon' && polyLayer ? polyLayer.getLatLngs()[0].length : null;
    parts.push(tiles([
      { lbl: 'Fläche', v: area ? fmtKm2(areaM2(area)) : '–' },
      mode === 'circle' ? { lbl: 'Mittelpunkt', v: circle.fromUser ? 'gesetzt' : 'Karte' } : { lbl: 'Punkte', v: pointCount ?? '–' },
      { lbl: 'Warnzeit', v: `${settings.boundary_warn_s} s` },
    ], 'on-bg'));

    renderStageBox();
    parts.push(stageBox);
    if (v.errors.length || v.warnings.length) {
      parts.push(h('div', { class: `card tight ${v.errors.length ? 'badbox' : 'warnbox'}` },
        [...v.errors, ...v.warnings].map((t) => h('p', { class: 'sub', style: { color: 'var(--tx)' } }, t))));
    }
    const ok = h('button', { class: 'btn pri', disabled: !!v.errors.length }, 'Gebiet übernehmen');
    ok.addEventListener('click', busy(ok, async () => {
      const a = currentArea();
      const vv = validateArea(a);
      if (vv.errors.length) throw new Error(vv.errors[0]);
      const zs = computeZoneStages(a, settings);
      await ctx.backend.updateGame({ area: a, exclusions: exclusions.map((x) => x.feature), zone_stages: zs.stages });
      ctx.setHostStep('waiting');
    }));
    parts.push(ok);
    setChildren(panel, ...parts);
  }

  // ---------- Start ----------
  (async () => {
    try {
      await loadGeoman();
    } catch (e) {
      toast(e.message, 'bad');
    }
    if (destroyed) return;
    map = createMap(mapEl, { center: circle.center, zoom: 15 });
    try { map.pm.setLang('de'); } catch { /* egal */ }
    map.pm.setGlobalOptions({ snappable: false, allowSelfIntersection: false });
    stagesGroup = L.layerGroup().addTo(map);
    exclGroup = L.layerGroup().addTo(map);
    map.on('pm:create', onCreate);
    map.on('pm:drawstart', ({ workingLayer }) => {
      workingLayer.on('pm:vertexadded', () => { vertexCount++; renderPanel(); });
    });
    map.on('click', (e) => {
      if (drawing || mode !== 'circle' || panelMode === 'saved') return;
      circle.center = { lat: e.latlng.lat, lon: e.latlng.lng };
      circle.fromUser = true;
      syncCircle();
      changed();
    });
    drawExclusions();
    if (mode === 'circle') showCircle();
    else {
      const layer = L.polygon(existing.geometry.coordinates.map((r) => r.map(([x, y]) => [y, x])), { className: 'lf-bound' }).addTo(map);
      wirePolygon(layer);
    }
    const a = currentArea();
    if (a) fitGeometry(map, a.geometry, [30, 30]);
    changed();
  })();

  const unsub = ctx.onPos((p) => {
    // Erster Standort: Kreis dorthin setzen, solange der Host noch nichts gewählt hat
    if (p && !circle.fromUser && mode === 'circle' && map) {
      circle.center = { lat: p.lat, lon: p.lon };
      circle.fromUser = true;
      syncCircle();
      map.setView([p.lat, p.lon], 15);
      changed();
    }
  });

  renderPanel();
  return {
    el,
    update() {},
    destroy() {
      destroyed = true;
      unsub();
      clearTimeout(stageTimer);
      map?.remove();
    },
  };
}
