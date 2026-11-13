// Screen 7: Ergebnis mit Routen-Wiederholung und Revanche.
import { h, busy, setChildren } from '../../util/dom.js';
import { icon } from '../../util/icons.js';
import { mmss, ts, dateTime } from '../../util/format.js';
import { save } from '../../util/storage.js';
import { saveReplay, buildReplayEntry } from '../../util/replays.js';
import { startRole } from '../../core/engine.js';
import { mountReplay } from '../replay.js';
import { avatar } from '../components.js';

export function resultScreen(ctx) {
  const el = h('div', { class: 'scr' });
  const replayBox = h('div', { class: 'card', style: { padding: '0', overflow: 'hidden' } });
  const savedHint = h('p', { class: 'hint', hidden: true });
  let view = null;
  let built = false;

  function summary(snap) {
    const g = snap.game;
    const hiders = snap.players.filter((p) => startRole(p) === 'hider');
    return {
      winner: g.winner,
      reason: g.end_reason,
      durationMs: Math.max(0, ts(g.ended_at) - ts(g.started_at)),
      found: hiders.filter((p) => p.status === 'found' || p.status === 'eliminated' || p.found_at || p.role === 'hunter').length,
      hiders: hiders.length,
      pings: Math.max(0, ...snap.pings.map((p) => p.seq)),
    };
  }

  function rememberRound(snap) {
    const s = summary(snap);
    save('lastRound', {
      title: snap.game.area?.properties?.name || `Runde mit ${snap.players.length} Spielern`,
      winner: s.winner, duration_ms: s.durationMs, players: snap.players.filter((p) => p.status !== 'left').length,
      at: ts(snap.game.ended_at) || Date.now(),
    });
  }

  async function buildReplay(snap) {
    let replay;
    try {
      replay = await ctx.backend.getReplay();
    } catch (e) {
      setChildren(replayBox, h('p', { class: 'sub', style: { padding: '16px' } }, `Wiederholung nicht verfügbar: ${e.message}`));
      return;
    }
    const entry = buildReplayEntry(snap, replay, { ts });
    view = mountReplay(replayBox, entry);
    // Auf dem Gerät speichern, damit sie auch nach dem Verlassen der Lobby abrufbar bleibt
    if (entry.tracks.length && saveReplay(entry)) {
      savedHint.textContent = 'Diese Wiederholung ist auf deinem Handy gespeichert. Du findest sie auf der Startseite unter „Gespeicherte Wiederholungen“.';
      savedHint.hidden = false;
    }
  }

  let lastKey = null;
  function render(snap) {
    const g = snap.game, me = snap.me;
    if (!g || !me) return;
    const key = JSON.stringify([g.status, g.winner, g.rematch_id, g.purge_at, me.is_host, snap.pings.length, snap.players.map((p) => [p.id, p.status, p.role])]);
    if (key === lastKey) return;
    lastKey = key;
    const s = summary(snap);
    const hidersWin = s.winner === 'hiders';
    const title = s.winner === 'hiders' ? 'Gejagte gewinnen' : s.winner === 'hunters' ? 'Sucher gewinnen' : 'Spiel abgebrochen';
    const reason = s.reason === 'time' ? 'Zeit abgelaufen' : s.reason === 'all_found' ? 'Alle gefunden' : 'Vom Host beendet';
    const survivors = snap.players.filter((p) => p.role === 'hider' && p.status === 'active').map((p) => p.name);
    const huntDur = Math.max(0, ts(g.ended_at) - ts(g.hunt_starts_at));
    const sub = s.winner === 'hiders'
      ? `${survivors.join(' und ') || 'Die Gejagten'} ${survivors.length === 1 ? 'blieb' : 'blieben'} ${mmss(huntDur)} unentdeckt.`
      : s.winner === 'hunters' ? `Alle Gejagten nach ${mmss(huntDur)} Jagd gefunden.` : 'Ohne Sieger.';
    const rematchBtn = h('button', { class: 'btn pri', disabled: !me.is_host }, 'Revanche');
    rematchBtn.addEventListener('click', busy(rematchBtn, async () => {
      rememberRound(snap);
      await ctx.backend.rematch();
    }));
    const lobbyBtn = h('button', { class: 'btn sec', onclick: () => { rememberRound(snap); ctx.dismissResult(g.id); } }, 'Zur Lobby');
    const hiders = snap.players.filter((p) => startRole(p) === 'hider');
    const hunters = snap.players.filter((p) => startRole(p) === 'hunter');

    const parts = [
      h('div', { class: `trophy ${hidersWin ? 'hid' : ''}` }, h('span', { class: 'tr', html: icon('trophy', 42) })),
      h('div', { class: 'center' }, h('span', { class: 'lbl' }, `Runde beendet · ${reason}`), h('h1', { class: s.winner === 'hiders' ? 'win-hiders' : s.winner === 'hunters' ? 'win-hunters' : '' }, title), h('p', { class: 'sub' }, sub)),
      h('div', { class: 'tiles3 on-bg' },
        tileEl('Dauer', mmss(s.durationMs)), tileEl('Gefunden', `${s.found} / ${s.hiders}`), tileEl('Pings', String(s.pings))),
      g.rematch_id ? h('div', { class: 'card tight', style: { border: '1.5px solid var(--ac)' } },
        h('b', {}, 'Der Host hat eine Revanche gestartet'),
        h('p', { class: 'sub' }, 'Gleiche Regeln, gleiches Gebiet, Rollen getauscht. Du bist schon eingetragen.'),
        h('button', { class: 'btn pri', onclick: () => ctx.openGameById(g.rematch_id) }, 'Zum Warteraum')) : null,
      replayBox,
      savedHint,
      h('span', { class: 'lbl' }, 'Ergebnis Gejagte'),
      h('div', { class: 'card list' }, hiders.map((p) => h('div', { class: 'pl' }, avatar(p),
        h('div', { class: 'grow' }, h('b', {}, p.name), h('small', {}, p.found_at ? `gefunden bei ${mmss(ts(p.found_at) - ts(g.hunt_starts_at))}${p.role === 'hunter' ? ', jagte danach mit' : ''}` : p.status === 'eliminated' ? 'ausgeschieden (Grenze)' : p.status === 'left' ? 'hat verlassen' : `überlebt ${mmss(huntDur)}`)),
        h('span', { class: `pill ${p.status === 'active' && p.role === 'hider' ? (s.winner ? 'ok' : '') : 'bad'}` }, p.status === 'active' && p.role === 'hider' ? (s.winner ? 'Sieg' : 'frei') : p.found_at ? 'Gefunden' : p.status === 'active' ? 'Sucher' : 'Raus')))),
      h('span', { class: 'lbl' }, 'Sucher'),
      h('div', { class: 'card list' }, hunters.map((p) => h('div', { class: 'pl' }, avatar(p), h('div', { class: 'grow' }, h('b', {}, p.name)), h('span', { class: `pill ${s.winner === 'hunters' ? 'ok' : ''}` }, s.winner === 'hunters' ? 'Sieg' : 'Sucher')))),
      h('button', { class: 'btn sec', html: `${icon('chat', 18)} Chat ansehen (jetzt alle Kanäle)`, onclick: () => ctx.openChat() }),
      h('div', { class: 'two' }, lobbyBtn, rematchBtn),
      h('p', { class: 'hint' }, me.is_host ? 'Revanche tauscht die Rollen. Gleiche Regeln, gleiches Gebiet.' : 'Die Revanche startet der Host.'),
      g.purge_at ? h('p', { class: 'hint' }, `Standorte, Pings und Chat werden ${dateTime(ts(g.purge_at))} Uhr automatisch gelöscht.`) : null,
    ];
    // Wiederholungs-Karte nicht bei jedem Update neu aufbauen
    const keep = replayBox;
    setChildren(el, ...parts);
    if (!built) {
      built = true;
      setChildren(keep, h('p', { class: 'sub', style: { padding: '16px' } }, 'Lade Wiederholung …'));
      buildReplay(snap);
    }
    view?.invalidate();
  }

  function tileEl(lbl, v) {
    return h('div', { class: 'tile' }, h('span', { class: 'lbl' }, lbl), h('span', { class: 'v' }, v));
  }

  render(ctx.snap());
  rememberRound(ctx.snap());
  return {
    el,
    update: render,
    destroy() {
      view?.destroy();
    },
  };
}

