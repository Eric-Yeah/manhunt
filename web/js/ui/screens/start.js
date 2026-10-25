// Screen 1: Start / Lobby – Spiel erstellen, Code eingeben, Hell/Dunkel.
import { h, append, busy, toast, modal } from '../../util/dom.js';
import { icon, logoSvg } from '../../util/icons.js';
import { dateTime, minutes } from '../../util/format.js';
import { privacyBody } from '../components.js';
import { load } from '../../util/storage.js';

export function startScreen(ctx) {
  const { cfg } = ctx;
  let code = (ctx.pendingJoinCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const el = h('div', { class: 'scr' });

  const nameInput = h('input', { class: 'field', maxlength: 24, value: ctx.getName(), placeholder: 'z. B. Eric', autocomplete: 'nickname', 'aria-label': 'Dein Name' });
  nameInput.addEventListener('change', () => ctx.setName(nameInput.value));

  const codeInput = h('input', { inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', maxlength: 8, 'aria-label': 'Beitrittscode' });
  const boxes = Array.from({ length: 6 }, () => h('span', { class: 'cb' }));
  const joinBtn = h('button', { class: 'btn pri' }, 'Beitreten');
  const paintCode = () => {
    boxes.forEach((b, i) => {
      b.textContent = code[i] || '';
      b.classList.toggle('cur', document.activeElement === codeInput && i === Math.min(code.length, 5));
    });
    joinBtn.disabled = code.length !== 6;
  };
  codeInput.value = code;
  codeInput.addEventListener('input', () => {
    code = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    codeInput.value = code;
    paintCode();
  });
  codeInput.addEventListener('focus', paintCode);
  codeInput.addEventListener('blur', paintCode);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && code.length === 6) joinBtn.click(); });

  const needName = () => {
    const n = nameInput.value.trim();
    if (!n) {
      nameInput.focus();
      throw new Error('Gib zuerst deinen Namen ein.');
    }
    ctx.setName(n);
    return n;
  };

  const createBtn = h('button', { class: 'btn pri' }, 'Neues Spiel erstellen');
  createBtn.addEventListener('click', busy(createBtn, async () => {
    const n = needName();
    await ctx.backend.createGame(n);
  }));
  joinBtn.addEventListener('click', busy(joinBtn, async () => {
    const n = needName();
    if (ctx.backend.mode === 'demo') throw new Error('Im Demo-Modus kannst du nur selbst ein Spiel erstellen.');
    await ctx.backend.joinGame(code, n);
  }));
  const qrBtn = h('button', { class: 'btn sec', html: `${icon('qr', 18)} QR scannen` });
  qrBtn.addEventListener('click', busy(qrBtn, async () => {
    const { scanQr } = await import('../scanner.js');
    const found = await scanQr();
    if (found) {
      code = found;
      codeInput.value = code;
      paintCode();
      if (nameInput.value.trim()) joinBtn.click();
    }
  }));

  const theme = ctx.getTheme();
  const tgl = h('div', { class: 'tgl', role: 'group', 'aria-label': 'Darstellung' },
    h('button', { class: theme === 'light' ? 'on' : '', 'aria-label': 'Hell', 'aria-pressed': String(theme === 'light'), html: icon('sun', 16), onclick: () => ctx.setTheme('light') }),
    h('button', { class: theme !== 'light' ? 'on' : '', 'aria-label': 'Dunkel', 'aria-pressed': String(theme !== 'light'), html: icon('moon', 16), onclick: () => ctx.setTheme('dark') }));

  const last = load('lastRound');
  const isDemo = ctx.backend.mode === 'demo';

  // append() aus dom.js überspringt null; das native el.append() würde "null" als Text einfügen.
  append(el, [
    h('div', { class: 'toprow' }, h('span', { class: 'lbl' }, `Version ${cfg.VERSION}${isDemo ? ' · Demo' : ''}`), tgl),
    h('div', { class: 'brand' }, h('div', { class: 'logowrap', html: logoSvg(92) }), h('h1', {}, cfg.APP_NAME), h('p', { class: 'tag' }, cfg.TAGLINE)),
    !ctx.configured ? h('div', { class: 'card warnbox' },
      h('b', {}, 'Noch nicht mit Supabase verbunden'),
      h('p', { class: 'sub' }, 'Trage SUPABASE_URL und SUPABASE_KEY in web/js/config.js ein (siehe README). Bis dahin kannst du alles im Demo-Modus mit simulierten Mitspielern ausprobieren.')) : null,
    isDemo ? h('div', { class: 'card tight demo-card' },
      h('div', { class: 'row between' }, h('b', {}, 'Demo-Modus aktiv'), ctx.configured ? h('button', { class: 'linkish', onclick: () => ctx.switchBackend('supabase') }, 'Beenden') : null),
      h('p', { class: 'sub' }, 'Du spielst gegen simulierte Mitspieler. Nichts verlässt dein Handy.')) : null,
    h('div', { class: 'card' }, h('span', { class: 'lbl' }, 'Dein Name'), nameInput),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'ico-b', html: icon('flag', 22) }),
        h('div', { class: 'grow' }, h('h3', {}, 'Spiel erstellen'), h('p', { class: 'sub' }, 'Du wirst Host und legst Regeln und Spielgebiet fest.'))),
      createBtn),
    !isDemo ? h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'ico-b', html: icon('users', 22) }),
        h('div', { class: 'grow' }, h('h3', {}, 'Spiel beitreten'), h('p', { class: 'sub' }, '6-stelligen Code eingeben oder QR scannen.'))),
      h('label', { class: 'code' }, boxes, codeInput),
      h('div', { class: 'two' }, qrBtn, joinBtn)) : null,
    last ? h('div', { class: 'card tight' },
      h('span', { class: 'lbl' }, 'Letzte Runde'),
      h('div', { class: 'row between' }, h('b', {}, last.title || 'Runde'),
        h('span', { class: `pill ${last.winner === 'hiders' ? 'hid' : last.winner === 'hunters' ? 'ac' : ''}` }, last.winner === 'hiders' ? 'Gejagte gewonnen' : last.winner === 'hunters' ? 'Sucher gewonnen' : 'Abgebrochen')),
      h('p', { class: 'sub' }, `${minutes(Math.round((last.duration_ms || 0) / 1000))} · ${last.players} Spieler · ${dateTime(last.at)}`)) : null,
    h('div', { class: 'stack', style: { gap: '2px', alignItems: 'center' } },
      h('button', { class: 'linkish', onclick: () => ctx.openHelp() }, 'Tracking im Hintergrund einrichten'),
      h('button', { class: 'linkish', onclick: () => modal({ title: 'Wer sieht was?', body: privacyBody({}) }) }, 'Wer sieht was? (Datenschutz)'),
      ctx.configured && !isDemo ? h('button', { class: 'linkish', onclick: () => ctx.switchBackend('demo') }, 'Demo mit simulierten Mitspielern') : null,
    ),
  ]);
  paintCode();
  if (ctx.pendingJoinCode && code.length === 6) {
    ctx.pendingJoinCode = null;
    if (nameInput.value.trim()) setTimeout(() => joinBtn.click(), 50);
    else toast('Gib deinen Namen ein und tippe auf „Beitreten“.');
  }
  return { el, update() {}, destroy() {} };
}
