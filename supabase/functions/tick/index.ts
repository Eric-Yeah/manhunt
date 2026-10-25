// @ts-nocheck
// AUTOMATISCH ERZEUGT – bitte nicht von Hand ändern.
// Quelle: server/tick.js und web/js/core/*.js. Neu bauen mit: npm run build:functions
// server/deno-entry-tick.js
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// web/js/core/geo.js
import * as turf from "npm:@turf/turf@7.4.0";
var EARTH_RADIUS_M = 63710088e-1;
var toRad = (d) => d * Math.PI / 180;
var toDeg = (r) => r * 180 / Math.PI;
function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearingDeg(a, b) {
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function destination(p, distM, bearing) {
  const d = distM / EARTH_RADIUS_M, b = toRad(bearing), p1 = toRad(p.lat), l1 = toRad(p.lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lon: (toDeg(l2) + 540) % 360 - 180 };
}
var COMPASS8 = [
  ["Nord", "N"],
  ["Nordost", "NO"],
  ["Ost", "O"],
  ["S\xFCdost", "SO"],
  ["S\xFCd", "S"],
  ["S\xFCdwest", "SW"],
  ["West", "W"],
  ["Nordwest", "NW"]
];
var COMPASS4 = [["Nord", "N"], ["Ost", "O"], ["S\xFCd", "S"], ["West", "W"]];
function compass(bearing, sectors = 8) {
  const list = sectors === 4 ? COMPASS4 : COMPASS8;
  const size = 360 / list.length;
  const idx = Math.round((bearing % 360 + 360) % 360 / size) % list.length;
  return { label: list[idx][0], short: list[idx][1], center: idx * size, size };
}
function geomOf(g) {
  return g && g.type === "Feature" ? g.geometry : g;
}
function pointInGeometry(pt, geometry) {
  const g = geomOf(geometry);
  if (!g) return false;
  return turf.booleanPointInPolygon(turf.point([pt.lon, pt.lat]), g);
}
function centroidOf(geometry) {
  const g = geomOf(geometry);
  const c = turf.centroid(g).geometry.coordinates;
  return { lat: c[1], lon: c[0] };
}
function bboxOf(geometry) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(geomOf(geometry));
  return { minLon, minLat, maxLon, maxLat };
}
function randomPointInGeometry(geometry, rng = Math.random, near = null, minD = 0, maxD = Infinity) {
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

// web/js/core/ping.js
function roundDistance(d, coarse = false) {
  if (coarse) {
    if (d < 200) return 100;
    if (d < 2e3) return Math.round(d / 200) * 200;
    return Math.round(d / 500) * 500;
  }
  if (d < 100) return 50;
  if (d < 500) return Math.round(d / 50) * 50;
  if (d < 2e3) return Math.round(d / 100) * 100;
  return Math.round(d / 250) * 250;
}
function offsetCircleCenter(target, radiusM, rng = Math.random) {
  const a = 0.25, b = 0.85;
  const d = radiusM * Math.sqrt(rng() * (b * b - a * a) + a * a);
  return destination(target, d, rng() * 360);
}
function buildPing(mode, target, o = {}, rng = Math.random) {
  const radius = o.radiusM || 250;
  if (mode === "exact") {
    if (o.double) {
      const r = 100;
      const c = offsetCircleCenter(target, r, rng);
      return { mode: "circle", lat: c.lat, lon: c.lon, radius_m: r };
    }
    return { mode: "exact", lat: round6(target.lat), lon: round6(target.lon), radius_m: null };
  }
  if (mode === "circle") {
    const r = o.double ? radius * 2 : radius;
    const c = offsetCircleCenter(target, r, rng);
    return { mode: "circle", lat: round6(c.lat), lon: round6(c.lon), radius_m: r };
  }
  if (mode === "direction") {
    const ref = o.ref;
    if (!ref) throw new Error("Richtungs-Ping braucht einen Bezugspunkt");
    const dist = distanceM(ref, target);
    const sectors = o.double ? 4 : 8;
    const dir = compass(bearingDeg(ref, target), sectors);
    return {
      mode: "direction",
      ref_lat: round6(ref.lat),
      ref_lon: round6(ref.lon),
      ref_is_center: !!o.refIsCenter,
      bearing_deg: dir.center,
      sector_deg: dir.size,
      distance_m: roundDistance(dist, !!o.double),
      dir_label: dir.label
    };
  }
  throw new Error(`Unbekannter Ping-Modus: ${mode}`);
}
function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

// web/js/core/zone.js
function stageIndexAt(stages, msSinceHuntStart) {
  let idx = 0;
  if (!Array.isArray(stages)) return 0;
  for (let i = 1; i < stages.length; i++) {
    if (msSinceHuntStart >= stages[i].at_s * 1e3) idx = i;
  }
  return idx;
}

// web/js/core/engine.js
var DEFAULT_SETTINGS = Object.freeze({
  ping_interval_s: 300,
  ping_mode: "circle",
  ping_radius_m: 250,
  headstart_s: 600,
  duration_s: 3600,
  role_mode: "choose",
  boundary_penalty: "extra_ping",
  boundary_warn_s: 30,
  boundary_tolerance_m: 20,
  accuracy_max_m: 50,
  shrink_enabled: false,
  shrink_every_s: 900,
  shrink_percent: 10,
  joker_skip: false,
  joker_double: false,
  joker_decoy: false,
  joker_cooldown_s: 900,
  show_teammates: true,
  retention_h: 24
});
var SETTING_LIMITS = Object.freeze({
  ping_interval_s: [60, 3600],
  ping_radius_m: [50, 2e3],
  headstart_s: [0, 3600],
  duration_s: [300, 6 * 3600],
  boundary_warn_s: [5, 300],
  boundary_tolerance_m: [0, 100],
  accuracy_max_m: [10, 200],
  shrink_every_s: [60, 3600],
  shrink_percent: [5, 50],
  joker_cooldown_s: [60, 3600],
  retention_h: [1, 168]
});
var ENUMS = {
  ping_mode: ["exact", "circle", "direction"],
  role_mode: ["choose", "random"],
  boundary_penalty: ["extra_ping", "eliminate"]
};
var BOOLS = ["shrink_enabled", "joker_skip", "joker_double", "joker_decoy", "show_teammates"];
function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS };
  for (const [k, [min, max]] of Object.entries(SETTING_LIMITS)) {
    const v = Number(input?.[k]);
    if (Number.isFinite(v)) s[k] = Math.round(Math.min(max, Math.max(min, v)));
  }
  for (const [k, values] of Object.entries(ENUMS)) if (values.includes(input?.[k])) s[k] = input[k];
  for (const k of BOOLS) if (typeof input?.[k] === "boolean") s[k] = input[k];
  return s;
}
function zoneIndexAt(game, now) {
  const stages = game.zone_stages;
  if (!Array.isArray(stages) || stages.length < 2 || !game.hunt_starts_at || now < game.hunt_starts_at) return 0;
  return stageIndexAt(stages, now - game.hunt_starts_at);
}
function zoneGeometryAt(game, now) {
  const stages = game.zone_stages;
  const idx = zoneIndexAt(game, now);
  if (Array.isArray(stages) && stages[idx]?.geometry) return stages[idx].geometry;
  return game.area?.geometry || null;
}
var FRESH_REF_MS = 5 * 6e4;
function hunterRefs(ctx, now, zoneGeom) {
  const center = zoneGeom ? centroidOf(zoneGeom) : null;
  return ctx.players.filter((p) => p.role === "hunter" && p.status === "active").map((h) => {
    const pv = ctx.privs[h.id];
    if (pv && Number.isFinite(pv.kf_lat) && pv.kf_at > now - FRESH_REF_MS) {
      return { hunter: h, ref: { lat: pv.kf_lat, lon: pv.kf_lon }, refIsCenter: false };
    }
    return { hunter: h, ref: center, refIsCenter: true };
  }).filter((x) => x.ref);
}
function pingRowsFor(ctx, hider, seq, kind, now, rng, joker, zoneGeom) {
  const s = normalizeSettings(ctx.game.settings);
  const pv = ctx.privs[hider.id];
  const base = { seq, hider_id: hider.id, recipient_id: null, kind, joker: null, decoy: false };
  if (joker === "skip" && kind === "regular") {
    return [{ ...base, kind: "joker_skip", mode: "none", joker: "skip" }];
  }
  if (!pv || !Number.isFinite(pv.kf_lat)) {
    return [{ ...base, mode: "none", no_signal: true }];
  }
  const truePos = { lat: pv.kf_lat, lon: pv.kf_lon };
  const age_s = Math.max(0, Math.round((now - pv.kf_at) / 1e3));
  let target = truePos;
  let decoy = false;
  if (joker === "decoy" && kind === "regular" && zoneGeom) {
    target = randomPointInGeometry(zoneGeom, rng, truePos, 300, 900);
    decoy = true;
  }
  const double = joker === "double" && kind === "regular";
  const extra = { ...base, age_s, decoy, joker: double ? "double" : null };
  if (s.ping_mode === "direction") {
    return hunterRefs(ctx, now, zoneGeom).map(({ hunter, ref, refIsCenter }) => ({
      ...extra,
      recipient_id: hunter.id,
      ...buildPing("direction", target, { ref, refIsCenter, double }, rng)
    }));
  }
  return [{ ...extra, ...buildPing(s.ping_mode, target, { radiusM: s.ping_radius_m, double }, rng) }];
}
function emptyPlan(game) {
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
    messages: []
  };
}
function isPlanEmpty(p) {
  return !p.end && !p.announce_hunt && p.zone_index == null && !p.pings.length && !p.penalties.length && p.new_seq == null;
}
function planTick(ctx, now, rng = Math.random) {
  const g = ctx.game;
  const plan = emptyPlan(g);
  if (g.status !== "running") return plan;
  const s = normalizeSettings(g.settings);
  if (g.ends_at && now >= g.ends_at) {
    plan.end = { winner: "hiders", reason: "time" };
    return plan;
  }
  const huntStarted = g.hunt_starts_at && now >= g.hunt_starts_at;
  if (huntStarted && !g.hunt_announced) {
    plan.announce_hunt = true;
    plan.messages.push({ channel: "all", kind: "system", body: "Der Vorsprung ist vorbei. Die Jagd beginnt!" });
  }
  const idx = zoneIndexAt(g, now);
  if (idx > (g.zone_index || 0)) {
    plan.zone_index = idx;
    const total = (g.zone_stages?.length || 1) - 1;
    plan.messages.push({ channel: "all", kind: "system", body: `Die Zone ist geschrumpft (Stufe ${idx} von ${total}).` });
  }
  const zoneGeom = zoneGeometryAt(g, now);
  const hiders = ctx.players.filter((p) => p.role === "hider" && p.status === "active");
  let seq = g.ping_seq || 0;
  const eliminated = /* @__PURE__ */ new Set();
  for (const h of hiders) {
    const pv = ctx.privs[h.id];
    if (!pv?.oob_deadline || now < pv.oob_deadline) continue;
    if (s.boundary_penalty === "eliminate") {
      eliminated.add(h.id);
      plan.penalties.push({ player_id: h.id, type: "eliminate" });
      plan.messages.push({ channel: "all", kind: "system", body: `${h.name} war zu lange au\xDFerhalb des Spielgebiets und ist ausgeschieden.` });
    } else {
      plan.penalties.push({
        player_id: h.id,
        type: "extra_ping",
        oob_deadline: now + Math.max(60, s.boundary_warn_s * 2) * 1e3
      });
      plan.pings.push(...pingRowsFor(ctx, h, seq, "penalty", now, rng, null, zoneGeom));
      plan.messages.push({ channel: "all", kind: "system", body: `${h.name} war zu lange au\xDFerhalb. Extra-Ping f\xFCr die Sucher!` });
    }
  }
  if (huntStarted && g.next_ping_at && now >= g.next_ping_at) {
    seq += 1;
    plan.new_seq = seq;
    const interval = s.ping_interval_s * 1e3;
    let next = g.next_ping_at + interval;
    if (next <= now) next = now + interval;
    plan.next_ping_at = next;
    for (const h of hiders) {
      if (eliminated.has(h.id)) continue;
      const pending = ctx.privs[h.id]?.joker_pending;
      const joker = pending && s[`joker_${pending}`] ? pending : null;
      if (pending) plan.consumed_jokers.push(h.id);
      plan.pings.push(...pingRowsFor(ctx, h, seq, "regular", now, rng, joker, zoneGeom));
    }
  }
  return plan;
}

// server/http.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tick-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// server/tick.js
async function handleTick(req, { rpc: rpc2, env, getUserId: getUserId2, now = Date.now, rng = Math.random }) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Methode nicht erlaubt" }, 405);
  let userId = null;
  const secret = req.headers.get("x-tick-secret");
  if (secret) {
    if (!env.TICK_SECRET || !safeEqual(secret, env.TICK_SECRET)) return json({ ok: false, error: "Falsches Secret" }, 401);
  } else {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    userId = jwt ? await getUserId2(jwt) : null;
    if (!userId) return json({ ok: false, error: "Nicht angemeldet" }, 401);
  }
  const games = await rpc2("svc_due_games", { p_user: userId });
  const results = [];
  for (const ctx of games || []) {
    const plan = planTick(ctx, now(), rng);
    if (isPlanEmpty(plan)) continue;
    results.push({ game_id: ctx.game.id, ...await rpc2("svc_apply_tick", { p: plan }) });
  }
  return json({ ok: true, due: (games || []).length, results });
}

// server/deno-env.js
function serviceKey() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      if (keys.default) return keys.default;
      const first = Object.values(keys)[0];
      if (first) return first;
    } catch {
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Kein Secret Key gefunden (SUPABASE_SECRET_KEYS oder SUPABASE_SERVICE_ROLE_KEY).");
  return legacy;
}

// server/deno-entry-tick.js
var sb = createClient(Deno.env.get("SUPABASE_URL"), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
var rpc = async (fn, args) => {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};
var getUserId = async (jwt) => {
  const { data, error } = await sb.auth.getUser(jwt);
  return error ? null : data?.user?.id ?? null;
};
Deno.serve(async (req) => {
  try {
    return await handleTick(req, { rpc, getUserId, env: { TICK_SECRET: Deno.env.get("TICK_SECRET") } });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Serverfehler" }, 500);
  }
});
