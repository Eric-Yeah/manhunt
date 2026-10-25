// Kopiert bzw. bündelt die benutzten Bibliotheken nach web/vendor/.
// Die App lädt so nichts von fremden CDNs (schneller, offline-fähig, kein Tracking durch Dritte).
// Nur nötig, wenn du Bibliotheken aktualisieren willst: npm install && npm run vendor
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = (p) => path.join(root, 'web/vendor', p);
fs.rmSync(out(''), { recursive: true, force: true });
fs.mkdirSync(out('leaflet/images'), { recursive: true });
fs.mkdirSync(out('geoman'), { recursive: true });
fs.mkdirSync(out('LICENSES'), { recursive: true });

fs.copyFileSync(nm('leaflet/dist/leaflet.js'), out('leaflet/leaflet.js'));
fs.copyFileSync(nm('leaflet/dist/leaflet.css'), out('leaflet/leaflet.css'));
for (const f of fs.readdirSync(nm('leaflet/dist/images'))) fs.copyFileSync(nm(`leaflet/dist/images/${f}`), out(`leaflet/images/${f}`));
fs.copyFileSync(nm('@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.min.js'), out('geoman/leaflet-geoman.min.js'));
fs.copyFileSync(nm('@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'), out('geoman/leaflet-geoman.css'));

const bundles = {
  'turf.esm.js': "export * from '@turf/turf';",
  'supabase.esm.js': "export { createClient } from '@supabase/supabase-js';",
  'qrcode.esm.js': "import q from 'qrcode-generator'; export default q;",
  'jsqr.esm.js': "import j from 'jsqr'; export default j;",
};
for (const [file, contents] of Object.entries(bundles)) {
  await build({
    stdin: { contents, resolveDir: root, loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true,
    legalComments: 'none', outfile: out(file), logLevel: 'warning',
  });
}

const licenses = {
  'leaflet.txt': 'leaflet/LICENSE',
  'leaflet-geoman.txt': '@geoman-io/leaflet-geoman-free/LICENSE',
  'turf.txt': '@turf/turf/LICENSE',
  'supabase-js.txt': '@supabase/supabase-js/LICENSE',
  'qrcode-generator.txt': 'qrcode-generator/LICENSE',
  'jsqr.txt': 'jsqr/LICENSE',
};
for (const [name, src] of Object.entries(licenses)) {
  const p = nm(src);
  if (fs.existsSync(p)) fs.copyFileSync(p, out(`LICENSES/${name}`));
  else {
    const pkg = JSON.parse(fs.readFileSync(nm(src.replace(/LICENSE.*$/, 'package.json')), 'utf8'));
    fs.writeFileSync(out(`LICENSES/${name}`), `${pkg.name} ${pkg.version} – Lizenz: ${pkg.license}\n`);
  }
}
const versions = Object.fromEntries(['leaflet', '@geoman-io/leaflet-geoman-free', '@turf/turf', '@supabase/supabase-js', 'qrcode-generator', 'jsqr']
  .map((p) => [p, JSON.parse(fs.readFileSync(nm(`${p}/package.json`), 'utf8')).version]));
fs.writeFileSync(out('VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
for (const f of fs.readdirSync(out(''), { recursive: true })) {
  const p = out(f);
  if (fs.statSync(p).isFile()) console.log(`${f.padEnd(34)} ${(fs.statSync(p).size / 1024).toFixed(0).padStart(5)} KB`);
}
