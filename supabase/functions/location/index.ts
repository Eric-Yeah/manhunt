// @ts-nocheck
// AUTOMATISCH ERZEUGT – bitte nicht von Hand ändern.
// Quelle: server/location.js und web/js/core/*.js. Neu bauen mit: npm run build:functions
// server/deno-entry-location.js
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// web/js/core/traccar.js
var TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
function parseTimestamp(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1e12 ? Math.round(n) : Math.round(n * 1e3);
  }
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(" ", "T") + "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function num(v) {
  if (v == null || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function fromParams(get) {
  const token = get("id") ?? get("deviceid") ?? get("device_id");
  let lat = num(get("lat")), lon = num(get("lon"));
  const loc = get("location");
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && typeof loc === "string" && loc.includes(",")) {
    const [a, b] = loc.split(",");
    lat = num(a);
    lon = num(b);
  }
  let accuracy = num(get("accuracy"));
  if (!Number.isFinite(accuracy)) {
    const hdop = num(get("hdop"));
    if (Number.isFinite(hdop)) accuracy = hdop * 5;
  }
  const valid = get("valid");
  return {
    token: token == null ? null : String(token),
    lat,
    lon,
    accuracy,
    at: parseTimestamp(get("timestamp")),
    invalidFix: valid === "false" || valid === "0"
  };
}
function fromTransistorJson(body) {
  let loc = body.location;
  if (Array.isArray(loc)) {
    loc = loc.filter(Boolean).sort((a, b) => (parseTimestamp(a.timestamp) || 0) - (parseTimestamp(b.timestamp) || 0)).pop();
  }
  const c = loc?.coords || {};
  return {
    token: body.device_id != null ? String(body.device_id) : loc?.extras?.device_id ?? null,
    lat: num(c.latitude),
    lon: num(c.longitude),
    accuracy: num(c.accuracy),
    at: parseTimestamp(loc?.timestamp),
    invalidFix: false
  };
}
function parseLocationRequest(req) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const ct = (req.contentType || "").toLowerCase();
  const text = req.bodyText || "";
  let parsed = null;
  let source = "traccar";
  if (text && (ct.includes("json") || /^\s*[{[]/.test(text))) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (body && typeof body === "object") {
      if (body.location) parsed = fromTransistorJson(body);
      else parsed = fromParams((k) => body[k]);
      if (body.source === "web") source = "web";
    }
  } else if (text && ct.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(text);
    parsed = fromParams((k) => form.get(k) ?? q.get(k));
  }
  const fromQuery = fromParams((k) => q.get(k));
  if (!parsed) parsed = fromQuery;
  else {
    if (!parsed.token) parsed.token = fromQuery.token;
    for (const k of ["lat", "lon", "accuracy"]) if (!Number.isFinite(parsed[k])) parsed[k] = fromQuery[k];
    if (parsed.at == null) parsed.at = fromQuery.at;
  }
  return { ...parsed, source };
}

// web/js/core/geo.js
import * as turf from "npm:@turf/turf@7.4.0";
var EARTH_RADIUS_M = 63710088e-1;
var toRad = (d) => d * Math.PI / 180;
function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6);
}
function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}
function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Feature") return ringsOf(geometry.geometry);
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}
function geomOf(g) {
  return g && g.type === "Feature" ? g.geometry : g;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
function distanceToBoundaryM(pt, geometry) {
  const kx = Math.cos(toRad(pt.lat)) * 111320;
  const ky = 110574;
  let min = Infinity;
  for (const ring of ringsOf(geometry)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      const d = segDist(0, 0, (a[0] - pt.lon) * kx, (a[1] - pt.lat) * ky, (b[0] - pt.lon) * kx, (b[1] - pt.lat) * ky);
      if (d < min) min = d;
    }
  }
  return min;
}
function pointInGeometry(pt, geometry) {
  const g = geomOf(geometry);
  if (!g) return false;
  return turf.booleanPointInPolygon(turf.point([pt.lon, pt.lat]), g);
}
function boundaryStatus(pt, zoneGeometry, exclusions = [], toleranceM = 20) {
  const acc = Math.min(Number.isFinite(pt.accuracy) ? pt.accuracy : 15, 30);
  const zone = geomOf(zoneGeometry);
  if (!zone) return { inside: true, edgeDistM: null, violation: null, exclusion: null };
  const inZone = pointInGeometry(pt, zone);
  const edge = distanceToBoundaryM(pt, zone);
  const edgeDistM = inZone ? edge : -edge;
  let violation = null;
  if (!inZone && edge > toleranceM + acc) violation = "outside";
  let exclusionName = null;
  if (!violation) {
    for (const ex of exclusions || []) {
      const g = geomOf(ex);
      if (!g) continue;
      if (pointInGeometry(pt, g)) {
        const depth = distanceToBoundaryM(pt, g);
        if (depth >= Math.max(0, acc - toleranceM)) {
          violation = "exclusion";
          exclusionName = ex.properties && ex.properties.name || "Sperrzone";
          break;
        }
      }
    }
  }
  return { inside: inZone, edgeDistM, violation, exclusion: exclusionName };
}

// web/js/core/kalman.js
var KALMAN_DEFAULTS = {
  processNoise: 4,
  // m/s: wie schnell sich die Unsicherheit ohne Messung vergrößert (zu Fuß/rennend)
  maxSpeed: 25,
  // m/s: schnellere Sprünge gelten als GPS-Ausreißer
  resetAfterRejects: 3,
  // nach so vielen verworfenen Messungen in Folge neu beginnen
  resetAfterGapS: 180
  // nach längerer Pause neu beginnen
};
function kalmanUpdate(state, m, opts = {}) {
  const o = { ...KALMAN_DEFAULTS, ...opts };
  const acc = Math.max(3, Number.isFinite(m.accuracy) ? m.accuracy : 30);
  const fresh = { lat: m.lat, lon: m.lon, var: acc * acc, at: m.at, rejects: 0 };
  if (!state || !Number.isFinite(state.lat) || !Number.isFinite(state.at)) return { state: fresh, accepted: true };
  const dt = (m.at - state.at) / 1e3;
  if (dt < 0) return { state, accepted: false, reason: "veraltet" };
  if (dt > o.resetAfterGapS) return { state: fresh, accepted: true };
  const predVar = state.var + Math.max(dt, 0.5) * o.processNoise * o.processNoise;
  const d = distanceM(state, m);
  const explainable = 2 * Math.sqrt(predVar) + 2 * acc + o.maxSpeed * Math.max(dt, 1);
  if (d > explainable) {
    const rejects = (state.rejects || 0) + 1;
    if (rejects >= o.resetAfterRejects) return { state: fresh, accepted: true, reason: "neu gestartet" };
    return { state: { ...state, rejects }, accepted: false, reason: "Ausrei\xDFer" };
  }
  const k = predVar / (predVar + acc * acc);
  return {
    accepted: true,
    state: {
      lat: state.lat + k * (m.lat - state.lat),
      lon: state.lon + k * (m.lon - state.lon),
      var: (1 - k) * predVar,
      at: m.at,
      rejects: 0
    }
  };
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
  retention_h: [1, 72]
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
    const v = input?.[k];
    if (typeof v === "number" && Number.isFinite(v)) s[k] = Math.round(Math.min(max, Math.max(min, v)));
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
function processLocation(ctx, m, now) {
  const { game, player, priv } = ctx;
  const s = normalizeSettings(game.settings);
  const out = { accepted: false, reason: null, kf: null, location: null, boundary: null, oob: null };
  const at = Number.isFinite(m.at) ? m.at : now;
  if (at < now - 5 * 6e4) return { ...out, reason: "zu alt" };
  if (at > now + 2 * 6e4) return { ...out, reason: "Zeitstempel in der Zukunft" };
  if (!isValidLatLon(m.lat, m.lon)) return { ...out, reason: "ung\xFCltige Koordinaten" };
  const acc = Number.isFinite(m.accuracy) && m.accuracy > 0 ? m.accuracy : 30;
  if (acc > s.accuracy_max_m) return { ...out, reason: `zu ungenau (${Math.round(acc)} m)` };
  const prev = priv && Number.isFinite(priv.kf_lat) ? { lat: priv.kf_lat, lon: priv.kf_lon, var: priv.kf_var, at: priv.kf_at, rejects: priv.kf_rejects || 0 } : null;
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
    exclusion: b.exclusion
  };
  const penalised = player.role === "hider" && player.status === "active";
  if (b.violation) {
    if (priv?.oob_since) out.oob = { since: priv.oob_since, deadline: priv.oob_deadline ?? null };
    else out.oob = { since: now, deadline: penalised ? now + s.boundary_warn_s * 1e3 : null };
  } else {
    out.oob = { since: null, deadline: null };
  }
  return out;
}
var FRESH_REF_MS = 5 * 6e4;

// server/http.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tick-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}

// server/location.js
var MAX_BODY = 2e4;
async function handleLocation(req, { rpc: rpc2, now = Date.now }) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return json({ ok: false, error: "Methode nicht erlaubt" }, 405);
  const bodyText = req.method === "POST" ? await req.text() : "";
  if (bodyText.length > MAX_BODY) return json({ ok: false, error: "Anfrage zu gro\xDF" }, 413);
  const m = parseLocationRequest({ method: req.method, url: req.url, contentType: req.headers.get("content-type") || "", bodyText });
  if (!m.token || !TOKEN_RE.test(m.token)) return json({ ok: false, error: "Unbekannte Ger\xE4tekennung" }, 401);
  const ctx = await rpc2("svc_location_context", { p_token: m.token, p_source: m.source });
  if (!ctx?.ok) {
    if (ctx?.reason === "rate") return json({ ok: true, ignored: "zu schnell hintereinander" });
    return json({ ok: false, error: "Unbekannte Ger\xE4tekennung" }, 401);
  }
  if (!ctx.active) return json({ ok: true, active: false, info: "Kein aktives Spiel. Standort wird nicht gespeichert." });
  const base = { player_id: ctx.player.id, source: m.source };
  if (ctx.game.status !== "running" || m.invalidFix) {
    await rpc2("svc_store_location", { p: { ...base, signal_only: true } });
    return json({ ok: true, stored: false, status: ctx.game.status });
  }
  const res = processLocation(
    { game: ctx.game, player: ctx.player, priv: ctx.priv },
    { lat: m.lat, lon: m.lon, accuracy: m.accuracy, at: m.at },
    now()
  );
  await rpc2("svc_store_location", {
    p: { ...base, accepted: res.accepted, kf: res.kf, location: res.location, boundary: res.boundary, oob: res.oob }
  });
  return json({ ok: true, accepted: res.accepted, reason: res.reason || void 0, boundary: res.boundary || void 0 });
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

// server/deno-entry-location.js
var sb = createClient(Deno.env.get("SUPABASE_URL"), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
var rpc = async (fn, args) => {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};
Deno.serve(async (req) => {
  try {
    return await handleLocation(req, { rpc });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Serverfehler" }, 500);
  }
});
