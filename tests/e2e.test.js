// Durchstich: echte Edge-Function-Handler + echte Datenbank.
// Traccar meldet Standorte -> Tick erzeugt Pings -> Sucher sehen nur den verfremdeten Ping.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, uid, SERVICE } from './helpers/db.js';
import { handleLocation } from '../server/location.js';
import { handleTick } from '../server/tick.js';
import { distanceM, destination, circleFeature } from '../web/js/core/geo.js';

const C = { lat: 50.1255, lon: 8.663 };
const U = { eric: uid(), mia: uid(), lena: uid(), ben: uid() };
const URL_ = 'https://projekt.supabase.co/functions/v1/location';
const SECRET = 'test-secret-1234567890';
let db, G, tokens = {}, P = {};
let clock = Date.now();

const rpc = (fn, args) => db.rpc(SERVICE, fn, args);
const now = () => clock;

function traccarRequest(token, pos, at = clock) {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      location: { timestamp: new Date(at).toISOString(), coords: { latitude: pos.lat, longitude: pos.lon, accuracy: 6, speed: 0.5, heading: 90, altitude: 120 }, is_moving: true, odometer: 10, battery: { level: 0.8, is_charging: false } },
      device_id: token,
    }),
  });
}
async function sendLocation(user, pos) {
  // Rate-Limit (1/s) für Tests umgehen
  await db.admin('update public.user_trackers set last_request_at = null where user_id = $1', [user]);
  const res = await handleLocation(traccarRequest(tokens[user], pos), { rpc, now });
  return { status: res.status, body: await res.json() };
}
async function tick(headers = { 'x-tick-secret': SECRET }) {
  const res = await handleTick(new Request('https://x/functions/v1/tick', { method: 'POST', headers }), {
    rpc, now, env: { TICK_SECRET: SECRET }, getUserId: async (jwt) => (jwt === 'jwt-mia' ? U.mia : null), rng: Math.random,
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  db = await setupDb();
  const g = await db.rpc(U.eric, 'create_game', { p_name: 'Eric' });
  G = g.game_id;
  for (const [k, name] of [['mia', 'Mia'], ['lena', 'Lena'], ['ben', 'Ben']]) await db.rpc(U[k], 'join_game', { p_code: g.code, p_name: name });
  await db.rpc(U.eric, 'update_game', {
    p_game: G,
    p_patch: { settings: { ping_interval_s: 60, ping_mode: 'circle', ping_radius_m: 250, headstart_s: 0, duration_s: 1800 }, area: circleFeature(C, 800) },
  });
  for (const [k, r] of [['eric', 'hunter'], ['ben', 'hunter'], ['mia', 'hider'], ['lena', 'hider']]) await db.rpc(U[k], 'set_role', { p_game: G, p_role: r });
  for (const k of Object.keys(U)) {
    tokens[U[k]] = (await db.rpc(U[k], 'my_tracker', {})).token;
    P[k] = (await db.admin('select id from public.players where game_id = $1 and user_id = $2', [G, U[k]]))[0].id;
  }
});
after(async () => db?.close());

test('Im Warteraum wird nur das Signal vermerkt, kein Standort', async () => {
  const r = await sendLocation(U.mia, C);
  assert.equal(r.status, 200);
  assert.equal(r.body.stored, false);
  const [p] = await db.admin('select last_traccar_at from public.players where id = $1', [P.mia]);
  assert.ok(p.last_traccar_at);
  assert.equal((await db.admin('select count(*)::int n from public.locations'))[0].n, 0);
});

test('Falsche Kennung und Rate-Limit', async () => {
  const bad = await handleLocation(traccarRequest('x'.repeat(64), C), { rpc, now });
  assert.equal(bad.status, 401);
  const short = await handleLocation(new Request(`${URL_}?id=123&lat=50&lon=8`), { rpc, now });
  assert.equal(short.status, 401);
  await db.admin('update public.user_trackers set last_request_at = null');
  await handleLocation(traccarRequest(tokens[U.ben], C), { rpc, now });
  const fast = await handleLocation(traccarRequest(tokens[U.ben], C), { rpc, now });
  assert.equal((await fast.json()).ignored, 'zu schnell hintereinander');
});

test('Spiel läuft: Standorte werden gefiltert, geglättet und gespeichert', async () => {
  await db.rpc(U.eric, 'start_game', { p_game: G });
  clock = Date.now();
  const miaPos = destination(C, 350, 60);
  const r = await sendLocation(U.mia, miaPos);
  assert.equal(r.body.accepted, true);
  assert.equal(r.body.boundary.violation, null);
  await sendLocation(U.lena, destination(C, 200, 200));
  await sendLocation(U.eric, C);
  await sendLocation(U.ben, destination(C, 100, 10));
  // Ungenaue Messung wird verworfen
  await db.admin('update public.user_trackers set last_request_at = null');
  const fuzzy = await handleLocation(new Request(`${URL_}?id=${tokens[U.mia]}&lat=${miaPos.lat}&lon=${miaPos.lon}&accuracy=400&timestamp=${Math.round(clock / 1000)}`, { method: 'POST' }), { rpc, now });
  assert.equal((await fuzzy.json()).accepted, false);
  // Web-App-Format (Quelle "web")
  await db.admin('update public.user_trackers set last_request_at = null');
  const web = await handleLocation(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: tokens[U.mia], lat: miaPos.lat, lon: miaPos.lon, accuracy: 9, timestamp: clock, source: 'web' }) }), { rpc, now });
  assert.equal((await web.json()).accepted, true);
  const rows = await db.admin('select source from public.locations where player_id = $1 order by id', [P.mia]);
  assert.deepEqual(rows.map((x) => x.source), ['traccar', 'web']);
  // Sucher sehen die Zeilen nicht
  assert.equal((await db.select(U.eric, 'select * from public.locations where player_id = $1', [P.mia])).length, 0);
});

test('Tick erzeugt Pings; die echte Position liegt im Kreis, aber nie in der Mitte', async () => {
  const unauthorized = await tick({ 'x-tick-secret': 'falsch' });
  assert.equal(unauthorized.status, 401);
  assert.equal((await tick({})).status, 401);
  const t = await tick();
  assert.equal(t.status, 200);
  assert.equal(t.body.results[0].pings, 2);
  const pings = await db.select(U.eric, 'select * from public.pings where game_id = $1 order by hider_id', [G]);
  assert.equal(pings.length, 2);
  const miaPing = pings.find((p) => p.hider_id === P.mia);
  const [truth] = await db.admin('select kf_lat, kf_lon from public.player_private where player_id = $1', [P.mia]);
  const d = distanceM({ lat: miaPing.lat, lon: miaPing.lon }, { lat: truth.kf_lat, lon: truth.kf_lon });
  assert.ok(d > 0.2 * 250 && d < 250, `Abstand zum echten Ort: ${d}`);
  // Zweiter Tick direkt danach: nichts fällig
  const again = await tick();
  assert.equal(again.body.results.length, 0);
});

test('App-Anstoß mit Login verarbeitet nur eigene Spiele', async () => {
  await db.admin("update public.games set next_ping_at = now() - interval '1 second' where id = $1", [G]);
  const r = await tick({ authorization: 'Bearer jwt-mia' });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 1);
  assert.equal((await tick({ authorization: 'Bearer unbekannt' })).status, 401);
});

test('Grenze: Countdown, danach Extra-Ping für die Sucher', async () => {
  const outside = destination(C, 1200, 90);
  // Glättung: mehrere Messungen, bis der Filter den Ortswechsel annimmt
  let body;
  for (let i = 0; i < 4; i++) {
    clock += 5000;
    body = (await sendLocation(U.lena, outside)).body;
  }
  assert.equal(body.boundary.violation, 'outside');
  const [pv] = await db.select(U.lena, 'select violation, oob_deadline from public.player_private where player_id = $1', [P.lena]);
  assert.equal(pv.violation, 'outside');
  assert.ok(pv.oob_deadline);
  await db.admin("update public.player_private set oob_deadline = now() - interval '1 second' where player_id = $1", [P.lena]);
  const before_ = (await db.select(U.eric, 'select count(*)::int n from public.pings where game_id = $1', [G]))[0].n;
  const r = await tick();
  assert.equal(r.status, 200);
  const pens = await db.select(U.eric, "select * from public.pings where game_id = $1 and kind = 'penalty'", [G]);
  assert.equal(pens.length, 1);
  assert.equal(pens[0].hider_id, P.lena);
  assert.equal((await db.select(U.eric, 'select count(*)::int n from public.pings where game_id = $1', [G]))[0].n, before_ + 1);
  const msgs = await db.select(U.ben, "select body from public.messages where game_id = $1 and body like '%Extra-Ping%'", [G]);
  assert.equal(msgs.length, 1);
});

test('Zeit abgelaufen: Gejagte gewinnen', async () => {
  await db.admin("update public.games set ends_at = now() - interval '1 second' where id = $1", [G]);
  const r = await tick();
  assert.equal(r.status, 200);
  const [g] = await db.admin('select status, winner, end_reason from public.games where id = $1', [G]);
  assert.deepEqual({ ...g }, { status: 'ended', winner: 'hiders', end_reason: 'time' });
  // Nach dem Spiel speichert "location" nichts mehr
  const after_ = await sendLocation(U.mia, C);
  assert.equal(after_.body.active, false);
});
