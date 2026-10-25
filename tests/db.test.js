// Sicherheits- und Ablauftests gegen ein echtes Postgres mit nachgebildeter Supabase-Umgebung.
// Läuft über: npm run test:db
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, uid, circleArea, SERVICE, ANON } from './helpers/db.js';

let db;
const LAT = 50.1255, LON = 8.663;
const U = { eric: uid(), mia: uid(), lena: uid(), ben: uid(), eve: uid() };
let G; // Haupt-Spiel
const P = {}; // Spieler-IDs

before(async () => {
  db = await setupDb();
});
after(async () => db?.close());

async function playerId(user, game) {
  const rows = await db.admin('select id from public.players where game_id = $1 and user_id = $2', [game, user]);
  return rows[0]?.id;
}

test('Spiel erstellen und beitreten', async () => {
  const r = await db.rpc(U.eric, 'create_game', { p_name: 'Eric' });
  assert.match(r.code, /^[A-HJ-NP-Z2-9]{6}$/);
  G = r.game_id;
  P.eric = r.player_id;
  const j1 = await db.rpc(U.mia, 'join_game', { p_code: r.code.toLowerCase().slice(0, 3) + '·' + r.code.slice(3), p_name: 'Mia' });
  assert.equal(j1.game_id, G);
  P.mia = j1.player_id;
  P.lena = (await db.rpc(U.lena, 'join_game', { p_code: r.code, p_name: 'Lena' })).player_id;
  P.ben = (await db.rpc(U.ben, 'join_game', { p_code: r.code, p_name: 'Ben' })).player_id;
  // Doppelter Name bekommt eine Nummer
  const dup = await db.rpc(uid(), 'join_game', { p_code: r.code, p_name: 'mia' });
  const names = (await db.select(U.eric, 'select name from public.players where game_id = $1 order by joined_at', [G])).map((x) => x.name);
  assert.ok(names.includes('mia 2'), names.join(','));
  await db.admin('delete from public.players where id = $1', [dup.player_id]);
  await assert.rejects(db.rpc(U.eve, 'join_game', { p_code: 'ZZZZZZ', p_name: 'Eve' }), /Kein offenes Spiel/);
});

test('Ohne Anmeldung geht nichts', async () => {
  await assert.rejects(db.rpc(ANON, 'create_game', { p_name: 'X' }), /permission denied/);
  await assert.rejects(db.select(ANON, 'select * from public.games'), /permission denied/);
});

test('Außenstehende sehen das Spiel nicht', async () => {
  assert.equal((await db.select(U.eve, 'select * from public.games where id = $1', [G])).length, 0);
  assert.equal((await db.select(U.eve, 'select * from public.players where game_id = $1', [G])).length, 0);
  assert.equal((await db.select(U.mia, 'select * from public.games where id = $1', [G])).length, 1);
});

test('Clients dürfen Tabellen nicht direkt ändern', async () => {
  await assert.rejects(db.select(U.eric, "update public.games set status = 'ended' where id = $1", [G]), /permission denied/);
  await assert.rejects(db.select(U.mia, "insert into public.messages (game_id, channel, body) values ($1, 'all', 'x')", [G]), /permission denied/);
  await assert.rejects(db.select(U.mia, 'insert into public.locations (game_id, player_id, lat, lon, source, recorded_at) values ($1, $2, 1, 1, $3, now())', [G, P.mia, 'web']), /permission denied/);
  await assert.rejects(db.select(U.mia, "update public.players set role = 'hunter' where id = $1", [P.mia]), /permission denied/);
});

test('Server-Funktionen sind für Apps gesperrt', async () => {
  for (const [fn, args] of [
    ['svc_due_games', {}],
    ['svc_location_context', { p_token: 'x'.repeat(40) }],
    ['svc_apply_tick', { p: { game_id: G } }],
    ['svc_store_location', { p: {} }],
    ['finish_game', { p_game: G, p_winner: 'hunters', p_reason: 'x' }],
    ['purge_expired', {}],
  ]) {
    await assert.rejects(db.rpc(U.eric, fn, args), /permission denied/, fn);
    await assert.rejects(db.rpc(ANON, fn, args), /permission denied/, fn);
  }
});

test('Nur der Host ändert Einstellungen und startet', async () => {
  const area = circleArea(LAT, LON, 800);
  await assert.rejects(db.rpc(U.mia, 'update_game', { p_game: G, p_patch: { area } }), /Nur der Host/);
  await assert.rejects(db.rpc(U.mia, 'start_game', { p_game: G }), /Nur der Host/);
  await assert.rejects(db.rpc(U.eric, 'start_game', { p_game: G }), /Spielgebiet/);
  await db.rpc(U.eric, 'update_game', { p_game: G, p_patch: { settings: { ping_interval_s: 1, ping_mode: 'circle', joker_skip: true, joker_decoy: true }, area } });
  const [g] = await db.select(U.eric, 'select settings, zone_stages from public.games where id = $1', [G]);
  assert.equal(g.settings.ping_interval_s, 60); // auf Minimum begrenzt
  assert.equal(g.zone_stages.length, 1);
  await assert.rejects(db.rpc(U.eric, 'update_game', { p_game: G, p_patch: { area: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } } } }), /Ungültiges Spielgebiet/);
});

test('Tracker-Token ist privat', async () => {
  const mine = await db.rpc(U.mia, 'my_tracker', {});
  assert.match(mine.token, /^[0-9a-f]{64}$/);
  const seen = await db.select(U.eric, 'select * from public.user_trackers');
  assert.ok(seen.every((t) => t.user_id === U.eric));
  assert.ok(!seen.some((t) => t.token === mine.token));
  assert.equal((await db.select(U.eric, 'select * from public.player_private where player_id = $1', [P.mia])).length, 0);
});

test('Rollen wählen, Teamchat im Warteraum', async () => {
  await db.rpc(U.eric, 'set_role', { p_game: G, p_role: 'hunter' });
  await db.rpc(U.ben, 'set_role', { p_game: G, p_role: 'hunter' });
  await db.rpc(U.mia, 'set_role', { p_game: G, p_role: 'hider' });
  await db.rpc(U.lena, 'set_role', { p_game: G, p_role: 'hider' });
  await db.rpc(U.mia, 'send_message', { p_game: G, p_channel: 'hiders', p_body: 'Wir treffen uns am Teich' });
  await assert.rejects(db.rpc(U.eric, 'send_message', { p_game: G, p_channel: 'hiders', p_body: 'Hallo' }), /Kein Zugriff/);
  const ericSees = await db.select(U.eric, "select * from public.messages where game_id = $1 and channel = 'hiders'", [G]);
  assert.equal(ericSees.length, 0, 'Sucher dürfen den Gejagten-Chat nicht lesen');
  const lenaSees = await db.select(U.lena, "select * from public.messages where game_id = $1 and channel = 'hiders'", [G]);
  assert.equal(lenaSees.length, 1);
  // Seitenwechsel: Lena wird kurz Sucherin und verliert den Zugang zum Gejagten-Chat
  await db.rpc(U.lena, 'set_role', { p_game: G, p_role: 'hunter' });
  assert.equal((await db.select(U.lena, "select * from public.messages where game_id = $1 and channel = 'hiders'", [G])).length, 0);
  await db.rpc(U.lena, 'set_role', { p_game: G, p_role: 'hider' });
});

test('Spiel starten: Zeiten und Rollen', async () => {
  await db.rpc(U.eric, 'start_game', { p_game: G });
  const [g] = await db.admin('select * from public.games where id = $1', [G]);
  assert.equal(g.status, 'running');
  assert.ok(g.hunt_starts_at - g.started_at >= 599_000);
  await assert.rejects(db.rpc(U.eve, 'join_game', { p_code: g.code, p_name: 'Eve' }), /läuft schon/);
  await assert.rejects(db.rpc(U.mia, 'set_role', { p_game: G, p_role: 'hunter' }), /Warteraum/);
});

async function storeLoc(player, lat, lon, extra = {}) {
  return db.rpc(SERVICE, 'svc_store_location', {
    p: {
      player_id: player, source: 'traccar', accepted: true,
      location: { lat, lon, s_lat: lat, s_lon: lon, accuracy: 8, recorded_at: Date.now() },
      kf: { lat, lon, var: 64, at: Date.now(), rejects: 0 },
      boundary: { inside: true, edge_dist_m: 300, violation: null },
      oob: { since: null, deadline: null },
      ...extra,
    },
  });
}

test('Echte Standorte: Sucher sehen keine Gejagten, Teams sehen sich gegenseitig', async () => {
  await storeLoc(P.mia, LAT + 0.001, LON + 0.001);
  await storeLoc(P.lena, LAT - 0.001, LON + 0.002);
  await storeLoc(P.eric, LAT, LON);
  await storeLoc(P.ben, LAT + 0.002, LON - 0.001);

  const ericRows = await db.select(U.eric, 'select player_id from public.locations where game_id = $1', [G]);
  const ericSeen = new Set(ericRows.map((r) => r.player_id));
  assert.ok(ericSeen.has(P.eric) && ericSeen.has(P.ben));
  assert.ok(!ericSeen.has(P.mia) && !ericSeen.has(P.lena), 'Sucher dürfen keine echten Positionen der Gejagten sehen');

  const miaSeen = new Set((await db.select(U.mia, 'select player_id from public.locations where game_id = $1', [G])).map((r) => r.player_id));
  assert.ok(miaSeen.has(P.mia) && miaSeen.has(P.lena));
  assert.ok(!miaSeen.has(P.eric) && !miaSeen.has(P.ben));

  assert.equal((await db.select(U.eve, 'select * from public.locations')).length, 0);
  // Geglätteter Zustand nur für einen selbst
  const priv = await db.select(U.eric, 'select player_id from public.player_private where game_id = $1', [G]);
  assert.deepEqual(priv.map((r) => r.player_id), [P.eric]);
});

test('Teammitglieder-Sicht lässt sich abschalten', async () => {
  await db.admin("update public.games set settings = settings || '{\"show_teammates\": false}' where id = $1", [G]);
  const seen = await db.select(U.eric, 'select player_id from public.locations where game_id = $1', [G]);
  assert.ok(seen.every((r) => r.player_id === P.eric));
  await db.admin("update public.games set settings = settings || '{\"show_teammates\": true}' where id = $1", [G]);
});

test('Pings: nur fällig nach dem Vorsprung, sichtbar für Sucher, Täuschung geheim', async () => {
  assert.equal((await db.rpc(SERVICE, 'svc_due_games', {})).length, 0, 'während des Vorsprungs ist nichts fällig');
  await db.admin("update public.games set hunt_starts_at = now() - interval '1 second', next_ping_at = now() - interval '1 second' where id = $1", [G]);
  const due = await db.rpc(SERVICE, 'svc_due_games', {});
  assert.equal(due.length, 1);
  assert.equal(due[0].game.ping_seq, 0);
  assert.ok(due[0].privs[P.mia].kf_lat);
  // Vom Server berechneter Plan (vereinfacht von Hand)
  const plan = {
    game_id: G, expected_seq: 0, new_seq: 1, next_ping_at: Date.now() + 60_000, announce_hunt: true,
    pings: [
      { seq: 1, hider_id: P.mia, kind: 'regular', mode: 'circle', lat: LAT, lon: LON, radius_m: 250 },
      { seq: 1, hider_id: P.lena, kind: 'regular', mode: 'circle', lat: LAT + 0.01, lon: LON, radius_m: 250, decoy: true },
    ],
    penalties: [], consumed_jokers: [],
  };
  const res = await db.rpc(SERVICE, 'svc_apply_tick', { p: plan });
  assert.equal(res.pings, 2);
  // Zweiter Aufruf mit demselben Plan erzeugt keine doppelten Pings
  const again = await db.rpc(SERVICE, 'svc_apply_tick', { p: plan });
  assert.equal(again.pings, 0);

  const ericPings = await db.select(U.eric, 'select * from public.pings where game_id = $1', [G]);
  assert.equal(ericPings.length, 2);
  assert.equal((await db.select(U.eric, 'select * from public.ping_secrets')).length, 0, 'Sucher erfahren nichts vom Täuschungs-Joker');
  const lenaSecrets = await db.select(U.lena, 'select * from public.ping_secrets');
  assert.equal(lenaSecrets.length, 1);
  assert.equal((await db.select(U.mia, 'select * from public.ping_secrets')).length, 0);
  // Gejagte sehen nur Pings über sich selbst
  const miaPings = await db.select(U.mia, 'select hider_id from public.pings where game_id = $1', [G]);
  assert.deepEqual(miaPings.map((p) => p.hider_id), [P.mia]);
  const msgs = await db.select(U.eric, "select body from public.messages where game_id = $1 and kind = 'system'", [G]);
  assert.ok(msgs.some((m) => m.body.includes('Jagd beginnt')));
});

test('Richtungs-Pings sieht nur der jeweilige Sucher', async () => {
  await db.admin("update public.games set next_ping_at = now() - interval '1 second' where id = $1", [G]);
  await db.rpc(SERVICE, 'svc_apply_tick', {
    p: {
      game_id: G, expected_seq: 1, new_seq: 2, next_ping_at: Date.now() + 60_000,
      pings: [
        { seq: 2, hider_id: P.mia, recipient_id: P.eric, kind: 'regular', mode: 'direction', ref_lat: LAT, ref_lon: LON, bearing_deg: 45, sector_deg: 45, distance_m: 400, dir_label: 'Nordost' },
        { seq: 2, hider_id: P.mia, recipient_id: P.ben, kind: 'regular', mode: 'direction', ref_lat: LAT + 0.002, ref_lon: LON - 0.001, bearing_deg: 90, sector_deg: 45, distance_m: 300, dir_label: 'Ost' },
      ],
      penalties: [], consumed_jokers: [],
    },
  });
  const forEric = await db.select(U.eric, 'select recipient_id from public.pings where game_id = $1 and seq = 2', [G]);
  assert.deepEqual(forEric.map((p) => p.recipient_id), [P.eric]);
  const forMia = await db.select(U.mia, 'select * from public.pings where game_id = $1 and seq = 2', [G]);
  assert.equal(forMia.length, 0, 'Richtungs-Pings verraten die Sucher-Position, Gejagte sehen sie nicht');
});

test('Grenze: Strafe nur nach Ablauf des Countdowns, Ausscheiden beendet ggf. das Spiel', async () => {
  await storeLoc(P.lena, LAT + 0.05, LON, {
    boundary: { inside: false, edge_dist_m: -4000, violation: 'outside' },
    oob: { since: Date.now() - 40_000, deadline: Date.now() - 1000 },
  });
  const [pv] = await db.select(U.lena, 'select violation, oob_deadline from public.player_private where player_id = $1', [P.lena]);
  assert.equal(pv.violation, 'outside');
  assert.ok(await db.admin('select 1 from public.due_game_ids(null)').then((r) => r.length === 1));
  // Sucher-Strafe gibt es nicht: Eric außerhalb bekommt keine Frist
  await storeLoc(P.eric, LAT + 0.05, LON, { boundary: { inside: false, edge_dist_m: -4000, violation: 'outside' }, oob: { since: Date.now(), deadline: Date.now() + 1000 } });
  const [ep] = await db.admin('select oob_deadline from public.player_private where player_id = $1', [P.eric]);
  assert.equal(ep.oob_deadline, null);
  await db.rpc(SERVICE, 'svc_apply_tick', { p: { game_id: G, expected_seq: 2, penalties: [{ player_id: P.lena, type: 'eliminate' }], pings: [], consumed_jokers: [] } });
  const [lena] = await db.admin('select status from public.players where id = $1', [P.lena]);
  assert.equal(lena.status, 'eliminated');
});

test('Joker: nur für aktive Gejagte, mit Abklingzeit', async () => {
  await assert.rejects(db.rpc(U.eric, 'use_joker', { p_game: G, p_type: 'skip' }), /Nur aktive Gejagte/);
  await assert.rejects(db.rpc(U.mia, 'use_joker', { p_game: G, p_type: 'double' }), /ausgeschaltet/);
  const r = await db.rpc(U.mia, 'use_joker', { p_game: G, p_type: 'skip' });
  assert.equal(r.pending, 'skip');
  await db.rpc(U.mia, 'cancel_joker', { p_game: G });
  await assert.rejects(db.rpc(U.mia, 'use_joker', { p_game: G, p_type: 'decoy' }), /wieder verfügbar/);
});

test('Pause und Fortsetzen verschieben die Zeiten', async () => {
  const [before_] = await db.admin('select ends_at, next_ping_at from public.games where id = $1', [G]);
  await db.rpc(U.mia, 'pause_game', { p_game: G, p_reason: 'SOS' });
  const sos = await db.select(U.ben, "select body from public.messages where game_id = $1 and kind = 'sos'", [G]);
  assert.ok(sos[0].body.includes('SOS von Mia'));
  assert.equal((await db.rpc(SERVICE, 'svc_due_games', {})).length, 0, 'pausiert: keine Pings');
  await db.admin("update public.games set paused_at = paused_at - interval '5 minutes' where id = $1", [G]);
  await assert.rejects(db.rpc(U.ben, 'resume_game', { p_game: G }), /Fortsetzen kann/);
  await db.rpc(U.mia, 'resume_game', { p_game: G });
  const [after_] = await db.admin('select status, ends_at from public.games where id = $1', [G]);
  assert.equal(after_.status, 'running');
  assert.ok(after_.ends_at - before_.ends_at >= 299_000);
});

test('Gefunden: letzter Gejagter beendet das Spiel, danach sind alle Kanäle lesbar', async () => {
  await assert.rejects(db.rpc(U.eric, 'mark_found', { p_game: G }), /Nur aktive Gejagte/);
  await assert.rejects(db.rpc(U.eric, 'get_replay', { p_game: G }), /erst nach dem Spiel/);
  await db.rpc(U.mia, 'mark_found', { p_game: G });
  const [g] = await db.admin('select status, winner, end_reason, purge_at from public.games where id = $1', [G]);
  assert.equal(g.status, 'ended');
  assert.equal(g.winner, 'hunters');
  assert.ok(g.purge_at > new Date(Date.now() + 23 * 3600_000));
  const ericSees = await db.select(U.eric, "select * from public.messages where game_id = $1 and channel = 'hiders'", [G]);
  assert.equal(ericSees.length, 1, 'nach Spielende kann jeder alle Kanäle lesen');
  assert.equal((await db.select(U.eric, 'select * from public.ping_secrets')).length, 1);
  const replay = await db.rpc(U.eric, 'get_replay', { p_game: G });
  assert.equal(replay.tracks.length, 4);
  assert.equal(replay.decoys.length, 1);
  assert.equal((await db.select(U.eve, 'select * from public.messages')).length, 0);
});

test('Revanche tauscht die Rollen', async () => {
  await assert.rejects(db.rpc(U.mia, 'rematch', { p_game: G }), /Nur der Host/);
  const r = await db.rpc(U.eric, 'rematch', { p_game: G });
  const roles = Object.fromEntries((await db.admin('select user_id, role, is_host from public.players where game_id = $1', [r.game_id])).map((p) => [p.user_id, p]));
  assert.equal(roles[U.eric].role, 'hider');
  assert.equal(roles[U.eric].is_host, true);
  assert.equal(roles[U.mia].role, 'hunter');
  assert.equal(roles[U.lena].role, 'hunter');
  const again = await db.rpc(U.eric, 'rematch', { p_game: G });
  assert.equal(again.game_id, r.game_id);
  const [old] = await db.select(U.mia, 'select rematch_id from public.games where id = $1', [G]);
  assert.equal(old.rematch_id, r.game_id);
});

test('Tracker-Kontext: Token-Prüfung und Rate-Limit', async () => {
  const t = (await db.rpc(U.mia, 'my_tracker', {})).token;
  assert.equal((await db.rpc(SERVICE, 'svc_location_context', { p_token: 'kurz' })).reason, 'token');
  assert.equal((await db.rpc(SERVICE, 'svc_location_context', { p_token: 'a'.repeat(64) })).reason, 'token');
  const ctx = await db.rpc(SERVICE, 'svc_location_context', { p_token: t });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.active, true); // Revanche-Warteraum
  assert.equal(ctx.game.status, 'lobby');
  const quick = await db.rpc(SERVICE, 'svc_location_context', { p_token: t });
  assert.equal(quick.reason, 'rate');
});

test('Nachrichten: Rate-Limit und Länge', async () => {
  const g2 = (await db.admin('select rematch_id from public.games where id = $1', [G]))[0].rematch_id;
  await assert.rejects(db.rpc(U.mia, 'send_message', { p_game: g2, p_channel: 'all', p_body: 'x'.repeat(501) }), /zu lang/);
  for (let i = 0; i < 20; i++) await db.rpc(U.mia, 'send_message', { p_game: g2, p_channel: 'all', p_body: `Nachricht ${i}` });
  await assert.rejects(db.rpc(U.mia, 'send_message', { p_game: g2, p_channel: 'all', p_body: 'eine zu viel' }), /Zu viele/);
  // Host-Ansage wird markiert
  await db.rpc(U.eric, 'send_message', { p_game: g2, p_channel: 'all', p_body: 'Treffpunkt Brunnen', p_announce: true });
  const [m] = await db.select(U.ben, "select kind from public.messages where game_id = $1 and body = 'Treffpunkt Brunnen'", [g2]);
  assert.equal(m.kind, 'host');
});

test('Gespeicherte Gebiete gehören nur dem Ersteller', async () => {
  await db.select(U.eric, "insert into public.saved_areas (name, area) values ('Stadtpark', $1)", [circleArea(LAT, LON, 600)]);
  assert.equal((await db.select(U.eric, 'select * from public.saved_areas')).length, 1);
  assert.equal((await db.select(U.mia, 'select * from public.saved_areas')).length, 0);
  await assert.rejects(db.select(U.mia, "insert into public.saved_areas (owner_id, name, area) values ($1, 'x', $2)", [U.eric, circleArea(LAT, LON, 300)]), /row-level security/);
});

test('Verlassen: Host-Wechsel im Warteraum, leeres Spiel wird gelöscht', async () => {
  const g2 = (await db.admin('select rematch_id from public.games where id = $1', [G]))[0].rematch_id;
  await db.rpc(U.eric, 'leave_game', { p_game: g2 });
  const host = await db.admin('select user_id from public.players where game_id = $1 and is_host', [g2]);
  assert.equal(host.length, 1);
  assert.notEqual(host[0].user_id, U.eric);
  const solo = await db.rpc(U.eve, 'create_game', { p_name: 'Eve' });
  await db.rpc(U.eve, 'leave_game', { p_game: solo.game_id });
  assert.equal((await db.admin('select 1 from public.games where id = $1', [solo.game_id])).length, 0);
});

test('Wer ein neues Spiel erstellt, verlässt das alte', async () => {
  const a = await db.rpc(U.eve, 'create_game', { p_name: 'Eve' });
  await db.rpc(U.mia, 'join_game', { p_code: a.code, p_name: 'Mia' });
  const memberships = await db.admin("select g.id from public.players p join public.games g on g.id = p.game_id where p.user_id = $1 and p.status <> 'left' and g.status <> 'ended'", [U.mia]);
  assert.deepEqual(memberships.map((m) => m.id), [a.game_id]);
});

test('Automatische Löschung nach Ablauf', async () => {
  await db.admin("update public.games set purge_at = now() - interval '1 minute' where id = $1", [G]);
  const n = await db.rpc(SERVICE, 'purge_expired', {});
  assert.ok(n >= 1);
  assert.equal((await db.admin('select count(*)::int as n from public.locations where game_id = $1', [G]))[0].n, 0);
  assert.equal((await db.admin('select count(*)::int as n from public.messages where game_id = $1', [G]))[0].n, 0);
});
