// Tests für die reine Spiel-Logik (läuft mit: node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceM, destination, bearingDeg, compass, boundaryStatus, circleFeature, polygonFeature,
  areaM2, validateArea, distanceToBoundaryM, isValidLatLon, randomPointInGeometry, pointInGeometry,
} from '../web/js/core/geo.js';
import { buildPing, offsetCircleCenter, roundDistance, directionText } from '../web/js/core/ping.js';
import { kalmanUpdate } from '../web/js/core/kalman.js';
import { computeZoneStages, stageIndexAt } from '../web/js/core/zone.js';
import { normalizeSettings, processLocation, planTick, assignRoles, isPlanEmpty, DEFAULT_SETTINGS } from '../web/js/core/engine.js';
import { parseLocationRequest, parseTimestamp } from '../web/js/core/traccar.js';

const C = { lat: 50.1255, lon: 8.6630 }; // Frankfurt, Grüneburgpark
function seeded(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('Entfernung und Zielpunkt passen zusammen', () => {
  for (const b of [0, 45, 133, 270]) {
    const p = destination(C, 500, b);
    assert.ok(Math.abs(distanceM(C, p) - 500) < 0.5);
    assert.ok(Math.abs(((bearingDeg(C, p) - b + 540) % 360) - 180) < 0.5);
  }
});

test('Kompass rundet auf 8 bzw. 4 Richtungen', () => {
  assert.equal(compass(10).label, 'Nord');
  assert.equal(compass(40).label, 'Nordost');
  assert.equal(compass(350).label, 'Nord');
  assert.equal(compass(200).label, 'Süd');
  assert.equal(compass(100, 4).label, 'Ost');
});

test('Ungültige Koordinaten werden erkannt', () => {
  assert.equal(isValidLatLon(0, 0), false);
  assert.equal(isValidLatLon(91, 8), false);
  assert.equal(isValidLatLon(NaN, 8), false);
  assert.equal(isValidLatLon(50.1, 8.6), true);
});

test('Kreisfläche stimmt ungefähr', () => {
  const f = circleFeature(C, 800);
  const expected = Math.PI * 800 * 800;
  assert.ok(Math.abs(areaM2(f) - expected) / expected < 0.01);
  assert.equal(f.properties.shape, 'circle');
});

test('Grenzprüfung mit Toleranz und Genauigkeit', () => {
  const zone = circleFeature(C, 500).geometry;
  const inside = boundaryStatus({ ...destination(C, 300, 90), accuracy: 10 }, zone, [], 20);
  assert.equal(inside.violation, null);
  assert.ok(inside.edgeDistM > 190 && inside.edgeDistM < 210);
  // 25 m außerhalb, Genauigkeit 10 m: innerhalb von Toleranz (20) + Genauigkeit (10) -> keine Verletzung
  const near = boundaryStatus({ ...destination(C, 525, 90), accuracy: 10 }, zone, [], 20);
  assert.equal(near.violation, null);
  assert.ok(near.edgeDistM < 0);
  // 80 m außerhalb -> Verletzung
  const out = boundaryStatus({ ...destination(C, 580, 90), accuracy: 10 }, zone, [], 20);
  assert.equal(out.violation, 'outside');
});

test('Sperrzone wird erkannt', () => {
  const zone = circleFeature(C, 800).geometry;
  const ex = circleFeature(destination(C, 300, 0), 60);
  ex.properties.name = 'Gleise';
  const r = boundaryStatus({ ...destination(C, 300, 0), accuracy: 8 }, zone, [ex], 20);
  assert.equal(r.violation, 'exclusion');
  assert.equal(r.exclusion, 'Gleise');
  const r2 = boundaryStatus({ ...destination(C, 450, 0), accuracy: 8 }, zone, [ex], 20);
  assert.equal(r2.violation, null);
});

test('Gebietsprüfung: Selbstüberschneidung, zu klein, sehr groß', () => {
  const p1 = destination(C, 400, 315), p2 = destination(C, 400, 45), p3 = destination(C, 400, 225), p4 = destination(C, 400, 135);
  const bowtie = polygonFeature([p1, p2, p3, p4]);
  assert.ok(validateArea(bowtie).errors.some((e) => e.includes('kreuzt')));
  assert.ok(validateArea(circleFeature(C, 50)).errors.some((e) => e.includes('zu klein')));
  assert.ok(validateArea(circleFeature(C, 1500)).warnings.length === 1);
  assert.equal(validateArea(circleFeature(C, 600)).warnings.length, 0);
});

test('Ungefährer Kreis: echte Position liegt im Kreis, aber nie in der Mitte', () => {
  const rng = seeded(7);
  for (let i = 0; i < 2000; i++) {
    const c = offsetCircleCenter(C, 250, rng);
    const d = distanceM(c, C);
    assert.ok(d >= 0.25 * 250 - 0.5 && d <= 0.85 * 250 + 0.5, `Abstand ${d}`);
  }
  const p = buildPing('circle', C, { radiusM: 250 }, seeded(1));
  assert.equal(p.mode, 'circle');
  assert.equal(p.radius_m, 250);
  assert.ok(distanceM(p, C) > 50);
});

test('Joker "doppelter Kreis" verdoppelt den Radius', () => {
  assert.equal(buildPing('circle', C, { radiusM: 250, double: true }, seeded(2)).radius_m, 500);
  assert.equal(buildPing('exact', C, { double: true }, seeded(2)).mode, 'circle');
});

test('Richtungs-Ping rundet Richtung und Entfernung', () => {
  const target = destination(C, 437, 52);
  const p = buildPing('direction', target, { ref: C }, seeded(3));
  assert.equal(p.dir_label, 'Nordost');
  assert.equal(p.bearing_deg, 45);
  assert.equal(p.distance_m, 450);
  assert.equal(directionText(p), 'Nordost, ca. 450 m');
  assert.equal(p.lat, undefined);
  assert.equal(roundDistance(30), 50);
  assert.equal(roundDistance(1234), 1200);
  assert.equal(roundDistance(1234, true), 1200);
  assert.equal(roundDistance(4321), 4250);
});

test('Kalman-Filter glättet Rauschen und verwirft Sprünge', () => {
  const rng = seeded(11);
  let st = null;
  let rawErr = 0, kfErr = 0;
  for (let i = 0; i < 60; i++) {
    const noisy = destination(C, rng() * 15, rng() * 360);
    const r = kalmanUpdate(st, { ...noisy, accuracy: 10, at: 1_000_000 + i * 5000 });
    st = r.state;
    if (i > 10) { rawErr += distanceM(noisy, C); kfErr += distanceM(st, C); }
  }
  assert.ok(kfErr < rawErr * 0.75, `geglättet ${kfErr} vs roh ${rawErr}`);
  const jump = kalmanUpdate(st, { ...destination(C, 3000, 90), accuracy: 10, at: st.at + 5000 });
  assert.equal(jump.accepted, false);
  // Nach drei Ausreißern in Folge wird neu gestartet (z. B. echter Ortswechsel)
  let s2 = jump.state;
  for (let i = 0; i < 2; i++) s2 = kalmanUpdate(s2, { ...destination(C, 3000, 90), accuracy: 10, at: s2.at + 5000 * (i + 2) }).state;
  assert.ok(distanceM(s2, destination(C, 3000, 90)) < 1);
  // Echte Bewegung zu Fuß wird angenommen
  let w = kalmanUpdate(null, { ...C, accuracy: 8, at: 0 }).state;
  for (let i = 1; i <= 20; i++) w = kalmanUpdate(w, { ...destination(C, i * 15, 90), accuracy: 8, at: i * 5000 }).state;
  assert.ok(distanceM(w, destination(C, 300, 90)) < 40);
});

test('Schrumpfende Zone: Kreis wird pro Stufe ~10 % kleiner', () => {
  const area = circleFeature(C, 800);
  const { stages, warnings } = computeZoneStages(area, { shrink_enabled: true, shrink_every_s: 900, shrink_percent: 10, duration_s: 3600 });
  assert.equal(stages.length, 4); // 0, 15, 30, 45 min
  for (let i = 1; i < stages.length; i++) {
    const ratio = stages[i].area_m2 / stages[i - 1].area_m2;
    assert.ok(Math.abs(ratio - 0.9) < 0.01, `Verhältnis ${ratio}`);
  }
  assert.equal(warnings.length, 0);
  assert.equal(stageIndexAt(stages, 0), 0);
  assert.equal(stageIndexAt(stages, 31 * 60_000), 2);
});

test('Schrumpfende Zone: eigene Form per negativem Puffer', () => {
  const pts = [0, 60, 130, 200, 260, 320].map((b, i) => destination(C, 500 + (i % 2) * 150, b));
  const area = polygonFeature(pts);
  const { stages } = computeZoneStages(area, { shrink_enabled: true, shrink_every_s: 600, shrink_percent: 20, duration_s: 3600 });
  assert.ok(stages.length >= 4);
  for (let i = 1; i < stages.length; i++) {
    const ratio = stages[i].area_m2 / stages[0].area_m2;
    assert.ok(Math.abs(ratio - 0.8 ** i) < 0.04, `Stufe ${i}: ${ratio}`);
    // Jede Stufe liegt innerhalb der vorherigen
    const c = stages[i].geometry.coordinates[0][0];
    assert.ok(pointInGeometry({ lon: c[0], lat: c[1] }, stages[i - 1].geometry));
  }
});

test('Schrumpfende Zone warnt, wenn eine Hantel-Form zerfällt', () => {
  // Zwei große Felder, verbunden durch einen schmalen Gang
  const a = destination(C, 600, 270), b = destination(C, 600, 90);
  const box = (c, r) => [destination(destination(c, r, 0), r, 270), destination(destination(c, r, 0), r, 90), destination(destination(c, r, 180), r, 90), destination(destination(c, r, 180), r, 270)];
  const L = box(a, 300), R = box(b, 300);
  const gangN = destination(C, 20, 0), gangS = destination(C, 20, 180);
  const pts = [L[0], L[1], { lat: gangN.lat, lon: L[1].lon }, { lat: gangN.lat, lon: R[0].lon }, R[0], R[1], R[2], R[3], { lat: gangS.lat, lon: R[3].lon }, { lat: gangS.lat, lon: L[2].lon }, L[2], L[3]];
  const area = polygonFeature(pts);
  assert.equal(validateArea(area).errors.length, 0);
  const { warnings } = computeZoneStages(area, { shrink_enabled: true, shrink_every_s: 600, shrink_percent: 15, duration_s: 3600 });
  assert.ok(warnings.some((w) => w.includes('zerfällt')), JSON.stringify(warnings));
});

test('Einstellungen werden begrenzt', () => {
  const s = normalizeSettings({ ping_interval_s: 5, ping_mode: 'hack', duration_s: 99999, shrink_enabled: true });
  assert.equal(s.ping_interval_s, 60);
  assert.equal(s.ping_mode, DEFAULT_SETTINGS.ping_mode);
  assert.equal(s.duration_s, 6 * 3600);
  assert.equal(s.shrink_enabled, true);
});

function gameCtx(over = {}) {
  const t0 = 1_700_000_000_000;
  const area = circleFeature(C, 800);
  return {
    t0,
    game: {
      id: 'g1', status: 'running', settings: { ...DEFAULT_SETTINGS }, area, zone_stages: [{ at_s: 0, geometry: area.geometry }],
      zone_index: 0, exclusions: [], started_at: t0, hunt_starts_at: t0 + 600_000, ends_at: t0 + 600_000 + 3_600_000,
      next_ping_at: t0 + 600_000, ping_seq: 0, hunt_announced: false, ...over,
    },
  };
}

test('Standort: Filter für Genauigkeit, Alter und Koordinaten', () => {
  const { game, t0 } = gameCtx();
  const player = { id: 'h1', role: 'hider', status: 'active' };
  const now = t0 + 1000;
  assert.equal(processLocation({ game, player, priv: null }, { ...C, accuracy: 80, at: now }, now).accepted, false);
  assert.equal(processLocation({ game, player, priv: null }, { ...C, accuracy: 10, at: now - 10 * 60_000 }, now).accepted, false);
  assert.equal(processLocation({ game, player, priv: null }, { lat: 0, lon: 0, accuracy: 10, at: now }, now).accepted, false);
  const ok = processLocation({ game, player, priv: null }, { ...C, accuracy: 10, at: now }, now);
  assert.equal(ok.accepted, true);
  assert.equal(ok.boundary.violation, null);
  assert.deepEqual(ok.oob, { since: null, deadline: null });
});

test('Standort: Gejagter außerhalb bekommt Countdown, Sucher nur Warnung', () => {
  const { game, t0 } = gameCtx();
  const now = t0 + 5000;
  const far = { ...destination(C, 1000, 45), accuracy: 8, at: now };
  const h = processLocation({ game, player: { id: 'h1', role: 'hider', status: 'active' }, priv: null }, far, now);
  assert.equal(h.boundary.violation, 'outside');
  assert.equal(h.oob.since, now);
  assert.equal(h.oob.deadline, now + 30_000);
  const k = processLocation({ game, player: { id: 'k1', role: 'hunter', status: 'active' }, priv: null }, far, now);
  assert.equal(k.oob.deadline, null);
  // Bleibt außerhalb: Countdown läuft weiter, wird nicht neu gestartet
  const priv = { kf_lat: h.kf.lat, kf_lon: h.kf.lon, kf_var: h.kf.var, kf_at: h.kf.at, oob_since: h.oob.since, oob_deadline: h.oob.deadline };
  const h2 = processLocation({ game, player: { id: 'h1', role: 'hider', status: 'active' }, priv }, { ...far, at: now + 5000 }, now + 5000);
  assert.equal(h2.oob.deadline, now + 30_000);
});

function tickCtx(mode = 'circle', extra = {}) {
  const base = gameCtx(extra.game || {});
  base.game.settings = { ...DEFAULT_SETTINGS, ping_mode: mode, ...(extra.settings || {}) };
  const now = base.t0 + 600_000 + 1000;
  const hiderPos = destination(C, 300, 120);
  const ctx = {
    game: base.game,
    players: [
      { id: 'h1', name: 'Mia', role: 'hider', status: 'active' },
      { id: 'h2', name: 'Tom', role: 'hider', status: 'found' },
      { id: 'k1', name: 'Ben', role: 'hunter', status: 'active' },
      { id: 'k2', name: 'Eric', role: 'hunter', status: 'active' },
    ],
    privs: {
      h1: { kf_lat: hiderPos.lat, kf_lon: hiderPos.lon, kf_at: now - 4000, ...(extra.h1 || {}) },
      h2: { kf_lat: C.lat, kf_lon: C.lon, kf_at: now - 4000 },
      k1: { kf_lat: C.lat, kf_lon: C.lon, kf_at: now - 2000 },
      k2: null,
    },
  };
  return { ctx, now, hiderPos };
}

test('Tick: erster Ping nach dem Vorsprung, nur für aktive Gejagte, ohne echte Position', () => {
  const { ctx, now, hiderPos } = tickCtx('circle');
  const plan = planTick(ctx, now, seeded(5));
  assert.equal(plan.announce_hunt, true);
  assert.equal(plan.new_seq, 1);
  assert.equal(plan.pings.length, 1);
  const p = plan.pings[0];
  assert.equal(p.hider_id, 'h1');
  assert.equal(p.mode, 'circle');
  assert.ok(distanceM(p, hiderPos) > 0.2 * 250);
  assert.ok(distanceM(p, hiderPos) < 250);
  assert.equal(plan.next_ping_at, ctx.game.next_ping_at + 300_000);
});

test('Tick: vor Ablauf des Vorsprungs passiert nichts', () => {
  const { ctx } = tickCtx('circle');
  const plan = planTick(ctx, ctx.game.started_at + 60_000, seeded(5));
  assert.ok(isPlanEmpty(plan));
});

test('Tick: Richtungs-Ping je Sucher, Bezugspunkt Mittelpunkt ohne Signal', () => {
  const { ctx, now } = tickCtx('direction');
  const plan = planTick(ctx, now, seeded(5));
  assert.equal(plan.pings.length, 2);
  const forBen = plan.pings.find((p) => p.recipient_id === 'k1');
  const forEric = plan.pings.find((p) => p.recipient_id === 'k2');
  assert.equal(forBen.ref_is_center, false);
  assert.equal(forEric.ref_is_center, true);
  assert.equal(forBen.lat, undefined);
  assert.ok(['Südost', 'Ost', 'Süd'].includes(forBen.dir_label));
});

test('Tick: exakter Punkt', () => {
  const { ctx, now, hiderPos } = tickCtx('exact');
  const p = planTick(ctx, now, seeded(5)).pings[0];
  assert.ok(distanceM(p, hiderPos) < 1);
});

test('Tick: Joker überspringen, doppelt, falscher Ort', () => {
  const settings = { joker_skip: true, joker_double: true, joker_decoy: true };
  let { ctx, now, hiderPos } = tickCtx('circle', { settings, h1: { joker_pending: 'skip' } });
  let plan = planTick(ctx, now, seeded(5));
  assert.equal(plan.pings[0].kind, 'joker_skip');
  assert.deepEqual(plan.consumed_jokers, ['h1']);
  ({ ctx, now } = tickCtx('circle', { settings, h1: { joker_pending: 'double' } }));
  assert.equal(planTick(ctx, now, seeded(5)).pings[0].radius_m, 500);
  ({ ctx, now, hiderPos } = tickCtx('circle', { settings, h1: { joker_pending: 'decoy' } }));
  plan = planTick(ctx, now, seeded(5));
  assert.equal(plan.pings[0].decoy, true);
  assert.equal(plan.pings[0].joker, null);
  assert.ok(distanceM(plan.pings[0], hiderPos) > 300 - 250 * 0.85);
  // Deaktivierter Joker wird verbraucht, aber nicht angewendet
  ({ ctx, now } = tickCtx('circle', { settings: { joker_skip: false }, h1: { joker_pending: 'skip' } }));
  plan = planTick(ctx, now, seeded(5));
  assert.equal(plan.pings[0].kind, 'regular');
});

test('Tick: Strafe außerhalb (Extra-Ping oder Ausscheiden)', () => {
  let { ctx, now } = tickCtx('circle', { game: { hunt_announced: true, next_ping_at: Date.now() * 2 }, h1: { oob_since: 1, oob_deadline: 1_700_000_600_500 } });
  let plan = planTick(ctx, now, seeded(5));
  assert.equal(plan.penalties[0].type, 'extra_ping');
  assert.equal(plan.pings[0].kind, 'penalty');
  assert.equal(plan.new_seq, null);
  ({ ctx, now } = tickCtx('circle', { settings: { boundary_penalty: 'eliminate' }, game: { hunt_announced: true }, h1: { oob_since: 1, oob_deadline: 1_700_000_600_500 } }));
  plan = planTick(ctx, now, seeded(5));
  assert.equal(plan.penalties[0].type, 'eliminate');
  assert.equal(plan.pings.length, 0); // ausgeschieden -> kein regulärer Ping mehr
});

test('Tick: Zeit abgelaufen -> Gejagte gewinnen', () => {
  const { ctx } = tickCtx('circle');
  const plan = planTick(ctx, ctx.game.ends_at + 1, seeded(5));
  assert.deepEqual(plan.end, { winner: 'hiders', reason: 'time' });
  assert.equal(plan.pings.length, 0);
});

test('Tick: Zone schrumpft nach Zeitplan', () => {
  const area = circleFeature(C, 800);
  const { stages } = computeZoneStages(area, { shrink_enabled: true, shrink_every_s: 900, shrink_percent: 10, duration_s: 3600 });
  const { ctx } = tickCtx('circle', { game: { zone_stages: stages, hunt_announced: true } });
  const plan = planTick(ctx, ctx.game.hunt_starts_at + 16 * 60_000, seeded(5));
  assert.equal(plan.zone_index, 1);
});

test('Rollen zufällig verteilen', () => {
  const ps = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, role: 'random' }));
  const r = assignRoles(ps, 'choose', seeded(9)).roles;
  assert.equal(Object.values(r).filter((x) => x === 'hunter').length, 2);
  const fixed = assignRoles([{ id: 'a', role: 'hunter' }, { id: 'b', role: 'hunter' }, { id: 'c', role: 'random' }], 'choose', seeded(1)).roles;
  assert.equal(fixed.c, 'hider');
  assert.ok(assignRoles([{ id: 'a', role: 'hider' }, { id: 'b', role: 'hider' }], 'choose').error);
  const all = assignRoles([{ id: 'a', role: 'hider' }, { id: 'b', role: 'hider' }, { id: 'c', role: 'hider' }], 'random', seeded(3)).roles;
  assert.equal(Object.values(all).filter((x) => x === 'hunter').length, 1);
});

test('Traccar: neues JSON-Format', () => {
  const body = JSON.stringify({
    location: { timestamp: '2026-04-11T14:14:59.970Z', coords: { latitude: 50.1, longitude: 8.6, accuracy: 7.5, speed: 1 }, is_moving: true, battery: { level: 0.5 } },
    device_id: 'a'.repeat(64),
  });
  const r = parseLocationRequest({ method: 'POST', url: 'https://x.supabase.co/functions/v1/location', contentType: 'application/json; charset=utf-8', bodyText: body });
  assert.equal(r.token, 'a'.repeat(64));
  assert.equal(r.lat, 50.1);
  assert.equal(r.accuracy, 7.5);
  assert.equal(r.at, Date.parse('2026-04-11T14:14:59.970Z'));
  assert.equal(r.source, 'traccar');
});

test('Traccar: OsmAnd-Parameter in der URL und als Formular', () => {
  const r = parseLocationRequest({ method: 'POST', url: 'https://x/functions/v1/location?id=tok&lat=50.1&lon=8.6&timestamp=1609459200&hdop=2', contentType: '', bodyText: '' });
  assert.equal(r.token, 'tok');
  assert.equal(r.at, 1609459200000);
  assert.equal(r.accuracy, 10);
  const f = parseLocationRequest({ method: 'POST', url: 'https://x/l', contentType: 'application/x-www-form-urlencoded', bodyText: 'deviceid=t2&location=50.2,8.7&accuracy=12&timestamp=2026-01-02%2010:00:00' });
  assert.equal(f.token, 't2');
  assert.equal(f.lat, 50.2);
  assert.equal(f.at, Date.parse('2026-01-02T10:00:00Z'));
});

test('Web-App-Format wird als Quelle "web" erkannt', () => {
  const r = parseLocationRequest({ method: 'POST', url: 'https://x/l', contentType: 'application/json', bodyText: JSON.stringify({ id: 'tok', lat: 50, lon: 8, accuracy: 9, timestamp: 1700000000000, source: 'web' }) });
  assert.equal(r.source, 'web');
  assert.equal(r.at, 1700000000000);
  assert.equal(parseTimestamp('nonsense'), null);
});

test('Zufallspunkt liegt im Gebiet', () => {
  const zone = circleFeature(C, 500).geometry;
  const rng = seeded(4);
  for (let i = 0; i < 50; i++) {
    const p = randomPointInGeometry(zone, rng, C, 100, 400);
    assert.ok(pointInGeometry(p, zone));
    assert.ok(distanceToBoundaryM(p, zone) >= 0);
  }
});

test('Einstellungen: Nicht-Zahlen fallen auf den Standard zurück (wie in SQL)', () => {
  for (const bad of [null, true, '120', '', []]) assert.equal(normalizeSettings({ ping_interval_s: bad }).ping_interval_s, DEFAULT_SETTINGS.ping_interval_s);
  assert.equal(normalizeSettings({ retention_h: 500 }).retention_h, 72);
});

test('Extra-Ping-Strafe wird erst ab Jagdbeginn verhängt', () => {
  const now = 1_000_000_000_000;
  const mk = (huntStartsAt) => ({
    game: { id: 'g', status: 'running', settings: { boundary_penalty: 'extra_ping' }, area: null, zone_stages: [], exclusions: [], started_at: now - 5000, hunt_starts_at: huntStartsAt, next_ping_at: null, ends_at: now + 3_600_000, ping_seq: 0, hunt_announced: true },
    players: [{ id: 'h', name: 'H', role: 'hider', status: 'active' }, { id: 'k', name: 'K', role: 'hunter', status: 'active' }],
    privs: { h: { oob_deadline: now - 1, lat: null }, k: {} },
  });
  assert.equal(planTick(mk(now + 60_000), now, seeded()).penalties.length, 0);
  assert.equal(planTick(mk(now - 60_000), now, seeded()).penalties.length, 1);
});

test('Service Worker kennt alle App-Module (Offline nach dem ersten Besuch)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const sw = fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const base = new URL('../web/', import.meta.url).pathname;
  for (const f of walk(path.join(base, 'js')).filter((x) => x.endsWith('.js'))) {
    const rel = path.relative(base, f);
    assert.ok(sw.includes(`'${rel}'`), `${rel} fehlt in sw.js`);
  }
});
