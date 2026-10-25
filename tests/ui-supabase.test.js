// Integrationstest der echten Web-App mit dem Supabase-Backend:
// zwei Browser (Host + Mitspieler) gegen den Supabase-Nachbau (echte Datenbank mit RLS + echte Edge-Function-Handler).
// Aufruf: npm run test:ui-db  (braucht Postgres und Playwright-Chromium)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupDb } from './helpers/db.js';
import { startMiniSupabase } from './helpers/mini-supabase.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* fehlt */ }
const skip = !chromium && 'Playwright nicht installiert';
const shots = process.env.SHOT_DIR || 'tests/screenshots/supabase';
let db, server, browser, base;

before(async () => {
  if (skip) return;
  db = await setupDb();
  server = await startMiniSupabase(db);
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  fs.mkdirSync(shots, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.close();
  await db?.close();
});

async function phone(name, lat, lon) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE',
    permissions: ['geolocation'], geolocation: { latitude: lat, longitude: lon, accuracy: 8 },
  });
  await ctx.route('**/tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/i.test(m.text())) page.errors.push(m.text()); });
  page.btn = (label, exact = false) => page.getByRole('button', { name: label, exact }).first();
  page.shot = (n) => page.screenshot({ path: path.join(shots, `${name}-${n}.png`) });
  return page;
}

test('Zwei Spieler: Lobby, Start, Standort, Ping, Chat, Gefunden, Ergebnis', { skip, timeout: 240_000 }, async () => {
  const host = await phone('host', 50.1255, 8.663);
  const friend = await phone('mia', 50.1262, 8.6648);

  await host.goto(base);
  await host.waitForSelector('text=Spiel erstellen');
  assert.equal(await host.locator('text=Demo-Modus aktiv').count(), 0, 'App soll im Supabase-Modus starten');
  await host.fill('input[aria-label="Dein Name"]', 'Eric');
  await host.btn('Neues Spiel erstellen').click();
  await host.waitForSelector('text=Spielregeln');
  await host.btn('1 min', true).click();
  await host.btn('Ohne', true).click();
  await host.btn('Weiter: Spielgebiet').click();
  await host.waitForSelector('text=Gebiet übernehmen');
  await host.waitForTimeout(1500); // Standort kommt an, Kreis springt dorthin
  // Gebiet speichern (REST-Insert mit RLS) und Liste prüfen
  await host.btn('Gespeichert', true).click();
  await host.btn('Aktuelles Gebiet speichern').click();
  await host.fill('.modal input', 'Grüneburgpark');
  await host.locator('.modal').getByRole('button', { name: 'Speichern', exact: true }).click();
  await host.waitForSelector('.panel >> text=Grüneburgpark');
  await host.btn('Kreis', true).click();
  await host.waitForTimeout(600);
  await host.btn('Gebiet übernehmen').click();
  await host.waitForSelector('.bigcode');
  const code = (await host.locator('.bigcode').innerText()).replace(/[^A-Z0-9]/g, '');
  assert.equal(code.length, 6);

  // Mitspielerin tritt per Einladungslink bei
  await friend.goto(`${base}/?join=${code}`);
  await friend.waitForSelector('text=Spiel beitreten');
  await friend.fill('input[aria-label="Dein Name"]', 'Mia');
  await friend.btn('Beitreten', true).click();
  await friend.waitForSelector('text=Warteraum');
  await friend.locator('.role', { hasText: 'Gejagter' }).click();
  await friend.btn('Ich bin bereit').click();

  await host.locator('.role', { hasText: 'Sucher' }).click();
  await host.waitForSelector('text=Mia', { timeout: 15_000 });
  await host.shot('warteraum');
  await host.btn('Spiel starten').click();
  if (await host.locator('.modal').count()) await host.locator('.modal').getByRole('button', { name: 'Starten', exact: true }).click();
  await host.waitForSelector('text=Nächster Ping in', { timeout: 15_000 });
  await friend.waitForSelector('text=Ich wurde gefunden', { timeout: 15_000 });

  // Standort der Mitspielerin landet in der Datenbank (Web-Fallback über die Edge Function "location")
  let rows = [];
  for (let i = 0; i < 30 && !rows.length; i++) {
    await friend.waitForTimeout(1000);
    rows = await db.admin("select l.source from public.locations l join public.players p on p.id = l.player_id where p.name = 'Mia'");
  }
  assert.ok(rows.length >= 1, 'Mias Standort sollte gespeichert sein');
  assert.equal(rows[0].source, 'web');

  // Nächsten Ping fällig machen; die App stößt "tick" selbst an
  const [{ seq }] = await db.admin("select ping_seq as seq from public.games where status = 'running'");
  await db.admin("update public.games set next_ping_at = now() where status = 'running'");
  let pings = [];
  for (let i = 0; i < 30 && !pings.length; i++) {
    await host.waitForTimeout(1000);
    pings = await db.admin("select p.mode, p.seq from public.pings p join public.players h on h.id = p.hider_id where h.name = 'Mia' and p.seq > $1 order by p.id desc limit 1", [seq]);
  }
  assert.equal(pings[0]?.mode, 'circle', 'neuer Ping mit echter (verfremdeter) Position');
  await host.waitForSelector(`.hrow:has-text("#${pings[0].seq}")`, { timeout: 15_000 });
  await host.waitForTimeout(800);
  await host.shot('ping');

  // Chat: Mia schreibt im Team-Chat (Eric darf das nicht sehen) und im gemeinsamen Chat
  await friend.getByRole('button', { name: 'Chat öffnen' }).click();
  await friend.getByRole('tab', { name: /Team/ }).click();
  await friend.fill('.chat-input textarea', 'Geheim: Ich bin am Teich');
  await friend.getByRole('button', { name: 'Senden', exact: true }).click();
  await friend.getByRole('tab', { name: 'Alle' }).click();
  await friend.fill('.chat-input textarea', 'Viel Glück, Eric!');
  await friend.getByRole('button', { name: 'Senden', exact: true }).click();
  await friend.getByRole('button', { name: 'Chat schließen' }).click();
  await host.getByRole('button', { name: 'Chat öffnen' }).click();
  await host.getByRole('tab', { name: 'Alle' }).click();
  await host.waitForSelector('text=Viel Glück, Eric!', { timeout: 15_000 });
  assert.equal(await host.locator('text=Geheim: Ich bin am Teich').count(), 0);
  await host.shot('chat');
  await host.getByRole('button', { name: 'Chat schließen' }).click();

  // Mia wurde gefunden (2 s halten) -> Spielende für beide
  const hb = await friend.locator('.hold-btn').boundingBox();
  await friend.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await friend.mouse.down();
  await friend.waitForTimeout(2300);
  await friend.mouse.up();
  await friend.waitForSelector('text=Sucher gewinnen', { timeout: 15_000 });
  await host.waitForSelector('text=Sucher gewinnen', { timeout: 15_000 });
  await host.waitForSelector('.replay .leaflet-container', { timeout: 15_000 });
  await host.shot('ergebnis');
  // Nach Spielende darf Eric den Gejagten-Chat lesen
  await host.btn('Chat ansehen').click();
  await host.getByRole('tab', { name: 'Gejagte' }).click();
  await host.waitForSelector('text=Geheim: Ich bin am Teich', { timeout: 15_000 });
  await host.getByRole('button', { name: 'Chat schließen' }).click();

  // Revanche: Rollen getauscht, Mia folgt über den Hinweis
  await host.btn('Revanche', true).click();
  await host.waitForSelector('text=Warteraum', { timeout: 15_000 });
  await friend.waitForSelector('text=Der Host hat eine Revanche gestartet', { timeout: 15_000 });
  await friend.btn('Zum Warteraum').click();
  await friend.waitForSelector('text=Warteraum', { timeout: 15_000 });
  const roles = await db.admin("select p.name, p.role from public.players p join public.games g on g.id = p.game_id where g.status = 'lobby' order by p.name");
  assert.deepEqual(roles.map((r) => `${r.name}:${r.role}`), ['Eric:hider', 'Mia:hunter']);

  assert.deepEqual(host.errors, []);
  assert.deepEqual(friend.errors, []);
});
