// Wiederverwendbare Bausteine der Oberfläche.
import { h, vibrate } from '../util/dom.js';
import { icon } from '../util/icons.js';
import { ago, minutes, meters, initials, ts } from '../util/format.js';
import { normalizeSettings } from '../core/engine.js';
import { areaM2, fmtKm2 } from '../core/geo.js';

export function header({ onBack, title, step, right = null, floaty = false, backIcon = 'back', backLabel = 'Zurück' }) {
  return h('div', { class: `hdr${floaty ? ' floaty' : ''}` },
    onBack ? h('button', { class: 'ib', 'aria-label': backLabel, onclick: onBack, html: icon(backIcon) }) : null,
    h('div', { class: 'ht' }, h('h2', {}, title), step ? h('span', { class: 'step' }, step) : null),
    right,
  );
}

export function chipGroup({ options, value, onChange, label }) {
  return h('div', { class: 'chips', role: 'group', 'aria-label': label || null },
    options.map((o) => h('button', {
      class: `chip${o.value === value ? ' on' : ''}`,
      'aria-pressed': o.value === value ? 'true' : 'false',
      onclick: () => onChange(o.value),
    }, o.label)));
}

export function seg({ options, value, onChange, label }) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label || null },
    options.map((o) => h('button', { class: o.value === value ? 'on' : '', 'aria-pressed': o.value === value ? 'true' : 'false', onclick: () => onChange(o.value) }, o.label)));
}

export function switchRow({ title, sub, value, onChange, iconName }) {
  return h('button', { class: 'row', style: { width: '100%', textAlign: 'left' }, role: 'switch', 'aria-checked': value ? 'true' : 'false', onclick: () => onChange(!value) },
    iconName ? h('div', { class: 'ico-b sm', html: icon(iconName, 18) }) : null,
    h('div', { class: 'grow' }, h('b', {}, title), sub ? h('p', { class: 'sub' }, sub) : null),
    h('span', { class: `sw${value ? ' on' : ''}` }, h('i')));
}

export function tiles(items, cls = '') {
  return h('div', { class: `tiles3 ${cls}` }, items.map((t) => h('div', { class: `tile ${t.cls || ''}` },
    h('span', { class: 'lbl' }, t.lbl),
    h('span', { class: 'v', 'data-key': t.key || null }, t.v),
    t.small ? h('small', {}, t.small) : null)));
}

export const ROLE = {
  hunter: { label: 'Sucher', plural: 'Sucher', cls: 'ac', icon: 'target' },
  hider: { label: 'Gejagter', plural: 'Gejagte', cls: 'hid', icon: 'shield' },
  random: { label: 'Zufall', plural: 'Zufall', cls: '', icon: 'dice' },
};

export function rolePill(role, onclick) {
  const r = ROLE[role] || ROLE.random;
  return h(onclick ? 'button' : 'span', { class: `pill ${r.cls}`, onclick: onclick || null }, r.label);
}

export function avatar(p, sm = false) {
  return h('span', { class: `av ${p.role === 'random' ? '' : p.role}${sm ? ' sm' : ''}` }, initials(p.name));
}

/** "Letztes Signal vor X s" mit Ampelfarbe. */
export function signalInfo(p, now = Date.now()) {
  const t = Math.max(ts(p.last_traccar_at) || 0, ts(p.last_web_at) || 0) || ts(p.last_signal_at);
  if (!t) return { text: 'kein Signal', cls: 'bad', ms: Infinity };
  const d = now - t;
  const src = (ts(p.last_traccar_at) || 0) >= (ts(p.last_web_at) || 0) ? 'Traccar' : 'App';
  const cls = d < 75_000 ? 'ok' : d < 300_000 ? 'warn' : 'bad';
  return { text: `${src} · ${d < 45_000 ? 'aktiv' : ago(d)}`, cls, ms: d, src };
}

export function signalEl(p, now) {
  const s = signalInfo(p, now);
  return h('span', { class: `sig ${s.cls}`, html: icon('signal', 12) + ' ' + s.text.replace(/</g, '&lt;') });
}

export function pingModeText(s) {
  if (s.ping_mode === 'exact') return 'Exakter Punkt';
  if (s.ping_mode === 'direction') return 'Richtung & Entfernung';
  return `Kreis ${s.ping_radius_m} m`;
}

export function rulesChips(game) {
  const s = normalizeSettings(game.settings);
  const area = game.area;
  const items = [
    `Ping ${minutes(s.ping_interval_s)}`,
    pingModeText(s),
    s.headstart_s ? `Vorsprung ${minutes(s.headstart_s)}` : 'Ohne Vorsprung',
    `Dauer ${minutes(s.duration_s)}`,
    area ? (area.properties?.shape === 'circle' ? `Zone ${meters(area.properties.radius_m)}` : `Gebiet ${fmtKm2(areaM2(area))}`) : 'Kein Gebiet',
    s.shrink_enabled ? `Schrumpft alle ${minutes(s.shrink_every_s)}` : null,
    `Strafe: ${s.boundary_penalty === 'eliminate' ? 'Ausscheiden' : 'Extra-Ping'}`,
    (s.joker_skip || s.joker_double || s.joker_decoy) ? 'Joker an' : null,
    (game.exclusions?.length ? `${game.exclusions.length} Sperrzone${game.exclusions.length > 1 ? 'n' : ''}` : null),
  ].filter(Boolean);
  return h('div', { class: 'chips rules' }, items.map((t) => h('span', { class: 'chip' }, t)));
}

/** "Wer sieht was?" – Datenschutz-Hinweis vor dem Spiel. */
export function privacyBody(settings) {
  const s = normalizeSettings(settings || {});
  const li = (t) => h('li', { style: { marginBottom: '6px' } }, t);
  return h('div', { class: 'stack' },
    h('ul', { class: 'sub', style: { paddingLeft: '18px', fontSize: '14px', color: 'var(--tx)' } },
      li('Sucher sehen von den Gejagten nie die echte Position, nur die Pings im eingestellten Takt (Punkt, Kreis oder Richtung).'),
      li(s.show_teammates ? 'Dein eigenes Team sieht deine Position live auf der Karte. Das andere Team nicht.' : 'Niemand sonst sieht deine Position live, auch dein Team nicht.'),
      li('Gejagte sehen die Sucher nicht.'),
      li('Der Server speichert Positionen nur, während ein Spiel läuft. Im Warteraum wird nur vermerkt, dass ein Signal ankam.'),
      li(`Standorte, Pings und Chat werden ${s.retention_h} h nach Spielende automatisch gelöscht. Nach dem Spiel sehen alle Mitspieler die Routen als Wiederholung.`),
      li('Außerdem gespeichert: gespeicherte Spielgebiete (365 Tage) und deine Tracker-Kennung für Traccar. Auf deinem Handy liegen Name, Anmeldung und Einstellungen. „Meine Daten löschen“ auf der Startseite entfernt alles auf dem Server.'),
      li('Keine Werbung, kein Tracking durch Dritte. Die Kartenbilder lädt dein Handy von OpenStreetMap (die sehen deine IP-Adresse und den Kartenausschnitt).'),
      li('Schalte Traccar nach dem Spiel aus. Der Server ignoriert Meldungen außerhalb eines Spiels.'),
    ));
}

/** Knopf, der 2 s gedrückt gehalten werden muss (gegen Fehltipps). */
export function holdButton({ label, ms = 2000, onDone, iconName = 'flag' }) {
  const fill = h('span', { class: 'hold' });
  const btn = h('button', { class: 'btn hold-btn', 'aria-label': `${label} (gedrückt halten)` },
    fill, h('span', { class: 'bt', html: `${icon(iconName)} <span></span>` }));
  btn.querySelector('.bt span').textContent = label;
  let start = 0, raf = 0, done = false;
  const reset = () => {
    cancelAnimationFrame(raf);
    start = 0;
    if (!done) fill.style.width = '0';
  };
  const step = () => {
    const p = Math.min(1, (performance.now() - start) / ms);
    fill.style.width = `${p * 100}%`;
    if (p >= 1) {
      done = true;
      vibrate(80);
      onDone();
      setTimeout(() => { done = false; fill.style.width = '0'; }, 1500);
      return;
    }
    raf = requestAnimationFrame(step);
  };
  const down = (e) => {
    e.preventDefault();
    if (start || done) return;
    start = performance.now();
    vibrate(15);
    raf = requestAnimationFrame(step);
  };
  btn.addEventListener('pointerdown', down);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, reset);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Tastatur: Leertaste/Enter gedrückt halten
  btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e); });
  btn.addEventListener('keyup', reset);
  return btn;
}

export function range({ min, max, step = 1, value, onInput, label, toSlider = (v) => v, fromSlider = (v) => v }) {
  const input = h('input', { type: 'range', min, max, step, value: toSlider(value), 'aria-label': label });
  const paint = () => input.style.setProperty('--p', `${((input.value - min) / (max - min)) * 100}%`);
  paint();
  input.addEventListener('input', () => { paint(); onInput(fromSlider(Number(input.value))); });
  return input;
}

export function demoBanner(onExit) {
  return h('div', { class: 'card tight demo-card' },
    h('div', { class: 'row between' }, h('b', {}, 'Demo-Modus'), h('button', { class: 'linkish', onclick: onExit }, 'Beenden')),
    h('p', { class: 'sub' }, 'Simulierte Mitspieler, alles läuft nur auf deinem Handy. Die Zeit läuft 10× schneller. Tippe auf die Karte, um dich zu bewegen.'));
}
