// Screen 4: Warteraum – Code/QR, Rollen, Spielerliste mit Tracker-Status, Start.
import { h, busy, toast, copyText, confirmDialog, setChildren } from '../../util/dom.js';
import { icon } from '../../util/icons.js';
import { formatCode, minutes, ago, ts } from '../../util/format.js';
import { normalizeSettings } from '../../core/engine.js';
import { header, rulesChips, avatar, rolePill, signalEl, signalInfo, privacyBody, ROLE, demoBanner } from '../components.js';
import qrcode from '../../../vendor/qrcode.esm.js';

const qrCache = {};
function qrSvg(text) {
  if (!qrCache[text]) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    qrCache[text] = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  return qrCache[text];
}

export function waitingScreen(ctx) {
  const el = h('div', { class: 'scr' });
  let timer = setInterval(() => render(ctx.snap()), 5000);

  function joinUrl(code) {
    const base = ctx.cfg.PUBLIC_URL || `${location.origin}${location.pathname}`;
    return `${base.replace(/[?#].*$/, '')}?join=${code}`;
  }

  async function leave() {
    const me = ctx.snap().me;
    const ok = await confirmDialog(me?.is_host ? 'Warteraum verlassen?' : 'Spiel verlassen?',
      me?.is_host ? 'Ein anderer Spieler wird Host. Bist du der Einzige, wird das Spiel gelöscht.' : 'Du kannst mit dem Code wieder beitreten.', 'Verlassen', true);
    if (ok) await ctx.backend.leaveGame().catch((e) => toast(e.message, 'bad'));
  }

  let lastKey = null;
  function render(snap) {
    const { game, players, me } = snap;
    if (!game || !me) return;
    const s = normalizeSettings(game.settings);
    const now = ctx.now();
    // Nur neu aufbauen, wenn sich Sichtbares geändert hat (sonst gehen Fingertipps verloren)
    const key = JSON.stringify([game.code, game.settings, game.area?.geometry?.coordinates, game.exclusions?.length, me.id,
      players.map((p) => [p.id, p.name, p.role, p.ready, p.is_host, p.status, signalInfo(p, now).text]),
      ctx.unread(), ctx.locError(), !!me.last_traccar_at && now - ts(me.last_traccar_at) < 180_000]);
    if (key === lastKey) return;
    lastKey = key;
    const isHost = me.is_host;
    const active = players.filter((p) => p.status !== 'left');
    const counts = { hunter: 0, hider: 0, random: 0 };
    active.forEach((p) => { counts[p.role] = (counts[p.role] || 0) + 1; });
    const url = joinUrl(game.code);

    const shareBtn = h('button', { class: 'btn sec sm', html: `${icon('share', 16)} Teilen` });
    shareBtn.addEventListener('click', async () => {
      const text = `Spiel mit bei ${ctx.cfg.APP_NAME}! Code: ${game.code}`;
      if (navigator.share) navigator.share({ title: ctx.cfg.APP_NAME, text, url }).catch(() => {});
      else copyText(`${text}\n${url}`);
    });

    const roleTile = (role, small) => {
      const r = ROLE[role];
      const disabled = s.role_mode === 'random' && role !== 'random';
      return h('button', {
        class: `role${me.role === role ? ' on' : ''}${role === 'hider' ? ' hidrole' : ''}`, disabled, 'aria-pressed': String(me.role === role),
        onclick: () => ctx.backend.setRole(role).catch((e) => toast(e.message, 'bad')),
      }, h('span', { class: `ri ${role === 'hider' ? 'hid' : role === 'random' ? 'mut' : ''}`, html: icon(r.icon, 22) }), h('b', {}, r.label), h('small', {}, small));
    };

    const nextRole = (r) => (r === 'hunter' ? 'hider' : r === 'hider' ? 'random' : 'hunter');
    const playerRow = (p) => {
      const isMe = p.id === me.id;
      return h('div', { class: 'pl' },
        avatar(p),
        h('div', { class: 'grow' },
          h('b', {}, p.name, p.is_host ? h('span', { class: 'crown', title: 'Host', html: icon('crown', 14) }) : null, isMe ? h('span', { class: 'sub' }, '(du)') : null),
          h('small', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, h('span', {}, p.ready ? 'bereit' : 'noch nicht bereit'), signalEl(p, now))),
        rolePill(p.role, isHost && s.role_mode !== 'random' ? () => ctx.backend.setPlayerRole(p.id, nextRole(p.role)).catch((e) => toast(e.message, 'bad')) : null),
        h('span', { class: `rdy${p.ready ? ' ok' : ''}`, title: p.ready ? 'bereit' : 'nicht bereit' }),
        isHost && !isMe ? h('button', { class: 'ib sm', 'aria-label': `${p.name} entfernen`, html: icon('close', 14), onclick: async () => {
          if (await confirmDialog(`${p.name} entfernen?`, 'Der Spieler fliegt aus dem Warteraum.', 'Entfernen', true)) ctx.backend.kick(p.id).catch((e) => toast(e.message, 'bad'));
        } }) : null);
    };

    const mySig = signalInfo(me, now);
    const traccarOk = me.last_traccar_at && now - ts(me.last_traccar_at) < 180_000;
    const start = h('button', { class: 'btn pri', disabled: !game.area || active.length < 2 }, 'Spiel starten');
    start.addEventListener('click', busy(start, async () => {
      const notReady = active.filter((p) => !p.ready && p.id !== me.id);
      const noSignal = active.filter((p) => signalInfo(p, now).cls === 'bad');
      const warn = [
        notReady.length ? `Noch nicht bereit: ${notReady.map((p) => p.name).join(', ')}.` : '',
        noSignal.length ? `Ohne Standortsignal: ${noSignal.map((p) => p.name).join(', ')}.` : '',
      ].filter(Boolean).join('\n');
      if (warn && !(await confirmDialog('Trotzdem starten?', warn, 'Starten'))) return;
      await ctx.backend.startGame();
    }));
    const readyBtn = h('button', { class: `btn ${me.ready ? 'sec' : 'pri'}`, html: me.ready ? `${icon('check', 18)} Bereit` : 'Ich bin bereit' });
    readyBtn.addEventListener('click', busy(readyBtn, () => ctx.backend.setReady(!me.ready)));

    setChildren(el,
      header({
        onBack: isHost ? () => ctx.setHostStep('area') : leave,
        backIcon: isHost ? 'back' : 'logout',
        backLabel: isHost ? 'Zum Spielgebiet' : 'Spiel verlassen',
        title: 'Warteraum',
        step: `${active.length} Spieler verbunden`,
        right: h('button', { class: 'ib', 'aria-label': 'Chat', style: { position: 'relative' }, onclick: () => ctx.openChat(), html: icon('chat') + (ctx.unread() ? '<span class="dot" style="position:absolute;top:6px;right:6px"></span>' : '') }),
      }),
      ctx.backend.mode === 'demo' ? demoBanner(() => ctx.switchBackend('supabase')) : null,
      h('div', { class: 'card codecard' },
        h('div', { class: 'grow' }, h('span', { class: 'lbl' }, 'Beitrittscode'), h('div', { class: 'bigcode' }, formatCode(game.code)),
          h('div', { class: 'two' }, shareBtn, h('button', { class: 'btn sec sm', html: `${icon('copy', 16)} Kopieren`, onclick: () => copyText(game.code) }))),
        h('div', { class: 'qr', role: 'img', 'aria-label': 'QR-Code zum Beitreten', html: qrSvg(url) })),
      rulesChips(game),
      isHost ? h('div', { class: 'two' },
        h('button', { class: 'btn sec sm', html: `${icon('gear', 16)} Regeln ändern`, onclick: () => ctx.setHostStep('settings') }),
        h('button', { class: 'btn sec sm', html: `${icon('area', 16)} Gebiet ändern`, onclick: () => ctx.setHostStep('area') })) : null,
      h('span', { class: 'lbl' }, 'Deine Rolle'),
      h('div', { class: 'roles' }, roleTile('hider', 'Verstecken'), roleTile('hunter', 'Aufspüren'), roleTile('random', 'Würfeln')),
      s.role_mode === 'random' ? h('p', { class: 'hint' }, 'Der Host lässt die Rollen beim Start zufällig verteilen.') : null,
      h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Spieler'),
        h('span', { class: 'sub' }, `${counts.hunter} Sucher · ${counts.hider} Gejagte${counts.random ? ` · ${counts.random} offen` : ''}`)),
      h('div', { class: 'card list' }, active.map(playerRow)),
      isHost && s.role_mode !== 'random' ? h('p', { class: 'hint' }, 'Tippe auf eine Rolle in der Liste, um sie für diesen Spieler festzulegen.') : null,
      readyBtn,
      h('div', { class: `card tight ${traccarOk ? '' : 'warnbox'}` },
        h('div', { class: 'row' }, h('div', { class: `ico-b sm ${traccarOk ? '' : 'bad'}`, html: icon('signal', 18) }),
          h('div', { class: 'grow' }, h('b', {}, traccarOk ? 'Hintergrund-Tracking läuft' : 'Hintergrund-Tracking einrichten'),
            h('p', { class: 'sub' }, traccarOk ? `Traccar meldet sich (${ago(now - ts(me.last_traccar_at))}).` : 'Ohne Traccar sendet dein Handy nur, solange die App offen und der Bildschirm an ist.'))),
        h('button', { class: 'btn sec sm', onclick: () => ctx.openHelp() }, traccarOk ? 'Anleitung ansehen' : 'Jetzt einrichten (2 Minuten)'),
        ctx.locError() ? h('p', { class: 'err-text' }, ctx.locError()) : null,
        !traccarOk && mySig.src === 'App' && mySig.cls === 'ok' ? h('p', { class: 'sub' }, 'Die App selbst sendet gerade (Vordergrund).') : null),
      h('details', { class: 'card more' },
        h('summary', {}, h('span', { class: 'lbl' }, 'Wer sieht was? (Datenschutz)'), h('span', { class: 'chev', html: icon('chevdown', 18) })),
        h('div', { style: { marginTop: '10px' } }, privacyBody(s))),
      isHost ? start : h('p', { class: 'hint' }, 'Warte, bis der Host das Spiel startet.'),
      isHost ? h('p', { class: 'hint' }, !game.area ? 'Lege zuerst das Spielgebiet fest.' : active.length < 2 ? 'Es braucht mindestens zwei Spieler.' : s.headstart_s ? `Nach dem Start haben die Gejagten ${minutes(s.headstart_s)} Vorsprung.` : 'Ohne Vorsprung geht die Jagd sofort los.') : null,
      h('button', { class: 'btn ghost', onclick: leave }, isHost ? 'Warteraum verlassen' : 'Spiel verlassen'),
      isHost ? h('button', { class: 'btn ghost', style: { color: 'var(--bad)' }, onclick: async () => {
        if (await confirmDialog('Spiel auflösen?', 'Das Spiel wird für alle gelöscht.', 'Auflösen', true)) {
          await ctx.backend.endGame().catch((e) => toast(e.message, 'bad'));
          ctx.backend.closeGame();
        }
      } }, 'Spiel auflösen') : null,
    );
  }

  render(ctx.snap());
  return {
    el,
    update: render,
    destroy() { clearInterval(timer); },
  };
}

