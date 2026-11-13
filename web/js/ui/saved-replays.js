// Gespeicherte Wiederholungen (liegen auf diesem Gerät, siehe util/replays.js).
import { h, setChildren, confirmDialog } from '../util/dom.js';
import { icon } from '../util/icons.js';
import { dateTime, minutes } from '../util/format.js';
import { listReplays, deleteReplay } from '../util/replays.js';
import { mountReplay } from './replay.js';

function resultPill(r) {
  return h('span', { class: `pill ${r.winner === 'hiders' ? 'hid' : r.winner === 'hunters' ? 'ac' : ''}` },
    r.winner === 'hiders' ? 'Gejagte gewonnen' : r.winner === 'hunters' ? 'Sucher gewonnen' : 'Abgebrochen');
}

/** Öffnet eine Wiederholung im Vollbild. */
export function openSavedReplay(entry) {
  const box = h('div', { class: 'card', style: { padding: '0', overflow: 'hidden' } });
  let view = null;
  const wrap = h('div', { class: 'overlay', role: 'dialog', 'aria-label': 'Wiederholung' },
    h('div', { class: 'inner', style: { overflowY: 'auto' } },
      h('div', { class: 'scr' },
        h('div', { class: 'hdr' },
          h('button', { class: 'ib', 'aria-label': 'Schließen', html: icon('close'), onclick: close }),
          h('div', { class: 'ht' }, h('h2', {}, entry.title || 'Runde'), h('span', { class: 'step' }, `${dateTime(entry.at)} · ${minutes(Math.round((entry.duration_ms || 0) / 1000))}`))),
        box,
        h('div', { class: 'row between' }, resultPill(entry), h('span', { class: 'sub' }, `${entry.players.length} Spieler`)),
        h('div', { class: 'card list' }, entry.players.filter((p) => p.status !== 'left').map((p) => h('div', { class: 'pl' },
          h('div', { class: 'grow' }, h('b', {}, p.name)),
          h('span', { class: `pill ${(p.start_role || p.role) === 'hider' ? 'hid' : 'ac'}` }, (p.start_role || p.role) === 'hider' ? 'Gejagter' : 'Sucher')))))));
  function close() {
    view?.destroy();
    wrap.remove();
  }
  document.body.append(wrap);
  view = mountReplay(box, entry);
  return { close };
}

/** Karte für die Startseite oder null, wenn nichts gespeichert ist. */
export function savedReplaysCard() {
  const list = listReplays();
  if (!list.length) return null;
  const body = h('div', { class: 'stack' });
  const card = h('div', { class: 'card' }, h('span', { class: 'lbl' }, 'Gespeicherte Wiederholungen'), body);
  const render = () => {
    const rows = listReplays();
    if (!rows.length) return card.replaceWith(h('span'));
    setChildren(body, rows.map((r) => h('div', { class: 'row between' },
      h('button', { class: 'grow', style: { textAlign: 'left' }, 'aria-label': `Wiederholung ${r.title} ansehen`, onclick: () => openSavedReplay(r) },
        h('b', {}, r.title || 'Runde'),
        h('small', { class: 'sub', style: { display: 'block' } }, `${dateTime(r.at)} · ${minutes(Math.round((r.duration_ms || 0) / 1000))} · ${r.winner === 'hiders' ? 'Gejagte' : r.winner === 'hunters' ? 'Sucher' : 'abgebrochen'}`)),
      h('button', { class: 'ib sm', 'aria-label': 'Wiederholung löschen', html: icon('trash', 16), onclick: async () => {
        if (await confirmDialog('Wiederholung löschen?', 'Sie wird von diesem Handy entfernt.', 'Löschen', true)) {
          deleteReplay(r.id);
          render();
        }
      } }))));
  };
  render();
  return card;
}
