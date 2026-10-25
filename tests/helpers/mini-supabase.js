// Winziger Nachbau von Supabase für Integrationstests der echten Web-App (SupabaseBackend):
// - /auth/v1/signup (anonyme Anmeldung, JWT HS256), /auth/v1/user
// - /rest/v1/<tabelle> (GET mit select/eq/neq/order/limit, POST insert, DELETE) und /rest/v1/rpc/<fn>
//   → läuft als Rolle "authenticated" mit der Nutzer-ID aus dem JWT gegen die Testdatenbank, also MIT RLS
// - /functions/v1/location und /functions/v1/tick → die echten Edge-Function-Handler
// - alles andere: Dateien aus web/ (config.js wird auf diesen Server umgebogen)
// Realtime gibt es nicht; die App fällt dann auf regelmäßiges Neuladen zurück.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SERVICE } from './db.js';
import { handleLocation } from '../../server/location.js';
import { handleTick } from '../../server/tick.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'mini-supabase-jwt-secret-0123456789abcdef';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export function signJwt(claims) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export function verifyJwt(token) {
  const [h, b, s] = String(token || '').split('.');
  if (!s) return null;
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
  if (sig !== s) return null;
  const c = JSON.parse(Buffer.from(b, 'base64url').toString());
  return c.exp * 1000 > Date.now() ? c : null;
}

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Ungültiger Name: ${s}`);
  return s;
};

function buildSelect(table, params) {
  const values = [];
  const sel = params.get('select') || '*';
  const cols = [];
  for (const part of sel.split(/,(?![^()]*\))/)) {
    const m = part.match(/^(\w+)\(([^)]*)\)$/);
    if (m) {
      const emb = ident(m[1]);
      const fk = emb.replace(/s$/, '') + '_id';
      const inner = m[2].split(',').map((c) => `'${ident(c.trim())}', e.${ident(c.trim())}`).join(', ');
      cols.push(`(select json_build_object(${inner}) from public.${emb} e where e.id = t.${fk}) as ${emb}`);
    } else cols.push(part === '*' ? 't.*' : `t.${ident(part.trim())}`);
  }
  const where = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq') { values.push(val); where.push(`t.${ident(k)}::text = $${values.length}`); }
    else if (op === 'neq') { values.push(val); where.push(`t.${ident(k)}::text <> $${values.length}`); }
    else if (op === 'is' && val === 'null') where.push(`t.${ident(k)} is null`);
    else throw new Error(`Filter nicht unterstützt: ${k}=${v}`);
  }
  let sql = `select ${cols.join(', ')} from public.${ident(table)} t${where.length ? ` where ${where.join(' and ')}` : ''}`;
  const order = params.get('order');
  if (order) sql += ` order by ${order.split(',').map((o) => { const [c, d] = o.split('.'); return `t.${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ')}`;
  if (params.get('limit')) sql += ` limit ${Number(params.get('limit')) | 0}`;
  return { sql: `select coalesce(json_agg(x), '[]'::json) as r from (${sql}) x`, values };
}

export async function startMiniSupabase(db, port = 0) {
  const rpcService = (fn, args) => db.rpc(SERVICE, fn, args);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString();
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const claims = verifyJwt((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const user = claims?.sub || null;
    try {
      // --- Auth ---
      if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const access_token = signJwt({ sub: id, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600, is_anonymous: true });
        const userObj = { id, aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
        return send(200, { access_token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: crypto.randomUUID(), user: userObj });
      }
      if (url.pathname === '/auth/v1/user') {
        return user ? send(200, { id: user, aud: 'authenticated', role: 'authenticated' }) : send(401, { message: 'invalid JWT' });
      }
      // --- Edge Functions ---
      const request = () => new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyText });
      if (url.pathname === '/functions/v1/location') {
        const r = await handleLocation(request(), { rpc: rpcService });
        return send(r.status, await r.text());
      }
      if (url.pathname === '/functions/v1/tick') {
        const r = await handleTick(request(), { rpc: rpcService, env: { TICK_SECRET: 'x'.repeat(40) }, getUserId: async (jwt) => verifyJwt(jwt)?.sub || null });
        return send(r.status, await r.text());
      }
      // --- REST ---
      const rpcM = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      if (rpcM) {
        const args = bodyText ? JSON.parse(bodyText) : {};
        const r = await db.rpc(user, rpcM[1], args);
        return send(200, JSON.stringify(r ?? null));
      }
      const tM = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
      if (tM) {
        const table = ident(tM[1]);
        if (req.method === 'GET') {
          const { sql, values } = buildSelect(table, url.searchParams);
          const rows = await db.select(user, sql, values);
          return send(200, rows[0].r);
        }
        if (req.method === 'POST') {
          const rows = [].concat(JSON.parse(bodyText));
          for (const row of rows) {
            const keys = Object.keys(row).map(ident);
            await db.select(user, `insert into public.${table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => row[k]));
          }
          return send(201, '');
        }
        if (req.method === 'DELETE') {
          const { sql, values } = buildSelect(table, url.searchParams);
          const where = sql.match(/ where (.*?)\) x$/)?.[1];
          await db.select(user, `delete from public.${table} t${where ? ` where ${where}` : ''}`, values);
          return send(204, '');
        }
      }
      if (url.pathname.startsWith('/realtime/')) return send(404, { message: 'Kein Realtime im Test' });
      // --- Statische Dateien ---
      if (url.pathname === '/js/config.js') {
        // Echte Werte aus config.js immer überschreiben, damit der Test nie das echte Projekt anspricht.
        const src = fs.readFileSync(path.join(root, 'web/js/config.js'), 'utf8')
          .replace(/SUPABASE_URL: '[^']*'/, `SUPABASE_URL: 'http://127.0.0.1:${server.address().port}'`)
          .replace(/SUPABASE_KEY: '[^']*'/, "SUPABASE_KEY: 'sb_publishable_test_0123456789abcdef'")
          .replace(/PUBLIC_URL: '[^']*'/, "PUBLIC_URL: ''");
        return send(200, src, 'text/javascript; charset=utf-8');
      }
      let file = path.join(root, 'web', decodeURIComponent(url.pathname));
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!file.startsWith(path.join(root, 'web')) || !fs.existsSync(file)) return send(404, 'Nicht gefunden', 'text/plain');
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      send(400, { message: e.message, code: e.code || '', details: e.detail || null, hint: e.hint || null });
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
