// Bündelt die Edge Functions zu je EINER Datei (supabase/functions/<name>/index.ts).
// So lassen sie sich per Supabase CLI deployen oder im Dashboard-Editor einfügen.
// Aufruf: npm run build:functions
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURF = 'npm:@turf/turf@7.4.0';

const externalNpm = {
  name: 'deno-npm',
  setup(b) {
    b.onResolve({ filter: /^@turf\/turf$/ }, () => ({ path: TURF, external: true }));
    b.onResolve({ filter: /^npm:/ }, (a) => ({ path: a.path, external: true }));
  },
};

for (const name of ['location', 'tick']) {
  const out = path.join(root, 'supabase/functions', name, 'index.ts');
  const r = await build({
    entryPoints: [path.join(root, `server/deno-entry-${name}.js`)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    plugins: [externalNpm],
    legalComments: 'none',
  });
  const banner = `// @ts-nocheck\n// AUTOMATISCH ERZEUGT – bitte nicht von Hand ändern.\n// Quelle: server/${name}.js und web/js/core/*.js. Neu bauen mit: npm run build:functions\n`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, banner + r.outputFiles[0].text);
  console.log(`${path.relative(root, out)}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}
