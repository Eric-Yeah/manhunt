// Edge-Function-Handler ohne Datenbank (Fake-RPC): Protokoll, Fehlerfälle, CORS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocation } from '../server/location.js';
import { handleTick } from '../server/tick.js';
import { safeEqual } from '../server/http.js';

const TOKEN = 'b'.repeat(64);
const url = 'https://p.supabase.co/functions/v1/location';

function fakeRpc(ctx) {
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'svc_location_context') return ctx;
    return { ok: true };
  };
  return { rpc, calls };
}

test('CORS-Vorabanfrage und falsche Methode', async () => {
  const { rpc } = fakeRpc({});
  const pre = await handleLocation(new Request(url, { method: 'OPTIONS' }), { rpc });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal((await handleLocation(new Request(url, { method: 'PUT', body: 'x' }), { rpc })).status, 405);
});

test('Zu große Anfragen werden abgelehnt', async () => {
  const { rpc, calls } = fakeRpc({});
  const r = await handleLocation(new Request(url, { method: 'POST', body: 'x'.repeat(30_000) }), { rpc });
  assert.equal(r.status, 413);
  assert.equal(calls.length, 0);
});

test('Ohne gültige Kennung wird die Datenbank gar nicht gefragt', async () => {
  const { rpc, calls } = fakeRpc({});
  const r = await handleLocation(new Request(`${url}?id=abc&lat=50&lon=8`), { rpc });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test('Kein aktives Spiel: nichts speichern', async () => {
  const { rpc, calls } = fakeRpc({ ok: true, active: false });
  const r = await handleLocation(new Request(`${url}?id=${TOKEN}&lat=50&lon=8`, { method: 'POST' }), { rpc });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
});

test('Ungültige Koordinaten im laufenden Spiel werden verworfen, Signal zählt trotzdem', async () => {
  const ctx = {
    ok: true, active: true,
    player: { id: 'p1', role: 'hider', status: 'active' },
    game: { status: 'running', settings: {}, area: null, zone_stages: [], exclusions: [] },
    priv: null,
  };
  const { rpc, calls } = fakeRpc(ctx);
  const r = await handleLocation(new Request(`${url}?id=${TOKEN}&lat=999&lon=8`, { method: 'POST' }), { rpc });
  const j = await r.json();
  assert.equal(j.accepted, false);
  assert.equal(calls[1].fn, 'svc_store_location');
  assert.equal(calls[1].args.p.accepted, false);
});

test('Tick ohne Berechtigung', async () => {
  const deps = { rpc: async () => [], env: { TICK_SECRET: 'abc' }, getUserId: async () => null };
  assert.equal((await handleTick(new Request('https://x/tick', { method: 'POST' }), deps)).status, 401);
  assert.equal((await handleTick(new Request('https://x/tick', { method: 'POST', headers: { 'x-tick-secret': 'abd' } }), deps)).status, 401);
  assert.equal((await handleTick(new Request('https://x/tick', { method: 'POST', headers: { 'x-tick-secret': 'abc' } }), deps)).status, 200);
  // Ohne gesetztes Secret ist der Cron-Weg zu
  const noSecret = { ...deps, env: {} };
  assert.equal((await handleTick(new Request('https://x/tick', { method: 'POST', headers: { 'x-tick-secret': 'abc' } }), noSecret)).status, 401);
  assert.equal(safeEqual('a', 'ab'), false);
});

test('Tick: ein defektes Spiel blockiert die anderen nicht', async () => {
  const now = Date.now();
  const bad = { game: { id: 'bad', status: 'running', settings: {}, zone_stages: [], exclusions: [], hunt_starts_at: now - 1000, next_ping_at: now - 500, ends_at: now + 3_600_000 }, players: null, privs: null }; // wirft in planTick
  const ended = { game: { id: 'ok', status: 'running', settings: {}, area: null, zone_stages: [], exclusions: [], hunt_starts_at: now - 10_000, next_ping_at: null, ends_at: now - 1000, ping_seq: 0 }, players: [], privs: {} };
  const applied = [];
  const rpc = async (fn, args) => {
    if (fn === 'svc_due_games') return [bad, ended];
    applied.push(args.p.game_id);
    return { ok: true };
  };
  const r = await handleTick(new Request('https://x/tick', { method: 'POST', headers: { 'x-tick-secret': 'abc' } }), { rpc, env: { TICK_SECRET: 'abc' }, getUserId: async () => null });
  assert.equal(r.status, 200);
  assert.deepEqual(applied, ['ok']);
});
