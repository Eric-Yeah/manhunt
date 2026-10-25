// Screen 9: Hilfe "Tracking einrichten" (Traccar Client).
import { h, copyText, confirmDialog, toast, setChildren } from '../util/dom.js';
import { icon } from '../util/icons.js';
import { ago, ts } from '../util/format.js';

const APP_STORE = 'https://apps.apple.com/app/traccar-client/id843156974';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=org.traccar.client';

export function openHelp(ctx, onClose) {
  const isDemo = ctx.backend.mode === 'demo';
  const statusBox = h('div', { class: 'card tight' }, h('p', { class: 'sub' }, 'Lädt …'));
  const tokenBox = h('code', {}, '…');
  const urlBox = h('code', {}, '…');
  let tracker = null;
  let poll = null;

  const copyBtn = (getter, label) => h('button', { class: 'ib sm', 'aria-label': `${label} kopieren`, html: icon('copy', 16), onclick: () => getter() && copyText(getter()) });
  const kv = (rows) => h('div', { class: 'kv' }, rows.flatMap(([k, v]) => [h('span', { class: 'sub' }, k), h('b', {}, v)]));
  const step = (title, ...body) => h('div', { class: 'stp' }, h('div', {}, h('b', {}, title), ...body));

  async function refresh() {
    if (isDemo || !ctx.configured) {
      tokenBox.textContent = 'DEMO-OHNE-ECHTES-TRACKING';
      urlBox.textContent = ctx.configured ? '(im Demo-Modus nicht nötig)' : 'Erst nach der Supabase-Einrichtung verfügbar';
      setChildren(statusBox, h('p', { class: 'sub' }, 'Im Demo-Modus wird nichts gesendet. Die Anleitung gilt für echte Spiele.'));
      return;
    }
    try {
      tracker = await ctx.backend.getTracker();
      tokenBox.textContent = tracker.token;
      urlBox.textContent = tracker.url;
      const last = ts(tracker.last_request_at);
      const fresh = last && ctx.now() - last < 120_000;
      setChildren(statusBox,
        h('div', { class: 'row' },
          h('div', { class: `ico-b sm ${fresh ? '' : 'bad'}`, html: icon(fresh ? 'check' : 'signal', 18) }),
          h('div', { class: 'grow' },
            h('b', {}, fresh ? 'Signal kommt an' : last ? 'Gerade kein Signal' : 'Noch kein Signal empfangen'),
            h('p', { class: 'sub' }, last ? `Letzte Meldung ${ago(ctx.now() - last)} (${tracker.last_source === 'web' ? 'diese App' : 'Traccar'}).` : 'Starte die Ortung in Traccar. Diese Anzeige aktualisiert sich alle 5 Sekunden.'))));
    } catch (e) {
      setChildren(statusBox, h('p', { class: 'err-text' }, e.message));
    }
  }

  const regen = h('button', { class: 'btn ghost', onclick: async () => {
    if (isDemo || !ctx.configured) return;
    if (!(await confirmDialog('Neue Kennung erzeugen?', 'Die alte Kennung funktioniert danach nicht mehr. Du musst die neue in Traccar eintragen.', 'Neu erzeugen', true))) return;
    try {
      await ctx.backend.regenerateTracker();
      await refresh();
      toast('Neue Kennung erzeugt');
    } catch (e) {
      toast(e.message, 'bad');
    }
  } }, 'Kennung neu erzeugen');

  const wrap = h('div', { class: 'overlay', role: 'dialog', 'aria-label': 'Tracking einrichten' },
    h('div', { class: 'inner', style: { overflowY: 'auto' } },
      h('div', { class: 'scr' },
        h('div', { class: 'hdr' },
          h('button', { class: 'ib', 'aria-label': 'Schließen', html: icon('close'), onclick: close }),
          h('div', { class: 'ht' }, h('h2', {}, 'Tracking einrichten'), h('span', { class: 'step' }, 'Einmalig, etwa 2 Minuten'))),
        h('div', { class: 'card tight' },
          h('b', {}, 'Warum eine zweite App?'),
          h('p', { class: 'sub' }, 'Web-Apps dürfen auf dem iPhone im Hintergrund keinen Standort senden. Die kostenlose App „Traccar Client“ übernimmt das, auch bei gesperrtem Bildschirm. Ohne Traccar sendet nur diese App, solange sie offen ist.')),
        statusBox,
        h('div', { class: 'card' },
          h('div', { class: 'steps' },
            step('Traccar Client installieren',
              h('div', { class: 'two' },
                h('a', { class: 'btn sec sm', href: APP_STORE, target: '_blank', rel: 'noopener' }, 'App Store'),
                h('a', { class: 'btn sec sm', href: PLAY_STORE, target: '_blank', rel: 'noopener' }, 'Google Play'))),
            step('Gerätekennung eintragen',
              h('p', { class: 'sub' }, 'In Traccar unter „Gerätekennung“ (Device identifier) genau diesen Text einfügen:'),
              h('div', { class: 'copybox' }, tokenBox, copyBtn(() => tracker?.token, 'Kennung')),
              h('p', { class: 'sub', style: { color: 'var(--warn)' } }, 'Geheim halten! Wer die Kennung kennt, kann Standorte in deinem Namen senden.')),
            step('Server-URL eintragen',
              h('p', { class: 'sub' }, 'Unter „Server-URL“ die komplette Adresse einfügen:'),
              h('div', { class: 'copybox' }, urlBox, copyBtn(() => tracker?.url, 'Server-URL'))),
            step('Einstellungen setzen',
              kv([
                ['Standortgenauigkeit', 'Höchste (Highest)'],
                ['Entfernung', '10 m'],
                ['Intervall', '10 s'],
                ['Winkel', '30°'],
                ['Stillstand-Heartbeat', '60 s'],
                ['Offline-Pufferung', 'aus'],
                ['Stopp-Erkennung', 'aus'],
              ]),
              h('p', { class: 'sub' }, 'Die Namen können je nach Version leicht abweichen. Höchste Genauigkeit braucht mehr Akku, ist für ein Spiel von 1 bis 2 Stunden aber kein Problem.')),
            step('Standortzugriff: „Immer“',
              h('p', { class: 'sub' }, 'iPhone: Einstellungen → Traccar Client → Standort → „Immer“ und „Genauer Standort“ an.'),
              h('p', { class: 'sub' }, 'Android: Standort „Immer zulassen“, Akku-Optimierung für Traccar ausschalten (siehe dontkillmyapp.com).')),
            step('Ortung starten',
              h('p', { class: 'sub' }, 'In Traccar den Schalter für die Ortung einschalten. Oben auf dieser Seite siehst du, ob das Signal ankommt. Im Warteraum steht dann bei dir „Traccar · aktiv“.')),
            step('Nach dem Spiel ausschalten',
              h('p', { class: 'sub' }, 'Schalte die Ortung in Traccar wieder aus. Der Server speichert ohnehin nur während eines laufenden Spiels, aber es spart Akku.')))),
        h('div', { class: 'card tight' },
          h('b', {}, 'Wichtig fürs iPhone'),
          h('p', { class: 'sub' }, 'Wenn du die App zum Home-Bildschirm hinzufügst, ist sie dort ein eigenes „Gerät“ mit eigener Kennung. Richte Traccar deshalb mit der Kennung aus der Home-Bildschirm-App ein und nutze dann nur noch diese.')),
        regen)));

  function close() {
    clearInterval(poll);
    wrap.remove();
    onClose?.();
  }
  document.body.append(wrap);
  refresh();
  if (!isDemo && ctx.configured) poll = setInterval(refresh, 5000);
  return { close };
}
