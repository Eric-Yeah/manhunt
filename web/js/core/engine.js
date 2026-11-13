// Spielregeln als reine Funktionen. Werden von den Edge Functions (echtes Spiel)
// und vom Demo-Modus (Simulation im Browser) gleichermaßen benutzt.
// Alle Zeiten in Millisekunden (Unix-Zeit).
import { isValidLatLon, boundaryStatus, centroidOf, randomPointInGeometry, distanceM } from './geo.js';
import { kalmanUpdate } from './kalman.js';
import { buildPing, buildHunterPing } from './ping.js';
import { stageIndexAt } from './zone.js';

export const DEFAULT_SETTINGS = Object.freeze({
  ping_interval_s: 300,
  // 'distance' = Sucher sehen bei jedem Ping den genauen Punkt des Gejagten und die Entfernung zu sich selbst in Metern.
  // Die älteren Modi (exact, circle, direction) bleiben gültig, damit alte Spiele weiterlaufen; die App bietet sie nicht mehr an.
  ping_mode: 'distance',
  ping_radius_m: 250,
  headstart_s: 600,
  duration_s: 3600,
  role_mode: 'choose',
  boundary_penalty: 'extra_ping',
  boundary_warn_s: 30,
  boundary_tolerance_m: 20,
  accuracy_max_m: 50,
  shrink_enabled: false,
  shrink_every_s: 900,
  shrink_percent: 10,
  show_teammates: true,
  retention_h: 24,
});

// [min, max] je Zahlenwert. Muss zu public.normalize_settings() in der SQL-Migration passen.
export const SETTING_LIMITS = Object.freeze({
  ping_interval_s: [60, 3600],
  ping_radius_m: [50, 2000],
  headstart_s: [0, 3600],
  duration_s: [300, 6 * 3600],
  boundary_warn_s: [5, 300],
  boundary_tolerance_m: [0, 100],
  accuracy_max_m: [10, 200],
  shrink_every_s: [60, 7200],
  shrink_percent: [1, 90],
  retention_h: [1, 72],
});

const ENUMS = {
  ping_mode: ['distance', 'exact', 'circle', 'direction'],
  role_mode: ['choose', 'random'],
  boundary_penalty: ['extra_ping', 'eliminate'],
};
const BOOLS = ['shrink_enabled', 'show_teammates'];

export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS };
  for (const [k, [min, max]] of Object.entries(SETTING_LIMITS)) {
    const v = input?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) s[k] = Math.round(Math.min(max, Math.max(min, v)));
  }
  for (const [k, values] of Object.entries(ENUMS)) if (values.includes(input?.[k])) s[k] = input[k];
  for (const k of BOOLS) if (typeof input?.[k] === 'boolean') s[k] = input[k];
  return s;
}

// Joker: Jeder Spieler hat von Anfang an alle seine Joker, jeden aber nur einmal pro Runde.
// "pending" = wirkt auf den nächsten Ping; sonst sofort.
export const HIDER_JOKERS = {
  skip: { label: 'Ping überspringen', sub: 'Der nächste Ping fällt aus.', icon: 'skip', pending: true },
  double: { label: 'Ungenauer Ping', sub: 'Der nächste Ping zeigt nur einen Kreis von 150 m statt deines genauen Punkts. Die Entfernung ist auf 100 m gerundet und bis zu 150 m daneben.', icon: 'double', pending: true },
  decoy: { label: 'Falscher Ort', sub: 'Der nächste Ping zeigt einen erfundenen Ort, 300 bis 900 m von dir entfernt. Wird erst nach dem Spiel verraten.', icon: 'ghost', pending: true },
  reveal: { label: 'Sucher-Radar', sub: 'Zeigt dir sofort, wo alle Sucher gerade genau sind.', icon: 'target', pending: false },
};
export const HUNTER_JOKERS = {
  sound: { label: 'Sound-Joker', sub: 'Spielt bei einem Gejagten einen Ton ab und zeigt dir seinen genauen Standort.', icon: 'megaphone', pending: false },
};
export const JOKERS = { ...HIDER_JOKERS, ...HUNTER_JOKERS };
export const PENDING_JOKERS = Object.keys(HIDER_JOKERS).filter((k) => HIDER_JOKERS[k].pending);

/** Hat der Spieler diesen Joker in der laufenden Runde schon eingesetzt? (priv = player_private-Zeile) */
export function jokerUsed(priv, type) {
  return !!(priv?.joker_used && Object.prototype.hasOwnProperty.call(priv.joker_used, type));
}

/** Rolle, mit der der Spieler in die Runde gestartet ist (gefundene Gejagte können Sucher werden). */
export function startRole(p) {
  return p?.start_role || p?.role;
}

/** Index der Zonen-Stufe, die zu "now" gilt. */
export function zoneIndexAt(game, now) {
  const stages = game.zone_stages;
  if (!Array.isArray(stages) || stages.length < 2 || !game.hunt_starts_at || now < game.hunt_starts_at) return 0;
  return stageIndexAt(stages, now - game.hunt_starts_at);
}

/** Geometrie der aktuell gültigen Zone. */
export function zoneGeometryAt(game, now) {
  const stages = game.zone_stages;
  const idx = zoneIndexAt(game, now);
  if (Array.isArray(stages) && stages[idx]?.geometry) return stages[idx].geometry;
  return game.area?.geometry || null;
}

/**
 * Verarbeitet eine eingehende Standortmessung (Traccar oder App).
 * ctx = { game, player, priv }; m = { lat, lon, accuracy, at }
 * Ergebnis beschreibt, was gespeichert werden soll. Strafen verhängt erst planTick.
 */
export function processLocation(ctx, m, now) {
  const { game, player, priv } = ctx;
  const s = normalizeSettings(game.settings);
  const out = { accepted: false, reason: null, kf: null, location: null, boundary: null, oob: null };
  const at = Number.isFinite(m.at) ? m.at : now;
  if (at < now - 5 * 60_000) return { ...out, reason: 'zu alt' };
  if (at > now + 2 * 60_000) return { ...out, reason: 'Zeitstempel in der Zukunft' };
  if (!isValidLatLon(m.lat, m.lon)) return { ...out, reason: 'ungültige Koordinaten' };
  const acc = Number.isFinite(m.accuracy) && m.accuracy > 0 ? m.accuracy : 30;
  if (acc > s.accuracy_max_m) return { ...out, reason: `zu ungenau (${Math.round(acc)} m)` };

  const prev = priv && Number.isFinite(priv.kf_lat)
    ? { lat: priv.kf_lat, lon: priv.kf_lon, var: priv.kf_var, at: priv.kf_at, rejects: priv.kf_rejects || 0 }
    : null;
  const r = kalmanUpdate(prev, { lat: m.lat, lon: m.lon, accuracy: acc, at });
  out.kf = r.state;
  if (!r.accepted) return { ...out, reason: r.reason };

  out.accepted = true;
  out.location = { lat: m.lat, lon: m.lon, s_lat: r.state.lat, s_lon: r.state.lon, accuracy: acc, recorded_at: at };

  const zone = zoneGeometryAt(game, now);
  const b = boundaryStatus({ lat: r.state.lat, lon: r.state.lon, accuracy: acc }, zone, game.exclusions || [], s.boundary_tolerance_m);
  out.boundary = {
    inside: b.inside,
    edge_dist_m: b.edgeDistM == null ? null : Math.round(b.edgeDistM),
    violation: b.violation,
    exclusion: b.exclusion,
  };
  const penalised = player.role === 'hider' && player.status === 'active';
  if (b.violation) {
    if (priv?.oob_since) out.oob = { since: priv.oob_since, deadline: priv.oob_deadline ?? null };
    else out.oob = { since: now, deadline: penalised ? now + s.boundary_warn_s * 1000 : null };
  } else {
    out.oob = { since: null, deadline: null };
  }
  return out;
}

const FRESH_REF_MS = 5 * 60_000;

/** Bezugspunkte (Sucher-Positionen) für Richtungs-Pings. */
function hunterRefs(ctx, now, zoneGeom) {
  const center = zoneGeom ? centroidOf(zoneGeom) : null;
  return ctx.players
    .filter((p) => p.role === 'hunter' && p.status === 'active')
    .map((h) => {
      const pv = ctx.privs[h.id];
      if (pv && Number.isFinite(pv.kf_lat) && pv.kf_at > now - FRESH_REF_MS) {
        return { hunter: h, ref: { lat: pv.kf_lat, lon: pv.kf_lon }, refIsCenter: false };
      }
      return { hunter: h, ref: center, refIsCenter: true };
    })
    .filter((x) => x.ref);
}

/** Erzeugt die Ping-Zeilen für einen Gejagten. */
function pingRowsFor(ctx, hider, seq, kind, now, rng, joker, zoneGeom) {
  const s = normalizeSettings(ctx.game.settings);
  const pv = ctx.privs[hider.id];
  const base = { seq, hider_id: hider.id, recipient_id: null, kind, joker: null, decoy: false };
  if (joker === 'skip' && kind === 'regular') {
    return [{ ...base, kind: 'joker_skip', mode: 'none', joker: 'skip' }];
  }
  if (!pv || !Number.isFinite(pv.kf_lat)) {
    return [{ ...base, mode: 'none', no_signal: true }];
  }
  const truePos = { lat: pv.kf_lat, lon: pv.kf_lon };
  const age_s = Math.max(0, Math.round((now - pv.kf_at) / 1000));
  let target = truePos;
  let decoy = false;
  if (joker === 'decoy' && kind === 'regular' && zoneGeom) {
    // Im Entfernungs-Modus soll die falsche Entfernung für jeden Sucher deutlich daneben liegen (mind. 150 m).
    const refs = s.ping_mode === 'distance'
      ? ctx.players.filter((p) => p.role === 'hunter' && p.status === 'active').map((p) => ctx.privs[p.id])
        .filter((hv) => hv && Number.isFinite(hv.kf_lat) && hv.kf_at > now - FRESH_REF_MS).map((hv) => ({ lat: hv.kf_lat, lon: hv.kf_lon }))
      : [];
    for (let i = 0; i < 30; i++) {
      target = randomPointInGeometry(zoneGeom, rng, truePos, 300, 900);
      if (refs.every((r) => Math.abs(distanceM(r, target) - distanceM(r, truePos)) >= 150)) break;
    }
    decoy = true;
  }
  const double = joker === 'double' && kind === 'regular';
  const extra = { ...base, age_s, decoy, joker: double ? 'double' : null };
  if (s.ping_mode === 'distance') {
    // Die Zeile ohne Empfänger ist nur die Meldung an den Gejagten, dass geortet wurde (ohne Ort und Entfernung).
    // Jeder Sucher bekommt den genauen Punkt und die Entfernung von seiner eigenen Position zum Gejagten.
    // Ohne frische Sucher-Position gibt es nur den Punkt.
    const rows = [{ ...extra, mode: 'distance', distance_m: null }];
    for (const hunter of ctx.players.filter((p) => p.role === 'hunter' && p.status === 'active')) {
      const hv = ctx.privs[hunter.id];
      const ref = hv && Number.isFinite(hv.kf_lat) && hv.kf_at > now - FRESH_REF_MS ? { lat: hv.kf_lat, lon: hv.kf_lon } : null;
      rows.push({ ...extra, recipient_id: hunter.id, ...buildHunterPing(target, { ref, double }, rng) });
    }
    return rows;
  }
  if (s.ping_mode === 'direction') {
    return hunterRefs(ctx, now, zoneGeom).map(({ hunter, ref, refIsCenter }) => ({
      ...extra,
      recipient_id: hunter.id,
      ...buildPing('direction', target, { ref, refIsCenter, double }, rng),
    }));
  }
  return [{ ...extra, ...buildPing(s.ping_mode, target, { radiusM: s.ping_radius_m, double }, rng) }];
}

export function emptyPlan(game) {
  return {
    game_id: game.id,
    expected_seq: game.ping_seq || 0,
    new_seq: null,
    next_ping_at: null,
    pings: [],
    zone_index: null,
    announce_hunt: false,
    end: null,
    penalties: [],
    consumed_jokers: [],
    messages: [],
  };
}

export function isPlanEmpty(p) {
  return !p.end && !p.announce_hunt && p.zone_index == null && !p.pings.length && !p.penalties.length && p.new_seq == null;
}

/**
 * Was ist für ein laufendes Spiel gerade fällig? (Pings, Spielende, Zone, Strafen)
 * ctx = { game, players, privs: {playerId: priv} }
 */
export function planTick(ctx, now, rng = Math.random) {
  const g = ctx.game;
  const plan = emptyPlan(g);
  if (g.status !== 'running') return plan;
  const s = normalizeSettings(g.settings);

  if (g.ends_at && now >= g.ends_at) {
    plan.end = { winner: 'hiders', reason: 'time' };
    return plan;
  }

  const huntStarted = g.hunt_starts_at && now >= g.hunt_starts_at;
  if (huntStarted && !g.hunt_announced) {
    plan.announce_hunt = true;
    plan.messages.push({ channel: 'all', kind: 'system', body: 'Der Vorsprung ist vorbei. Die Jagd beginnt!' });
  }

  const idx = zoneIndexAt(g, now);
  if (idx > (g.zone_index || 0)) {
    plan.zone_index = idx;
    const total = (g.zone_stages?.length || 1) - 1;
    plan.messages.push({ channel: 'all', kind: 'system', body: `Die Zone ist geschrumpft (Stufe ${idx} von ${total}).` });
  }
  const zoneGeom = zoneGeometryAt(g, now);
  const hiders = ctx.players.filter((p) => p.role === 'hider' && p.status === 'active');
  let seq = g.ping_seq || 0;
  const eliminated = new Set();

  // Strafen für Gejagte, die zu lange außerhalb waren
  for (const h of hiders) {
    const pv = ctx.privs[h.id];
    if (!pv?.oob_deadline || now < pv.oob_deadline) continue;
    if (s.boundary_penalty !== 'eliminate' && !huntStarted) continue; // Extra-Ping erst ab Jagdbeginn
    if (s.boundary_penalty === 'eliminate') {
      eliminated.add(h.id);
      plan.penalties.push({ player_id: h.id, type: 'eliminate' });
      plan.messages.push({ channel: 'all', kind: 'system', body: `${h.name} war zu lange außerhalb des Spielgebiets und ist ausgeschieden.` });
    } else {
      plan.penalties.push({
        player_id: h.id,
        type: 'extra_ping',
        oob_deadline: now + Math.max(60, s.boundary_warn_s * 2) * 1000,
      });
      plan.pings.push(...pingRowsFor(ctx, h, seq, 'penalty', now, rng, null, zoneGeom));
      plan.messages.push({ channel: 'all', kind: 'system', body: `${h.name} war zu lange außerhalb. Extra-Ping für die Sucher!` });
    }
  }

  // Regulärer Ping
  if (huntStarted && g.next_ping_at && now >= g.next_ping_at) {
    seq += 1;
    plan.new_seq = seq;
    const interval = s.ping_interval_s * 1000;
    let next = g.next_ping_at + interval;
    if (next <= now) next = now + interval;
    plan.next_ping_at = next;
    for (const h of hiders) {
      if (eliminated.has(h.id)) continue;
      const pending = ctx.privs[h.id]?.joker_pending;
      const joker = PENDING_JOKERS.includes(pending) ? pending : null;
      if (pending) plan.consumed_jokers.push(h.id);
      plan.pings.push(...pingRowsFor(ctx, h, seq, 'regular', now, rng, joker, zoneGeom));
    }
  }
  return plan;
}

/**
 * Rollen beim Start verteilen. players: [{id, role: 'hunter'|'hider'|'random'}]
 * Ziel: etwa ein Drittel Sucher (mindestens einer). Gibt {id: role} oder einen Fehlertext zurück.
 */
export function assignRoles(players, roleMode = 'choose', rng = Math.random) {
  const n = players.length;
  if (n < 2) return { error: 'Es braucht mindestens zwei Spieler.' };
  const target = Math.max(1, Math.round(n / 3));
  const result = {};
  const randoms = [];
  for (const p of players) {
    if (roleMode === 'random' || p.role === 'random' || !p.role) randoms.push(p.id);
    else result[p.id] = p.role;
  }
  for (let i = randoms.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [randoms[i], randoms[j]] = [randoms[j], randoms[i]];
  }
  let hunters = Object.values(result).filter((r) => r === 'hunter').length;
  for (const id of randoms) {
    if (hunters < target) { result[id] = 'hunter'; hunters++; }
    else result[id] = 'hider';
  }
  const roles = Object.values(result);
  if (!roles.includes('hunter')) return { error: 'Es braucht mindestens einen Sucher.' };
  if (!roles.includes('hider')) return { error: 'Es braucht mindestens einen Gejagten.' };
  return { roles: result };
}
