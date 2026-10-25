// Steuerung der App: wählt Backend und Screen, verwaltet Standort, Theme und Overlays.
import { CONFIG, isConfigured } from './config.js';
import { h, toast } from './util/dom.js';
import { logoSvg } from './util/icons.js';
import { load, save } from './util/storage.js';
import { LocationService, WebGeolocationProvider, ManualProvider } from './location/index.js';
import { startScreen } from './ui/screens/start.js';
import { settingsScreen } from './ui/screens/settings.js';
import { areaScreen } from './ui/screens/area.js';
import { waitingScreen } from './ui/screens/waiting.js';
import { playScreen } from './ui/screens/play.js';
import { resultScreen } from './ui/screens/result.js';
import { openChat, hasUnread } from './ui/chat.js';
import { openHelp } from './ui/help.js';

const SCREENS = { start: startScreen, settings: settingsScreen, area: areaScreen, waiting: waitingScreen, play: playScreen, result: resultScreen };

export class App {
  constructor(root) {
    this.root = root;
    this.backend = null;
    this.unsub = null;
    this.screen = null;
    this.screenKey = null;
    this.hostSteps = {};
    this.loc = new LocationService();
    this.locRunning = false;
    this.chat = null;
    this.help = null;
    this.pendingJoinCode = null;
    this.configured = isConfigured();
    this.posSubs = new Set();
    this.ctx = this.makeCtx();
    this.loc.subscribe(() => {
      for (const fn of this.posSubs) fn(this.loc.last, this.loc.error);
    });
  }

  makeCtx() {
    const app = this;
    return {
      cfg: CONFIG,
      get configured() { return app.configured; },
      get backend() { return app.backend; },
      get pendingJoinCode() { return app.pendingJoinCode; },
      set pendingJoinCode(v) { app.pendingJoinCode = v; },
      snap: () => app.backend.snap,
      now: () => (app.backend?.now ? app.backend.now() : Date.now()),
      getName: () => load('name', ''),
      setName: (n) => save('name', String(n || '').trim().slice(0, 24)),
      getTheme: () => document.documentElement.dataset.theme || 'dark',
      setTheme: (t) => app.setTheme(t),
      switchBackend: (mode) => app.useBackend(mode),
      setHostStep: (step) => {
        const id = app.backend.snap.game?.id;
        if (id) app.hostSteps[id] = step;
        app.render();
        window.scrollTo(0, 0);
      },
      openChat: () => app.openChat(),
      openHelp: () => app.openHelp(),
      unread: () => hasUnread(app.backend.snap),
      pos: () => app.loc.last,
      locError: () => app.loc.error,
      onPos: (fn) => { app.posSubs.add(fn); return () => app.posSubs.delete(fn); },
      dismissResult: (gameId) => {
        const list = load('dismissed', []);
        save('dismissed', [gameId, ...list.filter((x) => x !== gameId)].slice(0, 30));
        app.backend.closeGame();
      },
      openGameById: (id) => app.backend.openGame(id).catch((e) => toast(e.message, 'bad')),
    };
  }

  setTheme(t) {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#eef2f7' : '#0d141d');
    save('theme', t);
    this.screenKey = null; // Screen neu aufbauen (Kartenfarben)
    this.render();
  }

  async start() {
    const theme = load('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
    const params = new URLSearchParams(location.search);
    const join = params.get('join');
    if (join) {
      this.pendingJoinCode = join;
      history.replaceState(null, '', location.pathname);
    }
    const mode = this.configured ? load('mode', 'supabase') : 'demo';
    await this.useBackend(mode);
  }

  showMessage(title, text, actions = []) {
    this.destroyScreen();
    this.root.replaceChildren(h('div', { class: 'scr', style: { minHeight: '100dvh', justifyContent: 'center' } },
      h('div', { class: 'brand' }, h('div', { class: 'logowrap', html: logoSvg(80) }), h('h2', {}, title)),
      text ? h('p', { class: 'sub', style: { textAlign: 'center' } }, text) : null,
      ...actions));
  }

  destroyScreen() {
    this.screen?.destroy?.();
    this.screen = null;
    this.screenKey = null;
  }

  async useBackend(mode) {
    if (mode === 'supabase' && !this.configured) mode = 'demo';
    this.chat?.close();
    this.help?.close();
    this.unsub?.();
    this.backend?.closeGame?.(false);
    this.backend?.dispose?.();
    this.stopLocation();
    this.showMessage('Lädt …', '');
    try {
      if (mode === 'demo') {
        const { DemoBackend } = await import('./backend/demo.js');
        this.backend = new DemoBackend(CONFIG, () => this.loc.last, (p) => this.loc.provider?.set?.(p));
      } else {
        const { SupabaseBackend } = await import('./backend/supabase.js');
        this.backend = new SupabaseBackend(CONFIG);
      }
      await this.backend.init();
    } catch (e) {
      console.error(e);
      this.showMessage('Verbindung fehlgeschlagen', e.message, [
        h('button', { class: 'btn pri', onclick: () => this.useBackend(mode) }, 'Nochmal versuchen'),
        mode !== 'demo' ? h('button', { class: 'btn sec', onclick: () => this.useBackend('demo') }, 'Demo-Modus ausprobieren') : null,
      ]);
      return;
    }
    save('mode', mode);
    this.loc.use(mode === 'demo' ? new ManualProvider(load('lastPos') || null) : new WebGeolocationProvider());
    this.unsub = this.backend.on((snap) => this.onSnap(snap));
    this.destroyScreen();
    try {
      const gid = await this.backend.findActiveGame(load('dismissed', []));
      if (gid) await this.backend.openGame(gid);
    } catch (e) {
      toast(e.message, 'bad');
    }
    this.render();
  }

  onSnap(snap) {
    if (snap.gone) {
      snap.gone = false;
      toast('Das Spiel gibt es nicht mehr, oder du bist nicht mehr dabei.');
    }
    this.syncLocation(snap);
    this.render();
  }

  syncLocation(snap) {
    const g = snap.game;
    const inGame = g && snap.me && ['lobby', 'running', 'paused'].includes(g.status);
    if (inGame) {
      if (!this.locRunning) {
        this.loc.start();
        this.locRunning = true;
      }
      const interval = this.backend.mode === 'demo' ? 2000 : CONFIG.WEB_LOCATION_INTERVAL_S * 1000;
      this.sendFix ||= (fix) => {
        // Echte Positionen bleiben nicht auf dem Gerät liegen (nur der Demo-Modus merkt sich seine simulierte).
        if (this.backend?.mode === 'demo') save('lastPos', { lat: fix.lat, lon: fix.lon });
        return this.backend?.sendLocation(fix);
      };
      if (this.loc.sender !== this.sendFix || this.loc.intervalMs !== interval) this.loc.setSender(this.sendFix, interval);
      this.loc.setWake(g.status === 'running' || g.status === 'paused');
    } else {
      this.stopLocation();
    }
  }

  stopLocation() {
    this.loc.setSender(null);
    this.loc.setWake(false);
    if (this.locRunning) {
      this.loc.stop();
      this.locRunning = false;
    }
  }

  route(snap) {
    const g = snap.game;
    if (!g || !snap.me) return 'start';
    if (g.status === 'lobby') {
      if (snap.me.is_host) return this.hostSteps[g.id] || (g.area ? 'waiting' : 'settings');
      return 'waiting';
    }
    if (g.status === 'running' || g.status === 'paused') return 'play';
    return 'result';
  }

  render() {
    if (!this.backend) return;
    const snap = this.backend.snap;
    const key = `${this.route(snap)}:${snap.game?.id || ''}`;
    if (key !== this.screenKey) {
      this.destroyScreen();
      const name = key.split(':')[0];
      try {
        this.screen = SCREENS[name](this.ctx);
      } catch (e) {
        console.error(e);
        this.screen = { el: h('div', { class: 'scr' }, h('p', { class: 'err-text' }, `Fehler: ${e.message}`)), update() {}, destroy() {} };
      }
      this.screenKey = key;
      this.root.replaceChildren(this.screen.el);
      try { this.screen.mounted?.(); } catch (e) { console.error(e); }
      // Area-Screen braucht den Standort schon vor dem Spiel
      if (name === 'area' && !this.locRunning) {
        this.loc.start();
        this.locRunning = true;
      }
    } else {
      try {
        this.screen.update(snap);
      } catch (e) {
        console.error(e);
      }
    }
  }

  openChat() {
    if (this.chat) return;
    this.chat = openChat(this.ctx, () => {
      this.chat = null;
      this.render();
    });
  }

  openHelp() {
    if (this.help) return;
    this.help = openHelp(this.ctx, () => { this.help = null; });
  }
}

