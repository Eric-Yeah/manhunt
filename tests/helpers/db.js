// Testhelfer: eigene Datenbank je Testdatei, Abfragen als anon / authenticated (mit Nutzer-ID) / service_role.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SERVICE = 'service';
export const ANON = null;

export async function setupDb() {
  const admin = new pg.Client({ database: 'postgres' });
  await admin.connect();
  const name = 't_' + crypto.randomBytes(5).toString('hex');
  await admin.query(`create database ${name}`);
  await admin.end();
  const pool = new pg.Pool({ database: name, max: 4 });
  await pool.query(fs.readFileSync(path.join(root, 'tests/supabase-emulation.sql'), 'utf8'));
  const migDir = path.join(root, 'supabase/migrations');
  for (const f of fs.readdirSync(migDir).sort()) {
    await pool.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }

  const toParam = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

  async function as(user, fn) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const role = user === SERVICE ? 'service_role' : user ? 'authenticated' : 'anon';
      await c.query(`set local role ${role}`);
      if (user && user !== SERVICE) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async function rpc(user, fn, args = {}) {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const res = await as(user, (c) => c.query(sql, keys.map((k) => toParam(args[k]))));
    return res.rows[0].r;
  }

  async function select(user, sql, params = []) {
    const res = await as(user, (c) => c.query(sql, params.map(toParam)));
    return res.rows;
  }

  async function admin_(sql, params = []) {
    const res = await pool.query(sql, params.map(toParam));
    return res.rows;
  }

  return { pool, as, rpc, select, admin: admin_, close: () => pool.end() };
}

export const uid = () => crypto.randomUUID();

// Kreis um einen Punkt als GeoJSON (ohne Turf, für SQL-Tests reicht ein Vieleck)
export function circleArea(lat, lon, r = 800, steps = 24) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i % steps) / steps * 2 * Math.PI;
    ring.push([lon + (r / (111320 * Math.cos(lat * Math.PI / 180))) * Math.sin(a), lat + (r / 110574) * Math.cos(a)]);
  }
  return { type: 'Feature', properties: { shape: 'circle', center: [lon, lat], radius_m: r }, geometry: { type: 'Polygon', coordinates: [ring] } };
}
