// Härtungstests (Sicherheit/Datenschutz) gegen echtes Postgres. Läuft über: npm run test:db
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, uid, circleArea, SERVICE, ANON } from './helpers/db.js';

let db;
const LAT = 50.1255, LON = 8.663;
const U = { host: uid(), hider: uid(), spy: uid(), eve: uid() };

before(async () => { db = await setupDb(); });
after(async () => db?.close());

const badFeature = (coords) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } });

async function storeLoc(player, lat, lon) {
  return db.rpc(SERVICE, 'svc_store_location', { p: {
    player_id: player, source: 'traccar', accepted: true,
    location: { lat, lon, s_lat: lat, s_lon: lon, accuracy: 8, recorded_at: Date.now() },
    kf: { lat, lon, var: 64, at: Date.now(), rejects: 0 },
    boundary: { inside: true, edge_dist_m: 300, violation: null }, oob: { since: null, deadline: null },
  } });
}

async function runningGame() {
  const host = uid(), hider = uid();
  const g = await db.rpc(host, 'create_game', { p_name: 'Host' });
  const j = await db.rpc(hider, 'join_game', { p_code: g.code, p_name: 'Hider' });
  await db.rpc(host, 'update_game', { p_game: g.game_id, p_patch: { area: circleArea(LAT, LON, 800) } });
  await db.rpc(host, 'set_role', { p_game: g.game_id, p_role: 'hunter' });
  await db.rpc(hider, 'set_role', { p_game: g.game_id, p_role: 'hider' });
  await db.rpc(host, 'start_game', { p_game: g.game_id });
  return { host, hider, game: g.game_id, hostP: g.player_id, hiderP: j.player_id };
}

test('Spielgebiet: nur gültige Zahlen, geschlossene Ringe, Wertebereich', async () => {
  const h = uid();
  const g = await db.rpc(h, 'create_game', { p_name: 'Host' });
  const ring = [[8.66, 50.12], [8.67, 50.12], [8.67, 50.13], [8.66, 50.12]];
  for (const bad of [
    badFeature([['a', 'b', 'c', 'd']]),
    badFeature([[['x', 'y'], [1, 2], [3, 4], ['x', 'y']]]),
    badFeature([[[1e308, 1e308], [1, 2], [3, 4], [1e308, 1e308]]]),
    badFeature([[[8.66, 50.12], [8.67, 50.12], [8.67, 50.13], [8.5, 50.0]]]), // nicht geschlossen
    badFeature([[[200, 50], [8.67, 50.12], [8.67, 50.13], [200, 50]]]),
    badFeature([[[8, 91], [8.67, 50.12], [8.67, 50.13], [8, 91]]]),
    badFeature([[[8.66]], [[8.66]]]),
  ]) {
    await assert.rejects(db.rpc(h, 'update_game', { p_game: g.game_id, p_patch: { area: bad } }), /Ungültig/);
  }
  await db.rpc(h, 'update_game', { p_game: g.game_id, p_patch: { area: badFeature([ring]) } });
  await assert.rejects(db.rpc(h, 'update_game', { p_game: g.game_id, p_patch: { zone_stages: [{ geometry: badFeature([ring]).geometry }] } }), /Ungültige Zonen/);
  await assert.rejects(db.rpc(h, 'update_game', { p_game: g.game_id, p_patch: { zone_stages: [{ at_s: 0.5, geometry: badFeature([ring]).geometry }] } }), /Ungültige Zonen/);
});

test('Namen: Steuer- und Bidi-Zeichen werden entfernt', async () => {
  const r = await db.rpc(uid(), 'create_game', { p_name: '‮H​ost\u0007' });
  const [p] = await db.admin('select name from public.players where id = $1', [r.player_id]);
  assert.equal(p.name, 'Host');
});

test('Gespeicherte Gebiete: Limit, Zeitstempel nicht setzbar, Gebiet geprüft', async () => {
  const a = circleArea(LAT, LON, 500);
  await assert.rejects(db.select(U.host, "insert into public.saved_areas (name, area) values ('x', '{}')"), /Ungültiges Spielgebiet/);
  await db.select(U.host, "insert into public.saved_areas (name, area, created_at) values ('Zukunft', $1, '2999-01-01')", [a]);
  const [row] = await db.select(U.host, 'select created_at from public.saved_areas');
  assert.ok(row.created_at < new Date(Date.now() + 60_000), 'created_at wird vom Server gesetzt');
  for (let i = 1; i < 20; i++) await db.select(U.host, "insert into public.saved_areas (name, area) values ('G', $1)", [a]);
  await assert.rejects(db.select(U.host, "insert into public.saved_areas (name, area) values ('zu viel', $1)", [a]), /höchstens 20/);
  await db.select(U.host, 'update public.saved_areas set owner_id = $1', [U.eve]).catch(() => {});
  assert.equal((await db.admin('select count(*)::int as n from public.saved_areas where owner_id = $1', [U.host]))[0].n, 20, 'Besitzer lässt sich nicht ändern');
});

test('Replay nach Abbruch zeigt Suchern keine Gejagten-Routen', async () => {
  const s = await runningGame();
  await storeLoc(s.hiderP, LAT + 0.001, LON + 0.001);
  await storeLoc(s.hostP, LAT, LON);
  await db.rpc(s.host, 'end_game', { p_game: s.game });
  const hostReplay = await db.rpc(s.host, 'get_replay', { p_game: s.game });
  assert.deepEqual(hostReplay.tracks.map((t) => t.player_id), [s.hostP], 'Sucher-Host sieht nur die eigene Route');
  const hiderReplay = await db.rpc(s.hider, 'get_replay', { p_game: s.game });
  assert.deepEqual(hiderReplay.tracks.map((t) => t.player_id), [s.hiderP]);
});

test('Regulär beendetes Spiel: Replay zeigt alle Routen', async () => {
  const s = await runningGame();
  await storeLoc(s.hiderP, LAT + 0.001, LON + 0.001);
  await storeLoc(s.hostP, LAT, LON);
  await db.rpc(s.hider, 'mark_found', { p_game: s.game });
  const replay = await db.rpc(s.host, 'get_replay', { p_game: s.game });
  assert.equal(replay.tracks.length, 2);
});

test('Gehen alle Sucher, gewinnen die Gejagten', async () => {
  const s = await runningGame();
  await db.rpc(s.host, 'leave_game', { p_game: s.game });
  const [g] = await db.admin('select status, winner, end_reason from public.games where id = $1', [s.game]);
  assert.equal(g.status, 'ended');
  assert.equal(g.winner, 'hiders');
  assert.equal(g.end_reason, 'no_hunters');
});

test('Beitritt zum vollen Spiel wird atomar begrenzt', async () => {
  const h = uid();
  const g = await db.rpc(h, 'create_game', { p_name: 'Host' });
  const res = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => db.rpc(uid(), 'join_game', { p_code: g.code, p_name: `S${i}` })));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 9);
  assert.equal((await db.admin("select count(*)::int as n from public.players where game_id = $1", [g.game_id]))[0].n, 10);
});

test('Meine Daten löschen entfernt Spieler, Routen, Gebiete und Kennung', async () => {
  const s = await runningGame();
  await storeLoc(s.hiderP, LAT, LON);
  await db.select(s.hider, "insert into public.saved_areas (name, area) values ('G', $1)", [circleArea(LAT, LON, 500)]);
  await db.rpc(s.hider, 'delete_my_data', {});
  assert.equal((await db.admin('select count(*)::int as n from public.players where user_id = $1', [s.hider]))[0].n, 0);
  assert.equal((await db.admin('select count(*)::int as n from public.locations where player_id = $1', [s.hiderP]))[0].n, 0);
  assert.equal((await db.admin('select count(*)::int as n from public.saved_areas where owner_id = $1', [s.hider]))[0].n, 0);
  assert.equal((await db.admin('select count(*)::int as n from public.user_trackers where user_id = $1', [s.hider]))[0].n, 0);
  await assert.rejects(db.rpc(ANON, 'delete_my_data', {}), /permission denied/);
});

test('Fremde IDs: Sucher kann nichts an Gejagten oder fremden Spielen ändern', async () => {
  const s = await runningGame();
  const other = await runningGame();
  for (const [fn, args] of [
    ['kick_player', { p_player: s.hiderP }],
    ['set_player_role', { p_player: s.hiderP, p_role: 'hunter' }],
    ['mark_found', { p_game: s.game }],
    ['end_game', { p_game: other.game }],
    ['pause_game', { p_game: other.game }],
    ['send_message', { p_game: other.game, p_channel: 'all', p_body: 'hi' }],
    ['get_replay', { p_game: other.game }],
  ]) {
    await assert.rejects(db.rpc(s.host, fn, args), undefined, fn);
  }
});

test('Katalog: keine Funktionsrechte für anon, search_path überall, RLS überall, keine Sequenzrechte', async () => {
  const noPath = await db.admin(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and not coalesce(p.proconfig::text like '%search_path%', false)`);
  assert.deepEqual(noPath, []);
  const anonExec = await db.admin(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('public', p.oid, 'EXECUTE'))`);
  assert.deepEqual(anonExec, []);
  const noRls = await db.admin(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(noRls, []);
  const seq = await db.admin(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and (has_sequence_privilege('authenticated', c.oid, 'USAGE') or has_sequence_privilege('anon', c.oid, 'USAGE'))`);
  assert.deepEqual(seq, []);
  const pub = await db.admin(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'`);
  for (const t of ['user_trackers', 'ping_secrets', 'saved_areas']) assert.ok(!pub.some((r) => r.tablename === t), t);
});

test('Tracker-Kennung neu erzeugen macht die alte ungültig', async () => {
  const s = await runningGame();
  const old = (await db.rpc(s.hider, 'my_tracker', {})).token;
  const fresh = await db.rpc(s.hider, 'regenerate_tracker', {});
  assert.notEqual(old, fresh);
  assert.equal((await db.rpc(SERVICE, 'svc_location_context', { p_token: old })).ok, false);
  assert.equal((await db.rpc(SERVICE, 'svc_location_context', { p_token: fresh })).ok, true);
});
