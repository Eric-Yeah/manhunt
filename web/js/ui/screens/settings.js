// Screen 2: Host-Einstellungen (Schritt 1 von 3).
import { h, busy, promptDialog, confirmDialog, setChildren } from '../../util/dom.js';
import { icon } from '../../util/icons.js';
import { minutes } from '../../util/format.js';
import { normalizeSettings } from '../../core/engine.js';
import { computeZoneStages } from '../../core/zone.js';
import { header, chipGroup, seg, switchRow, tiles, range, pingModeText } from '../components.js';

export function settingsScreen(ctx) {
  const game = ctx.snap().game;
  let s = normalizeSettings({ ...game.settings, ping_mode: 'distance' }); // andere Ping-Modi gibt es nur noch für alte Spiele
  const el = h('div', { class: 'scr' });
  const body = h('div', { class: 'stack', style: { gap: '14px' } });

  const set = (patch) => {
    s = normalizeSettings({ ...s, ...patch });
    render();
  };

  const back = async () => {
    if (ctx.snap().game?.area) return ctx.setHostStep('waiting');
    if (await confirmDialog('Spiel auflösen?', 'Das Spiel wird gelöscht. Mitspieler im Warteraum fliegen raus.', 'Auflösen', true)) {
      await ctx.backend.endGame().catch(() => {});
      ctx.backend.closeGame();
    }
  };

  const save = h('button', { class: 'btn pri', html: `Weiter: Spielgebiet ${icon('next', 18)}` });
  save.addEventListener('click', busy(save, async () => {
    const patch = { settings: s };
    const area = ctx.snap().game?.area;
    if (area) patch.zone_stages = computeZoneStages(area, s).stages;
    await ctx.backend.updateGame(patch);
    ctx.setHostStep('area');
  }));

  function intervalCard() {
    const opts = [60, 120, 300, 600, 900].map((v) => ({ label: minutes(v), value: v }));
    const isCustom = !opts.some((o) => o.value === s.ping_interval_s);
    const chips = chipGroup({ options: opts, value: s.ping_interval_s, onChange: (v) => set({ ping_interval_s: v }), label: 'Ping-Intervall' });
    chips.append(h('button', {
      class: `chip${isCustom ? ' on' : ''}`,
      onclick: async () => {
        const v = await promptDialog('Eigenes Intervall', { label: 'Minuten zwischen zwei Pings (1 bis 60)', value: String(Math.round(s.ping_interval_s / 60)), okLabel: 'Übernehmen' });
        const n = Number(String(v || '').replace(',', '.'));
        if (Number.isFinite(n) && n > 0) set({ ping_interval_s: Math.round(n * 60) });
      },
    }, isCustom ? `${minutes(s.ping_interval_s)} ✎` : 'Eigene…'));
    return h('div', { class: 'card' },
      h('div', { class: 'cl' }, h('span', { class: 'lbl' }, 'Ping-Intervall'), h('span', { class: 'val' }, `alle ${minutes(s.ping_interval_s)}`)),
      h('p', { class: 'sub' }, 'Wie oft die Sucher ein Standort-Update der Gejagten bekommen.'),
      chips);
  }

  function modeCard() {
    return h('div', { class: 'card' },
      h('div', { class: 'cl' }, h('span', { class: 'lbl' }, 'Was ein Ping zeigt'), h('span', { class: 'pill ac' }, 'Genauer Punkt + Entfernung')),
      h('p', { class: 'sub' }, 'Bei jedem Ping sieht jeder Sucher, wie viele Meter er vom Gejagten entfernt ist. Keine Richtung, kein Kreis, kein Punkt auf der Karte. Mit mehreren Suchern lässt sich der Gejagte durch Vergleichen eingrenzen.'));
  }

  function timeCard() {
    const slider = range({ min: 15, max: 180, step: 5, value: s.duration_s / 60, label: 'Spieldauer in Minuten', onInput: (v) => { s.duration_s = v * 60; durVal.textContent = minutes(s.duration_s); } });
    slider.addEventListener('change', () => render());
    return h('div', { class: 'card' },
      h('div', { class: 'cl' }, h('span', { class: 'lbl' }, 'Vorsprung der Gejagten'), h('span', { class: 'val' }, s.headstart_s ? minutes(s.headstart_s) : 'ohne')),
      chipGroup({ options: [0, 300, 600, 900].map((v) => ({ label: v ? minutes(v) : 'Ohne', value: v })), value: s.headstart_s, onChange: (v) => set({ headstart_s: v }), label: 'Vorsprung' }),
      h('div', { class: 'cl', style: { marginTop: '6px' } }, h('span', { class: 'lbl' }, 'Spieldauer'), h('span', { class: 'val big' }, minutes(s.duration_s))),
      slider,
      h('div', { class: 'scale' }, h('span', {}, '15'), h('span', {}, '60'), h('span', {}, '120'), h('span', {}, '180 min')),
      h('p', { class: 'sub' }, 'Die Spieldauer zählt ab Ende des Vorsprungs. Läuft sie ab, gewinnen die Gejagten.'));
  }
  let durVal = h('span');

  function rolesCard() {
    return h('div', { class: 'card' },
      h('span', { class: 'lbl' }, 'Rollen'),
      seg({ options: [{ label: 'Selbst wählen', value: 'choose' }, { label: 'Zufällig', value: 'random' }], value: s.role_mode, onChange: (v) => set({ role_mode: v }) }),
      h('p', { class: 'sub' }, s.role_mode === 'random'
        ? 'Beim Start wird gelost: etwa ein Drittel Sucher, der Rest Gejagte.'
        : 'Jeder wählt im Warteraum selbst. Du kannst Rollen dort auch für andere festlegen. Wer „Zufall“ wählt, wird beim Start verteilt.'));
  }

  function boundaryCard() {
    return h('div', { class: 'card' },
      h('span', { class: 'lbl' }, 'Strafe außerhalb der Grenze'),
      seg({ options: [{ label: 'Extra-Ping', value: 'extra_ping' }, { label: 'Ausscheiden', value: 'eliminate' }], value: s.boundary_penalty, onChange: (v) => set({ boundary_penalty: v }) }),
      h('div', { class: 'cl' }, h('span', { class: 'sub' }, 'Warnzeit bis zur Strafe'), h('span', { class: 'val' }, `${s.boundary_warn_s} s`)),
      chipGroup({ options: [15, 30, 60, 120].map((v) => ({ label: `${v} s`, value: v })), value: s.boundary_warn_s, onChange: (v) => set({ boundary_warn_s: v }) }),
      h('p', { class: 'sub' }, `Gilt für Gejagte (auch in Sperrzonen). Erst wer mehr als ${s.boundary_tolerance_m} m plus GPS-Ungenauigkeit draußen ist, bekommt den Countdown.`));
  }

  /** Schieberegler mit Plus/Minus-Knöpfen für feine Einstellungen. */
  function fineSlider({ min, max, step = 1, value, label, scale, fmt, onChange }) {
    const val = h('span', { class: 'val big' }, fmt(value));
    const input = range({ min, max, step, value, label, onInput: (v) => { val.textContent = fmt(v); onChange(v); } });
    input.classList.add('grow');
    input.addEventListener('change', () => render());
    const nudge = (d) => {
      const v = Math.min(max, Math.max(min, Number(input.value) + d * step));
      input.value = v;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
    };
    return h('div', { class: 'stack', style: { gap: '6px' } },
      h('div', { class: 'cl' }, h('span', { class: 'sub' }, label), val),
      h('div', { class: 'fine' },
        h('button', { class: 'ib sm', 'aria-label': `${label}: eins weniger`, onclick: () => nudge(-1) }, '−'),
        input,
        h('button', { class: 'ib sm', 'aria-label': `${label}: eins mehr`, onclick: () => nudge(1) }, '+')),
      h('div', { class: 'scale' }, scale.map((t) => h('span', {}, t))));
  }

  function shrinkCard() {
    const steps = Math.max(0, Math.ceil(s.duration_s / s.shrink_every_s) - 1);
    return h('div', { class: 'card' },
      switchRow({ title: 'Schrumpfende Zone', sub: s.shrink_enabled ? `Spielgebiet wird alle ${minutes(s.shrink_every_s)} um ${s.shrink_percent} % kleiner.` : 'Das Spielgebiet bleibt gleich groß.', value: s.shrink_enabled, iconName: 'shrink', onChange: (v) => set({ shrink_enabled: v }) }),
      s.shrink_enabled ? h('div', { class: 'stack' },
        fineSlider({ min: 1, max: 120, value: Math.round(s.shrink_every_s / 60), label: 'Zone schrumpft alle', scale: ['1', '30', '60', '90', '120 min'], fmt: (v) => minutes(v * 60), onChange: (v) => { s.shrink_every_s = v * 60; } }),
        fineSlider({ min: 1, max: 90, value: s.shrink_percent, label: 'Fläche pro Schritt kleiner um', scale: ['1', '25', '50', '75', '90 %'], fmt: (v) => `${v} %`, onChange: (v) => { s.shrink_percent = v; } }),
        h('p', { class: 'sub' }, `Bei ${minutes(s.duration_s)} Spieldauer schrumpft die Zone etwa ${steps}×. Die nächste Zone wird 2 Minuten vorher gestrichelt angezeigt. Eine Vorschau siehst du beim Spielgebiet.`)) : null);
  }

  function jokerCard() {
    const row = (ic, title, sub) => h('div', { class: 'row' }, h('div', { class: 'ico-b sm', html: icon(ic, 18) }), h('div', { class: 'grow' }, h('b', {}, title), h('p', { class: 'sub' }, sub)));
    return h('div', { class: 'card' },
      h('div', { class: 'cl' }, h('span', { class: 'lbl' }, 'Joker'), h('span', { class: 'pill' }, 'immer an')),
      h('p', { class: 'sub' }, 'Alle Joker gibt es von Anfang an. Jeder lässt sich pro Spieler einmal pro Runde einsetzen.'),
      h('span', { class: 'lbl' }, 'Gejagte'),
      row('skip', 'Ping überspringen', 'Der nächste Ping fällt aus.'),
      row('double', 'Ungenauer Ping', 'Der Ping zeigt nur einen Kreis statt deines genauen Punkts.'),
      row('ghost', 'Falscher Ort', 'Der Ping zeigt einen erfundenen Ort. Wird erst nach dem Spiel verraten.'),
      row('target', 'Sucher-Radar', 'Zeigt sofort, wo alle Sucher gerade genau sind.'),
      h('span', { class: 'lbl' }, 'Sucher'),
      row('megaphone', 'Sound-Joker', 'Spielt bei einem Gejagten einen Ton ab und zeigt allen Suchern seinen genauen Standort.'));
  }

  function advancedCard() {
    const d = h('details', { class: 'card more' },
      h('summary', {}, h('span', { class: 'lbl' }, 'Erweitert'), h('span', { class: 'chev', html: icon('chevdown', 18) })),
      h('div', { class: 'stack', style: { marginTop: '12px' } },
        h('div', { class: 'cl' }, h('span', { class: 'sub' }, 'GPS-Messungen verwerfen ab'), h('span', { class: 'val' }, `${s.accuracy_max_m} m`)),
        chipGroup({ options: [30, 50, 100].map((v) => ({ label: `${v} m`, value: v })), value: s.accuracy_max_m, onChange: (v) => set({ accuracy_max_m: v }) }),
        h('div', { class: 'cl' }, h('span', { class: 'sub' }, 'Toleranz an der Grenze'), h('span', { class: 'val' }, `${s.boundary_tolerance_m} m`)),
        chipGroup({ options: [10, 20, 40].map((v) => ({ label: `${v} m`, value: v })), value: s.boundary_tolerance_m, onChange: (v) => set({ boundary_tolerance_m: v }) }),
        switchRow({ title: 'Team auf der Karte', sub: 'Mitspieler im eigenen Team sehen sich gegenseitig live.', value: s.show_teammates, onChange: (v) => set({ show_teammates: v }) }),
        h('div', { class: 'cl' }, h('span', { class: 'sub' }, 'Daten löschen nach Spielende'), h('span', { class: 'val' }, `${s.retention_h} h`)),
        chipGroup({ options: [6, 24, 72].map((v) => ({ label: `${v} h`, value: v })), value: s.retention_h, onChange: (v) => set({ retention_h: v }) })));
    d.open = advOpen;
    d.addEventListener('toggle', () => { advOpen = d.open; });
    return d;
  }
  let advOpen = false;

  function render() {
    const tc = timeCard();
    durVal = tc.querySelector('.val.big');
    setChildren(body,
      intervalCard(), modeCard(), tc, rolesCard(), boundaryCard(), shrinkCard(), jokerCard(), advancedCard(),
      tiles([
        { lbl: 'Ping', v: minutes(s.ping_interval_s) },
        { lbl: 'Ping zeigt', v: 'Meter' },
        { lbl: 'Dauer', v: minutes(s.duration_s) },
      ], 'on-bg'),
      h('p', { class: 'hint' }, pingModeText(s)),
      save);
  }

  el.append(header({ onBack: back, title: 'Spielregeln', step: 'Schritt 1 von 3 · Host' }), body);
  render();
  return { el, update() {}, destroy() {} };
}
