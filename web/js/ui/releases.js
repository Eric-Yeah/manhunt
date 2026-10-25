// Release Notes: nach einem Update einmalig anzeigen, jederzeit über die Startseite abrufbar.
import { h, modal } from '../util/dom.js';
import { load, save } from '../util/storage.js';
import { VERSION, RELEASES, releasesSince } from '../version.js';

function body(releases) {
  return h('div', { class: 'stack', style: { maxHeight: '60vh', overflowY: 'auto' } }, releases.map((r) =>
    h('div', { class: 'stack', style: { gap: '6px' } },
      h('strong', {}, `Version ${r.version}`, h('span', { class: 'sub' }, ` · ${new Date(r.date).toLocaleDateString('de-DE')}`)),
      h('ul', { class: 'sub', style: { paddingLeft: '18px', fontSize: '14px', color: 'var(--tx)' } },
        r.items.map((t) => h('li', { style: { marginBottom: '6px' } }, t))))));
}

/** Zeigt die Neuerungen seit der zuletzt gesehenen Version (nicht beim allerersten Start). */
export async function showNewReleases() {
  const seen = load('seenVersion');
  save('seenVersion', VERSION);
  const fresh = releasesSince(seen);
  if (!fresh.length) return;
  await modal({ title: 'Neu in Manhunt', body: body(fresh), buttons: [{ label: 'Los geht’s', value: true, kind: 'pri' }] });
}

/** Alle Release Notes (Link auf der Startseite). */
export function showAllReleases() {
  return modal({ title: `Neuigkeiten (Version ${VERSION})`, body: body(RELEASES), buttons: [{ label: 'Schließen', value: true, kind: 'pri' }] });
}
