// Startet ein temporäres lokales Postgres, spielt eine Supabase-Nachbildung + die Migration ein
// und führt die Datenbank-Tests aus. Braucht Postgres 15+ (Mac: brew install postgresql@16).
// Aufruf: npm run test:db
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findBin(name) {
  const dirs = [process.env.PG_BIN];
  for (const base of ['/usr/lib/postgresql']) {
    if (fs.existsSync(base)) for (const v of fs.readdirSync(base).sort().reverse()) dirs.push(path.join(base, v, 'bin'));
  }
  dirs.push('/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/Applications/Postgres.app/Contents/Versions/latest/bin');
  for (const d of dirs.filter(Boolean)) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  const w = spawnSync('which', [name], { encoding: 'utf8' });
  if (w.status === 0) return w.stdout.trim();
  return null;
}

const initdb = findBin('initdb');
const pgctl = findBin('pg_ctl');
if (!initdb || !pgctl) {
  console.error('Postgres nicht gefunden. Installiere es (Mac: brew install postgresql@16) oder setze PG_BIN.');
  process.exit(1);
}

const isRoot = process.getuid?.() === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-pg-'));
if (isRoot) spawnSync('chown', ['-R', 'postgres', dir]);
// macOS: Ohne gesetzte Locale fragt Postgres die Systemsprache ab und bricht mit
// "postmaster became multithreaded during startup" ab. Deshalb fest auf en_US.UTF-8.
const pgEnv = { ...process.env, LC_ALL: 'en_US.UTF-8' };
const run = (cmd, args, opts = {}) => {
  const r = isRoot
    ? spawnSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { encoding: 'utf8', env: pgEnv, ...opts })
    : spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv, ...opts });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`${path.basename(cmd)} fehlgeschlagen`);
  }
  return r;
};

const port = 55000 + Math.floor(Math.random() * 1000);
const data = path.join(dir, 'data');
let code = 1;
try {
  run(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  run(pgctl, ['-D', data, '-l', path.join(dir, 'log.txt'), '-w', '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start']);
  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'postgres', PGDATABASE: 'postgres' };
  const files = process.argv.slice(2).length ? process.argv.slice(2) : ['tests/db.test.js', 'tests/e2e.test.js', 'tests/deno.test.js'];
  const t = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, env, stdio: 'inherit' });
  code = t.status ?? 1;
} finally {
  try { run(pgctl, ['-D', data, '-m', 'fast', 'stop']); } catch { /* egal */ }
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
