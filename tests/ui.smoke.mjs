// Durchlauf der Oberfläche im Headless-Browser (Demo-Modus, iPhone-Größe) mit Screenshots.
// Aufruf: npm run test:ui   (braucht Playwright: npx playwright install chromium)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SHOT_DIR || path.join(root, 'tests/screenshots');
fs.mkdirSync(outDir, { recursive: true });
const port = 5199;
const server = await startServer(port);
const browser = await chromium.launch();
const errors = [];
let n = 0;

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  locale: 'de-DE', colorScheme: 'dark', permissions: ['geolocation'], geolocation: { latitude: 50.1255, longitude: 8.663 },
});
// Kartenkacheln im Test durch eine leere Kachel ersetzen (kein Netz nötig)
const blank = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
await ctx.route('**/tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: blank }));
// Demo-Modus erzwingen: Supabase-Werte aus config.js leeren (sonst liefe der Test gegen das echte Projekt)
const demoConfig = fs.readFileSync(path.join(root, 'web/js/config.js'), 'utf8')
  .replace(/SUPABASE_URL: '[^']*'/, "SUPABASE_URL: ''")
  .replace(/SUPABASE_KEY: '[^']*'/, "SUPABASE_KEY: ''")
  .replace(/PUBLIC_URL: '[^']*'/, "PUBLIC_URL: ''");
await ctx.route('**/js/config.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: demoConfig }));
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const shot = async (name) => {
  n += 1;
  const file = path.join(outDir, `${String(n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log('📸', path.basename(file));
};
const tap = async (text, opts = {}) => {
  // Offener Dialog hat Vorrang
  const scope = (await page.locator('.modal').count()) ? page.locator('.modal') : page;
  const loc = scope.getByRole('button', { name: text, exact: opts.exact ?? false }).first();
  await loc.scrollIntoViewIfNeeded();
  await loc.click();
};
const wait = (ms) => page.waitForTimeout(ms);

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('text=Spiel erstellen');
  await shot('start');
  await page.fill('input[aria-label="Dein Name"]', 'Eric');
  await tap('Neues Spiel erstellen');
  await page.waitForSelector('text=Spielregeln');
  await shot('regeln');
  // Für den Test: ohne Vorsprung, 1-min-Pings, Joker an, Zone schrumpft
  await tap('1 min', { exact: true });
  await tap('Ohne', { exact: true });
  await page.getByRole('switch', { name: /Schrumpfende Zone/ }).click();
  await page.getByRole('switch', { name: /Doppelter Kreis/ }).click();
  await page.getByRole('switch', { name: /Ping überspringen/ }).click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot('regeln-unten');
  await tap('Weiter: Spielgebiet');
  await page.waitForSelector('.leaflet-container');
  await page.waitForSelector('text=Gebiet übernehmen');
  await wait(800);
  await shot('gebiet-kreis');
  // Formmodus: Polygon zeichnen
  await tap('Form zeichnen', { exact: true });
  await wait(300);
  const box = await page.locator('.map').boundingBox();
  const pts = [[0.3, 0.3], [0.7, 0.28], [0.8, 0.6], [0.5, 0.8], [0.22, 0.62]];
  for (const [x, y] of pts) {
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    await wait(150);
  }
  await shot('gebiet-zeichnen');
  await tap('Fertig', { exact: true });
  await wait(600);
  await shot('gebiet-form');
  // Sperrzone zeichnen
  await tap('Sperrzone zeichnen');
  for (const [x, y] of [[0.45, 0.45], [0.58, 0.45], [0.58, 0.58], [0.45, 0.58]]) {
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    await wait(120);
  }
  await tap('Fertig', { exact: true });
  await page.waitForSelector('text=Sperrzone benennen');
  await page.fill('.modal input', 'Gleise');
  await tap('Speichern', { exact: true });
  await wait(600);
  await page.locator('.panel').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot('gebiet-sperrzone');
  // Gebiet speichern und wieder laden
  await tap('Gespeichert', { exact: true });
  await tap('Aktuelles Gebiet speichern');
  await page.fill('.modal input', 'Stadtpark');
  await tap('Speichern', { exact: true });
  await page.waitForSelector('text=Stadtpark');
  await shot('gebiet-gespeichert');
  await tap('Form zeichnen', { exact: true });
  await wait(300);
  await page.locator('.panel').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await tap('Gebiet übernehmen');
  await page.waitForSelector('text=Warteraum');
  await wait(4500); // Bots treten bei
  await shot('warteraum');
  await tap('Sucher', { exact: false });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(2500);
  await shot('warteraum-unten');
  await tap('Spiel starten');
  if (await page.locator('.modal').count()) await tap('Starten', { exact: true });
  await page.waitForSelector('.mapscr .hudtop');
  await wait(1500);
  await shot('sucher-start');
  await wait(9000); // erster Ping (1 min im Zeitraffer = 6 s)
  await shot('sucher-ping');
  await page.locator('.grab').click();
  await wait(400);
  await shot('sucher-sheet-offen');
  await page.locator('.grab').click();
  // Chat
  await page.getByRole('button', { name: 'Chat öffnen' }).click();
  await page.waitForSelector('.chat-list');
  await page.fill('.chat-input textarea', 'Ich nehme die Nordseite!');
  await page.getByRole('button', { name: 'Senden', exact: true }).click();
  await wait(3500);
  await shot('chat-team');
  await page.getByRole('tab', { name: 'Alle' }).click();
  await wait(300);
  await shot('chat-alle');
  await page.getByRole('button', { name: 'Chat schließen' }).click();
  // Pause/SOS
  await page.getByRole('button', { name: 'Pause oder SOS' }).click();
  await tap('SOS – ich brauche Hilfe');
  await page.waitForSelector('text=SOS – Spiel angehalten');
  await shot('sos');
  await tap('Fortsetzen');
  await wait(800);
  // Spiel beenden -> Ergebnis
  await page.locator('.grab').click();
  await wait(300);
  await page.locator('.sheet').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await tap('Spiel für alle beenden');
  await tap('Beenden', { exact: true });
  await page.waitForSelector('text=Spiel abgebrochen');
  await wait(1500);
  await shot('ergebnis');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot('ergebnis-unten');
  // Revanche: Rollen getauscht -> Eric ist jetzt Gejagter
  await tap('Revanche');
  await page.waitForSelector('text=Warteraum');
  await wait(500);
  await tap('Spiel starten');
  if (await page.locator('.modal').count()) await tap('Starten', { exact: true });
  await page.waitForSelector('text=Ich wurde gefunden');
  await wait(9000);
  await shot('gejagter');
  // Außerhalb tippen -> Grenzwarnung
  const mbox = await page.locator('.map').boundingBox();
  await page.mouse.click(mbox.x + 8, mbox.y + 160);
  await wait(4500);
  await shot('gejagter-grenze');
  // Joker einsetzen
  const joker = page.locator('.joker').first();
  if (await joker.count()) {
    await joker.click();
    await tap('Einsetzen', { exact: true });
    await wait(600);
    await shot('joker');
  }
  // Gefunden (2 s halten)
  const hold = page.locator('.hold-btn');
  const hb = await hold.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await wait(2300);
  await page.mouse.up();
  await page.waitForSelector('text=/Du wurdest gefunden|Runde beendet/', { timeout: 5000 });
  await wait(600);
  await shot('gefunden');
  // Hilfe-Screen und Hellmodus
  await page.evaluate(() => { localStorage.setItem('manhunt:theme', '"light"'); });
  await page.reload();
  await wait(1500);
  await shot('hell');
  console.log(`\nFertig: ${n} Screenshots in ${path.relative(root, outDir)}`);
} catch (e) {
  await shot('FEHLER').catch(() => {});
  errors.push(`test: ${e.message}`);
} finally {
  await browser.close();
  server.close();
}
const relevant = errors.filter((e) => !/favicon|ERR_|Failed to load resource/.test(e));
if (relevant.length) {
  console.error('\nFehler:\n' + relevant.join('\n'));
  process.exit(1);
}
console.log('Keine Fehler in der Konsole.');
