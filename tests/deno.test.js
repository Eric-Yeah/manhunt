// Prüft die fertig gebündelten Edge Functions (supabase/functions/*/index.ts) in echtem Deno.
// Ein kleiner Nachbau der Supabase-REST-Schnittstelle leitet RPC-Aufrufe an die Test-Datenbank weiter.
// Wird übersprungen, wenn Deno nicht installiert ist (DENO_BIN setzen oder deno in den PATH).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { setupDb, uid, SERVICE } from './helpers/db.js';
import { circleFeature } from '../web/js/core/geo.js';

const denoBin = process.env.DENO_BIN || (spawnSync('which', ['deno'], { encoding: 'utf8' }).stdout || '').trim();
const skip = !denoBin && 'Deno nicht gefunden';
const C = { lat: 50.1255, lon: 8.663 };
let db, server, restUrl, G, token;
const U = { host: uid(), hider: uid() };

before(async () => {
  if (skip) return;
  db = await setupDb();
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const m = req.url.match(/^\/rest\/v1\/rpc\/(\w+)/);
    if (req.method === 'POST' && m) {
      try {
        const args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const r = await db.rpc(SERVICE, m[1], args);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: e.message, code: e.code }));
      }
      return;
    }
    if (req.url.startsWith('/auth/v1/user')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'invalid' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  restUrl = `http://127.0.0.1:${server.address().port}`;
  const g = await db.rpc(U.host, 'create_game', { p_name: 'Host' });
  G = g.game_id;
  await db.rpc(U.hider, 'join_game', { p_code: g.code, p_name: 'Mia' });
  await db.rpc(U.host, 'update_game', { p_game: G, p_patch: { settings: { headstart_s: 0, ping_interval_s: 60 }, area: circleFeature(C, 800) } });
  await db.rpc(U.host, 'set_role', { p_game: G, p_role: 'hunter' });
  await db.rpc(U.hider, 'set_role', { p_game: G, p_role: 'hider' });
  token = (await db.rpc(U.hider, 'my_tracker', {})).token;
  await db.rpc(U.host, 'start_game', { p_game: G });
});
after(async () => {
  server?.close();
  await db?.close();
});

async function withFunction(name, fn) {
  const env = {
    ...process.env,
    SUPABASE_URL: restUrl,
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    TICK_SECRET: 'deno-secret-0123456789',
    DENO_NO_UPDATE_CHECK: '1',
  };
  if (process.env.SSL_CERT_FILE || process.env.NODE_EXTRA_CA_CERTS) env.DENO_CERT = process.env.SSL_CERT_FILE || process.env.NODE_EXTRA_CA_CERTS;
  const p = spawn(denoBin, ['run', '--allow-net', '--allow-env', '--allow-read', '--allow-sys', `supabase/functions/${name}/index.ts`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));
  try {
    const start = Date.now();
    while (!/Listening on/i.test(log)) {
      if (p.exitCode != null || Date.now() - start > 90_000) throw new Error(`Deno startet nicht:\n${log}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    return await fn('http://127.0.0.1:8000');
  } finally {
    p.kill();
    await new Promise((r) => p.once('exit', r));
  }
}

test('Gebündelte Funktion "location" läuft in Deno', { skip, timeout: 120_000 }, async () => {
  await withFunction('location', async (base) => {
    const body = { location: { timestamp: new Date().toISOString(), coords: { latitude: C.lat, longitude: C.lon, accuracy: 7 } }, device_id: token };
    const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.accepted, true);
    const pre = await fetch(base, { method: 'OPTIONS' });
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    const bad = await fetch(`${base}?id=${'z'.repeat(40)}&lat=1&lon=1`, { method: 'POST' });
    assert.equal(bad.status, 401);
  });
  assert.equal((await db.admin('select count(*)::int n from public.locations'))[0].n, 1);
});

test('Gebündelte Funktion "tick" läuft in Deno', { skip, timeout: 120_000 }, async () => {
  await withFunction('tick', async (base) => {
    const r = await fetch(base, { method: 'POST', headers: { 'x-tick-secret': 'deno-secret-0123456789' } });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.results[0].pings, 1);
    const denied = await fetch(base, { method: 'POST', headers: { authorization: 'Bearer kaputt' } });
    assert.equal(denied.status, 401);
  });
});
