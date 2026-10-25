// Chat mit drei Kanälen: hunters (nur Sucher), hiders (nur Gejagte), all (alle).
// Wer was lesen darf, entscheidet die Datenbank (RLS). Die App zeigt nur an, was sie bekommt.
import { h, toast, setChildren } from '../util/dom.js';
import { icon } from '../util/icons.js';
import { clock, ts } from '../util/format.js';
import { load, save } from '../util/storage.js';

const CH = {
  hunters: { label: 'Sucher', cls: 'ac' },
  hiders: { label: 'Gejagte', cls: 'hid' },
  all: { label: 'Alle', cls: '' },
};

function teamChannel(me) {
  return me?.role === 'hunter' ? 'hunters' : me?.role === 'hider' ? 'hiders' : null;
}

export function channelsFor(snap) {
  if (snap.game?.status === 'ended') return ['hunters', 'hiders', 'all'];
  const t = teamChannel(snap.me);
  return t ? [t, 'all'] : ['all'];
}

function seenKey(gameId) {
  return `seen:${gameId}`;
}

export function unreadByChannel(snap) {
  if (!snap.game || !snap.me) return {};
  const seen = load(seenKey(snap.game.id), {});
  const out = {};
  for (const c of channelsFor(snap)) {
    out[c] = snap.messages.some((m) => m.channel === c && m.id > (seen[c] || 0) && m.player_id !== snap.me.id);
  }
  return out;
}

export function hasUnread(snap) {
  return Object.values(unreadByChannel(snap)).some(Boolean);
}

export function openChat(ctx, onClose) {
  let snap = ctx.snap();
  let channel = load('chatChannel') || 'all';
  if (!channelsFor(snap).includes(channel)) channel = channelsFor(snap)[0];
  let announce = false;

  const tabs = h('div', { class: 'seg chat-tabs', role: 'tablist' });
  const list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'field', rows: 1, maxlength: 500, placeholder: 'Nachricht …', 'aria-label': 'Nachricht' });
  const annBtn = h('button', { class: 'ann', 'aria-label': 'Als Host-Ansage senden', title: 'Als Ansage hervorheben', html: icon('megaphone') });
  const sendBtn = h('button', { class: 'send', 'aria-label': 'Senden', html: icon('send') });
  const inputBar = h('div', { class: 'chat-input' }, annBtn, input, sendBtn);
  const info = h('p', { class: 'sub' });
  const wrap = h('div', { class: 'overlay', role: 'dialog', 'aria-label': 'Chat' },
    h('div', { class: 'inner' },
      h('div', { class: 'chat-head' },
        h('div', { class: 'hdr' },
          h('button', { class: 'ib', 'aria-label': 'Chat schließen', html: icon('close'), onclick: close }),
          h('div', { class: 'ht' }, h('h2', {}, 'Chat'), info)),
        tabs),
      list, inputBar));

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  annBtn.addEventListener('click', () => {
    announce = !announce;
    annBtn.classList.toggle('on', announce);
  });
  sendBtn.addEventListener('click', send);

  async function send() {
    const body = input.value.trim();
    if (!body || sendBtn.disabled) return;
    sendBtn.disabled = true;
    try {
      await ctx.backend.sendMessage(channel, body, announce && channel === 'all');
      input.value = '';
      input.style.height = 'auto';
      announce = false;
      annBtn.classList.remove('on');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function markSeen() {
    const ids = snap.messages.filter((m) => m.channel === channel).map((m) => m.id);
    if (!ids.length || !snap.game) return;
    const seen = load(seenKey(snap.game.id), {});
    seen[channel] = Math.max(seen[channel] || 0, ...ids);
    save(seenKey(snap.game.id), seen);
  }

  function render() {
    const chans = channelsFor(snap);
    if (!chans.includes(channel)) channel = chans[0];
    const unread = unreadByChannel(snap);
    setChildren(tabs, chans.map((c) => h('button', {
      class: channel === c ? 'on' : '', role: 'tab', 'aria-selected': String(channel === c),
      onclick: () => { channel = c; save('chatChannel', c); render(); },
    }, c === 'all' ? 'Alle' : snap.game?.status === 'ended' ? CH[c].label : `Team (${CH[c].label})`, unread[c] && channel !== c ? h('span', { class: 'dot tabdot' }) : null)));

    const ended = snap.game?.status === 'ended';
    info.textContent = channel === 'all'
      ? 'Alle Spieler lesen mit.'
      : ended ? `Nach Spielende für alle lesbar (vorher nur ${CH[channel].label}).` : `Nur ${CH[channel].label} lesen mit.`;

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const msgs = snap.messages.filter((m) => m.channel === channel);
    setChildren(list, msgs.length ? msgs.map((m) => {
      const mine = m.player_id && m.player_id === snap.me?.id;
      if (m.kind === 'system') return h('div', { class: 'msg sys' }, h('div', { class: 'bub' }, m.body, ` · ${clock(ts(m.created_at))}`));
      if (m.kind === 'sos') return h('div', { class: 'msg sos' }, h('div', { class: 'bub' }, `⚠ ${m.body}`), h('span', { class: 'who', style: { textAlign: 'center' } }, clock(ts(m.created_at))));
      return h('div', { class: `msg${mine ? ' me' : ''}${m.kind === 'host' ? ' host' : ''}` },
        h('span', { class: 'who' }, `${m.kind === 'host' ? 'Ansage · ' : ''}${mine ? 'Du' : m.sender_name || '?'} · ${clock(ts(m.created_at))}`),
        h('div', { class: 'bub' }, m.body));
    }) : h('p', { class: 'empty' }, channel === 'all' ? 'Noch keine Nachrichten.' : 'Noch nichts im Team-Chat. Plant hier eure Taktik.'));
    if (nearBottom || !render.done) list.scrollTop = list.scrollHeight;
    render.done = true;

    const canSend = !!snap.me && (channel === 'all' || (!ended && channel === teamChannel(snap.me)));
    inputBar.hidden = !canSend;
    annBtn.hidden = !(snap.me?.is_host && channel === 'all');
    markSeen();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    wrap.remove();
    unsub();
    onClose?.();
  }
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const unsub = ctx.backend.on((s) => {
    snap = s;
    if (!s.game) return close();
    render();
  });
  document.body.append(wrap);
  render();
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus(), 50);
  return { close };
}
