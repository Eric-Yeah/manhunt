// Demo-Backend: simuliert Server und Mitspieler komplett im Browser.
// Nutzt dieselbe Spiel-Logik (core/engine.js) wie die Edge Functions und bildet die
// Sichtbarkeitsregeln der Datenbank (RLS) nach. Die Zeit läuft 10× schneller.
import { BaseBackend, emptySnap } from './base.js';
import { normalizeSettings, assignRoles, processLocation, planTick, isPlanEmpty, zoneGeometryAt } from '../core/engine.js';
import { distanceM, destination, bearingDeg, randomPointInGeometry, pointInGeometry, centroidOf } from '../core/geo.js';
import { load, save } from '../util/storage.js';

const SPEED = 10;
const ME = 'demo-user';
const BOTS = [
  { name: 'Mia', role: 'hider', traccar: true },
  { name: 'Jonas', role: 'hider', traccar: true },
  { name: 'Lena', role: 'random', traccar: false },
  { name: 'Ben', role: 'hunter', traccar: true },
  { name: 'Tom', role: 'random', traccar: false },
];
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class DemoBackend extends BaseBackend {
  constructor(cfg, getPos, setPos) {
    super();
    this.mode = 'demo';
    this.cfg = cfg;
    this.getPos = getPos;
    this.setPos = setPos;
    this.t0 = Date.now();
    this.w = null;
    this.timer = null;
    this.idc = 1;
    this.userId = ME;
  }

  now() {
    return this.t0 + (Date.now() - this.t0) * SPEED;
  }

  async init() {
    return ME;
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async findActiveGame(dismissed = []) {
    if (this.w && !dismissed.includes(this.w.game.id)) return this.w.game.id;
    return null;
  }

  async openGame(id) {
    if (this.w?.game.id !== id) return;
    this.gameId = id;
    this.publish();
  }

  closeGame(emit = true) {
    this.dispose();
    this.w = null;
    this.gameId = null;
    this.snap = emptySnap();
    if (emit) this.emit();
  }

  // ---------- Sichtbarkeit wie in der Datenbank (RLS) ----------
  publish() {
    if (!this.w) {
      this.snap = emptySnap();
      return this.emit();
    }
    const w = this.w;
    const me = w.players.find((p) => p.user_id === ME);
    const ended = w.game.status === 'ended';
    const role = me?.role;
    const pings = w.pings.filter((p) => ended
      || (role === 'hunter' && (!p.recipient_id || p.recipient_id === me.id))
      || (role === 'hider' && p.hider_id === me.id && !p.recipient_id));
    const messages = w.messages.filter((m) => ended || m.channel === 'all'
      || (m.channel === 'hunters' && role === 'hunter') || (m.channel === 'hiders' && role === 'hider'));
    const teammates = {};
    if (['running', 'paused'].includes(w.game.status) && normalizeSettings(w.game.settings).show_teammates && me?.status === 'active') {
      for (const p of w.players) {
        const pv = w.privs[p.id];
        if (p.id !== me.id && p.role === role && pv?.kf_lat != null) teammates[p.id] = { lat: pv.kf_lat, lon: pv.kf_lon, at: ms(pv.kf_at), accuracy: 8 };
      }
    }
    this.snap = {
      game: { ...w.game },
      players: w.players.map((p) => ({ ...p })),
      priv: me ? { ...w.privs[me.id] } : null,
      pings: pings.map((p) => ({ ...p })),
      secrets: w.secrets.filter((s) => ended || s.hider_id === me?.id),
      messages: messages.map((m) => ({ ...m })),
      teammates,
    };
    this.emit();
  }

  // ---------- Hilfen ----------
  msg(body, kind = 'system', channel = 'all', player = null) {
    this.w.messages.push({ id: this.idc++, game_id: this.w.game.id, player_id: player?.id || null, sender_name: player?.name || null, channel, kind, body, created_at: iso(this.now()) });
  }

  addPlayer(name, role, isHost, userId = uid()) {
    const p = {
      id: uid(), game_id: this.w.game.id, user_id: userId, name, role, is_host: isHost, ready: isHost, status: 'active',
      found_at: null, last_signal_at: null, last_traccar_at: null, last_web_at: null, joined_at: iso(this.now() + this.w.players.length),
    };
    this.w.players.push(p);
    this.w.privs[p.id] = { player_id: p.id, game_id: this.w.game.id, user_id: userId, kf_lat: null, kf_lon: null, kf_var: null, kf_at: null, kf_rejects: 0, inside: null, edge_dist_m: null, violation: null, violation_name: null, oob_since: null, oob_deadline: null, joker_pending: null, joker_used: {} };
    return p;
  }

  me() {
    return this.w?.players.find((p) => p.user_id === ME);
  }

  newWorld({ settings, area = null, exclusions = [], zone_stages = [] } = {}) {
    const code = Array.from({ length: 6 }, () => pick('ABCDEFGHJKMNPQRSTUVWXYZ23456789')).join('');
    this.w = {
      game: {
        id: uid(), code, host_id: ME, status: 'lobby', settings: normalizeSettings(settings || {}), area, exclusions, zone_stages,
        zone_index: 0, created_at: iso(this.now()), started_at: null, hunt_starts_at: null, ends_at: null, next_ping_at: null,
        ping_seq: 0, hunt_announced: false, paused_at: null, paused_by: null, pause_reason: null, ended_at: null, winner: null,
        end_reason: null, purge_at: null, rematch_of: null, rematch_id: null,
      },
      players: [], privs: {}, pings: [], secrets: [], messages: [], locations: [], bots: {}, lastRec: {}, warned: {},
    };
    this.gameId = this.w.game.id;
  }

  ensureLoop() {
    if (!this.timer) this.timer = setInterval(() => this.loop(), 500);
  }

  // ---------- Aktionen (gleiche Regeln wie die SQL-Funktionen) ----------
  async createGame(name) {
    this.newWorld({});
    this.addPlayer(name, 'random', true, ME);
    if (!this.getPos()) this.setPos?.(this.cfg.DEFAULT_CENTER);
    BOTS.forEach((b, i) => setTimeout(() => {
      if (!this.w || this.w.game.status !== 'lobby') return;
      const p = this.addPlayer(b.name, b.role, false);
      p.last_signal_at = iso(this.now());
      if (b.traccar) p.last_traccar_at = iso(this.now()); else p.last_web_at = iso(this.now());
      setTimeout(() => { if (this.w) { p.ready = true; this.publish(); } }, 1500 + Math.random() * 3000);
      this.publish();
    }, 700 + i * 650));
    this.ensureLoop();
    this.publish();
    return { game_id: this.w.game.id };
  }

  async joinGame() {
    throw new Error('Im Demo-Modus kannst du nur selbst ein Spiel erstellen.');
  }

  async rename() {}

  requireHost(statuses) {
    if (!this.w || !this.me()?.is_host) throw new Error('Nur der Host kann das.');
    if (statuses && !statuses.includes(this.w.game.status)) throw new Error('Das geht in diesem Spielzustand nicht.');
  }

  async updateGame(patch) {
    this.requireHost(['lobby']);
    const g = this.w.game;
    if (patch.settings) g.settings = normalizeSettings(patch.settings);
    if (patch.area) {
      g.area = patch.area;
      if (!patch.zone_stages) g.zone_stages = [{ at_s: 0, geometry: patch.area.geometry }];
    }
    if (patch.exclusions) g.exclusions = patch.exclusions;
    if (patch.zone_stages) g.zone_stages = patch.zone_stages;
    if (g.settings.role_mode === 'random') this.w.players.forEach((p) => { p.role = 'random'; });
    this.publish();
  }

  async setRole(role) {
    if (this.w.game.status !== 'lobby') throw new Error('Rollen lassen sich nur im Warteraum ändern.');
    if (this.w.game.settings.role_mode === 'random' && role !== 'random') throw new Error('Der Host lässt die Rollen zufällig verteilen.');
    this.me().role = role;
    this.publish();
  }

  async setPlayerRole(id, role) {
    this.requireHost(['lobby']);
    const p = this.w.players.find((x) => x.id === id);
    if (p) p.role = role;
    this.publish();
  }

  async setReady(ready) {
    this.me().ready = !!ready;
    this.publish();
  }

  async kick(id) {
    this.requireHost(['lobby']);
    this.w.players = this.w.players.filter((p) => p.id !== id);
    this.publish();
  }

  async startGame() {
    this.requireHost(['lobby']);
    const w = this.w, g = w.game, s = normalizeSettings(g.settings);
    if (!g.area) throw new Error('Lege zuerst das Spielgebiet fest.');
    const r = assignRoles(w.players.map((p) => ({ id: p.id, role: p.role })), s.role_mode);
    if (r.error) throw new Error(r.error);
    for (const p of w.players) {
      p.role = r.roles[p.id];
      p.status = 'active';
      p.found_at = null;
      Object.assign(w.privs[p.id], { kf_lat: null, kf_lon: null, kf_at: null, oob_since: null, oob_deadline: null, violation: null, joker_pending: null, joker_used: {} });
    }
    const now = this.now();
    Object.assign(g, {
      status: 'running', started_at: iso(now), hunt_starts_at: iso(now + s.headstart_s * 1000),
      ends_at: iso(now + (s.headstart_s + s.duration_s) * 1000), next_ping_at: iso(now + s.headstart_s * 1000),
      ping_seq: 0, zone_index: 0, hunt_announced: s.headstart_s === 0,
    });
    // Startpunkt: alle am Mittelpunkt, die eigene Figur ebenfalls
    const c = this.safeSpot(centroidOf(g.area.geometry));
    const mePos = this.getPos();
    if (!mePos || this.safeSpot(mePos) !== mePos) this.setPos?.(this.safeSpot(destination(c, 20, Math.random() * 360)));
    w.bots = {};
    for (const p of w.players.filter((x) => x.user_id !== ME)) {
      let start = this.safeSpot(destination(c, 10 + Math.random() * 30, Math.random() * 360));
      const spot = p.role === 'hider' ? this.safeSpot(randomPointInGeometry(g.area.geometry, Math.random, c, 200, 700)) : null;
      // Ohne (oder mit kurzem) Vorsprung sind die Gejagten schon versteckt
      if (spot && s.headstart_s < 180) start = spot;
      w.bots[p.id] = { pos: start, target: spot, wait: 0 };
      this.setBotPriv(p, start, now);
    }
    this.msg(s.headstart_s ? `Das Spiel läuft! Die Gejagten haben ${Math.round(s.headstart_s / 60)} min Vorsprung.` : 'Das Spiel läuft! Kein Vorsprung, die Jagd beginnt sofort.');
    const hb = w.players.find((p) => p.role === 'hider' && p.user_id !== ME);
    const kb = w.players.find((p) => p.role === 'hunter' && p.user_id !== ME);
    setTimeout(() => { if (hb && this.w) { this.msg(pick(['Ich geh Richtung Wasser.', 'Ich versteck mich im Norden.', 'Viel Glück euch!']), 'chat', 'hiders', hb); this.publish(); } }, 2500);
    setTimeout(() => { if (kb && this.w) { this.msg(pick(['Ich nehme die Ostseite.', 'Wir treffen uns am Mittelpunkt.', 'Ich warte auf den ersten Ping.']), 'chat', 'hunters', kb); this.publish(); } }, 4000);
    this.publish();
  }

  async markFound() {
    const me = this.me();
    if (!['running', 'paused'].includes(this.w.game.status)) throw new Error('Das Spiel läuft gerade nicht.');
    if (me.role !== 'hider' || me.status !== 'active') throw new Error('Nur aktive Gejagte können das.');
    this.found(me);
    this.publish();
  }

  found(p) {
    p.status = 'found';
    p.found_at = iso(this.now());
    Object.assign(this.w.privs[p.id], { oob_since: null, oob_deadline: null, joker_pending: null });
    this.msg(`${p.name} wurde gefunden!`);
    this.finishIfDone();
  }

  finishIfDone() {
    const g = this.w.game;
    if (['running', 'paused'].includes(g.status) && !this.w.players.some((p) => p.role === 'hider' && p.status === 'active')) {
      this.finish('hunters', 'all_found');
    }
  }

  finish(winner, reason) {
    const g = this.w.game;
    if (g.status === 'ended') return;
    Object.assign(g, { status: 'ended', ended_at: iso(this.now()), winner, end_reason: reason, paused_at: null, purge_at: iso(Date.now() + 24 * 3600_000) });
    this.msg(reason === 'time' ? 'Die Zeit ist abgelaufen. Die Gejagten gewinnen!' : reason === 'all_found' ? 'Alle Gejagten sind gefunden oder raus. Die Sucher gewinnen!' : 'Der Host hat das Spiel beendet.');
  }

  async pause(reason) {
    const g = this.w.game;
    if (g.status !== 'running') throw new Error('Das Spiel läuft gerade nicht.');
    const me = this.me();
    Object.assign(g, { status: 'paused', paused_at: iso(this.now()), paused_by: me.id, pause_reason: reason });
    this.msg(reason.toUpperCase() === 'SOS' ? `SOS von ${me.name}! Das Spiel ist für alle angehalten.` : `${me.name} hat das Spiel pausiert: ${reason}`, 'sos');
    this.publish();
  }

  async resume() {
    const g = this.w.game;
    if (g.status !== 'paused') throw new Error('Das Spiel ist nicht pausiert.');
    const d = this.now() - ms(g.paused_at);
    for (const k of ['hunt_starts_at', 'ends_at', 'next_ping_at']) g[k] = iso(ms(g[k]) + d);
    Object.assign(g, { status: 'running', paused_at: null, paused_by: null, pause_reason: null });
    for (const pv of Object.values(this.w.privs)) Object.assign(pv, { oob_since: null, oob_deadline: null });
    this.msg(`${this.me().name} hat das Spiel fortgesetzt. Weiter geht's!`);
    this.publish();
  }

  async endGame() {
    this.requireHost(['lobby', 'running', 'paused']);
    if (this.w.game.status === 'lobby') return this.closeGame();
    this.finish(null, 'aborted');
    this.publish();
  }

  async leaveGame() {
    this.closeGame();
  }

  async sendMessage(channel, body, announce = false) {
    const me = this.me(), g = this.w.game;
    const b = String(body || '').trim();
    if (!b) throw new Error('Leere Nachricht.');
    if (channel !== 'all' && (g.status === 'ended' || channel !== `${me.role}s`)) throw new Error('Kein Zugriff auf diesen Kanal.');
    this.w.messages.push({ id: this.idc++, game_id: g.id, player_id: me.id, sender_name: me.name, channel, kind: me.is_host && channel === 'all' && announce ? 'host' : 'chat', body: b.slice(0, 500), created_at: iso(this.now()) });
    // Ein Teammitglied antwortet manchmal
    const mates = this.w.players.filter((p) => p.user_id !== ME && (channel === 'all' || p.role === me.role) && p.status === 'active');
    if (mates.length && Math.random() < 0.7) {
      const m = pick(mates);
      setTimeout(() => {
        if (!this.w) return;
        this.msg(pick(['Alles klar!', 'Okay 👍', 'Bin unterwegs.', 'Hab ich gesehen.', 'Gute Idee.']), 'chat', channel, m);
        this.publish();
      }, 1500 + Math.random() * 2500);
    }
    this.publish();
  }

  async useJoker(type) {
    const me = this.me(), g = this.w.game, s = normalizeSettings(g.settings), pv = this.w.privs[me.id];
    if (g.status !== 'running') throw new Error('Joker gibt es nur im laufenden Spiel.');
    if (me.role !== 'hider' || me.status !== 'active') throw new Error('Nur aktive Gejagte haben Joker.');
    if (!s[`joker_${type}`]) throw new Error('Dieser Joker ist ausgeschaltet.');
    if (pv.joker_pending) throw new Error('Für den nächsten Ping ist schon ein Joker aktiv.');
    const used = Object.values(pv.joker_used).map(ms);
    const readyAt = used.length ? Math.max(...used) + s.joker_cooldown_s * 1000 : 0;
    if (readyAt > this.now()) throw new Error(`Joker wieder verfügbar in ${Math.ceil((readyAt - this.now()) / 60000)} min.`);
    pv.joker_pending = type;
    pv.joker_used = { ...pv.joker_used, [type]: iso(this.now()) };
    this.publish();
    return { pending: type };
  }

  async cancelJoker() {
    this.w.privs[this.me().id].joker_pending = null;
    this.publish();
  }

  async rematch() {
    this.requireHost(['ended']);
    const old = this.w;
    const swap = { hunter: 'hider', hider: 'hunter' };
    this.newWorld({ settings: old.game.settings, area: old.game.area, exclusions: old.game.exclusions, zone_stages: old.game.zone_stages });
    for (const p of old.players.filter((x) => x.status !== 'left')) {
      const n = this.addPlayer(p.name, swap[p.role] || 'random', p.is_host, p.user_id);
      n.ready = p.user_id !== ME;
      n.last_signal_at = p.last_signal_at;
      n.last_traccar_at = p.last_traccar_at;
      n.last_web_at = p.last_web_at;
    }
    this.ensureLoop();
    this.publish();
    return { game_id: this.w.game.id };
  }

  async getReplay() {
    const g = this.w.game;
    const tracks = {};
    for (const l of this.w.locations) (tracks[l.player_id] ||= []).push([l.lon, l.lat, l.at]);
    return {
      started_at: g.started_at, hunt_starts_at: g.hunt_starts_at, ended_at: g.ended_at,
      tracks: Object.entries(tracks).map(([player_id, points]) => ({ player_id, points })),
      decoys: this.w.secrets.filter((s) => s.is_decoy).map((s) => s.ping_id),
    };
  }

  async getTracker() {
    return { token: 'demo', url: '', last_request_at: null };
  }

  async regenerateTracker() {
    return 'demo';
  }

  async listSavedAreas() {
    return load('demoAreas', []);
  }

  async saveArea(name, area, exclusions) {
    const list = load('demoAreas', []);
    list.unshift({ id: uid(), name, area, exclusions, created_at: new Date().toISOString() });
    save('demoAreas', list.slice(0, 20));
  }

  async deleteSavedArea(id) {
    save('demoAreas', load('demoAreas', []).filter((a) => a.id !== id));
  }

  moveMe(p) {
    this.setPos?.(p);
  }

  async pokeTick() {}

  /** Eigener Standort (wie Edge Function "location" für die Web-App). */
  async sendLocation(fix) {
    if (!this.w) return null;
    const me = this.me();
    if (!me) return null;
    const now = this.now();
    me.last_signal_at = me.last_web_at = iso(now);
    const g = this.w.game;
    if (g.status !== 'running') {
      this.publish();
      return { ok: true, stored: false };
    }
    const pv = this.w.privs[me.id];
    const res = processLocation(
      { game: this.engineGame(), player: me, priv: { ...pv, kf_lat: null, oob_since: ms(pv.oob_since), oob_deadline: ms(pv.oob_deadline) } },
      { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, at: now },
      now,
    );
    if (res.accepted) {
      Object.assign(pv, {
        kf_lat: res.kf.lat, kf_lon: res.kf.lon, kf_var: res.kf.var, kf_at: iso(now),
        inside: res.boundary.inside, edge_dist_m: res.boundary.edge_dist_m, violation: res.boundary.violation,
        violation_name: res.boundary.exclusion,
        oob_since: me.status === 'active' ? iso(res.oob.since) : null,
        oob_deadline: me.status === 'active' && me.role === 'hider' ? iso(res.oob.deadline) : null,
      });
      this.record(me.id, res.kf, now);
    }
    this.publish();
    return { ok: true, accepted: res.accepted, boundary: res.boundary };
  }

  // ---------- Simulation ----------
  engineGame() {
    const g = this.w.game;
    return {
      ...g, started_at: ms(g.started_at), hunt_starts_at: ms(g.hunt_starts_at), ends_at: ms(g.ends_at), next_ping_at: ms(g.next_ping_at),
    };
  }

  setBotPriv(p, pos, now) {
    Object.assign(this.w.privs[p.id], { kf_lat: pos.lat, kf_lon: pos.lon, kf_var: 30, kf_at: iso(now) });
  }

  record(playerId, pos, now) {
    const last = this.w.lastRec[playerId] || 0;
    if (now - last < 10_000) return;
    this.w.lastRec[playerId] = now;
    this.w.locations.push({ player_id: playerId, lat: pos.lat, lon: pos.lon, at: now });
  }

  loop() {
    if (!this.w) return;
    const g = this.w.game;
    const now = this.now();
    if (g.status !== 'running') {
      this.lastLoop = now;
      if (g.status === 'lobby' && now - (this.lastSig || 0) > 15_000) {
        this.lastSig = now;
        for (const p of this.w.players.filter((x) => x.user_id !== ME)) {
          p.last_signal_at = iso(now);
          if (p.last_traccar_at) p.last_traccar_at = iso(now); else p.last_web_at = iso(now);
        }
        this.publish();
      }
      return;
    }
    const dt = Math.min(20, (now - (this.lastLoop || now)) / 1000);
    this.lastLoop = now;
    this.moveBots(dt, now);
    const ctx = {
      game: this.engineGame(),
      players: this.w.players.map((p) => ({ id: p.id, name: p.name, role: p.role, status: p.status })),
      privs: Object.fromEntries(Object.entries(this.w.privs).map(([id, pv]) => [id, { ...pv, kf_at: ms(pv.kf_at), oob_since: ms(pv.oob_since), oob_deadline: ms(pv.oob_deadline) }])),
    };
    const plan = planTick(ctx, now, Math.random);
    if (!isPlanEmpty(plan)) this.applyPlan(plan, now);
    this.publish();
  }

  applyPlan(plan, now) {
    const w = this.w, g = w.game;
    if (plan.end) return this.finish(plan.end.winner, plan.end.reason);
    if (plan.announce_hunt && !g.hunt_announced) {
      g.hunt_announced = true;
      this.msg('Der Vorsprung ist vorbei. Die Jagd beginnt!');
    }
    if (plan.zone_index != null && plan.zone_index > g.zone_index) {
      g.zone_index = plan.zone_index;
      this.msg(`Die Zone ist geschrumpft (Stufe ${plan.zone_index} von ${g.zone_stages.length - 1}).`);
    }
    const insert = (r) => {
      const id = this.idc++;
      const { decoy, ...row } = r;
      w.pings.push({ ...row, id, game_id: g.id, created_at: iso(now), recipient_id: row.recipient_id || null });
      if (decoy) w.secrets.push({ ping_id: id, game_id: g.id, hider_id: r.hider_id, is_decoy: true });
    };
    const regular = plan.new_seq != null && g.ping_seq === plan.expected_seq;
    if (regular) {
      g.ping_seq = plan.new_seq;
      g.next_ping_at = iso(plan.next_ping_at);
    }
    for (const pen of plan.penalties) {
      const p = w.players.find((x) => x.id === pen.player_id);
      const pv = w.privs[pen.player_id];
      if (!p || p.status !== 'active' || !pv.oob_deadline || ms(pv.oob_deadline) > now) continue;
      if (pen.type === 'eliminate') {
        p.status = 'eliminated';
        Object.assign(pv, { oob_since: null, oob_deadline: null });
        this.msg(`${p.name} war zu lange außerhalb des Spielgebiets und ist ausgeschieden.`);
      } else {
        pv.oob_deadline = iso(pen.oob_deadline);
        plan.pings.filter((r) => r.kind === 'penalty' && r.hider_id === p.id).forEach(insert);
        this.msg(`${p.name} war zu lange außerhalb. Extra-Ping für die Sucher!`);
      }
    }
    if (regular) {
      plan.pings.filter((r) => r.kind !== 'penalty').forEach(insert);
      for (const id of plan.consumed_jokers) w.privs[id].joker_pending = null;
      // Gejagte Bots ziehen nach einem Ping manchmal um
      for (const p of w.players.filter((x) => x.role === 'hider' && x.status === 'active' && w.bots[x.id])) {
        if (Math.random() < 0.5) w.bots[p.id].target = this.safeSpot(destination(w.bots[p.id].pos, 150 + Math.random() * 200, Math.random() * 360));
      }
      const kb = w.players.find((p) => p.role === 'hunter' && p.user_id !== ME && p.status === 'active');
      if (kb && Math.random() < 0.35) this.msg(pick(['Neuer Ping! Ich geh hin.', 'Der Kreis ist nah bei mir.', 'Lasst uns aufteilen.']), 'chat', 'hunters', kb);
    }
    this.finishIfDone();
  }

  safeSpot(p) {
    const zone = zoneGeometryAt(this.engineGame(), this.now());
    if (zone && pointInGeometry(p, zone)) {
      const ex = (this.w.game.exclusions || []).some((e) => pointInGeometry(p, e.geometry));
      if (!ex) return p;
    }
    return zone ? randomPointInGeometry(zone, Math.random, centroidOf(zone), 0, 400) : p;
  }

  moveBots(dt, now) {
    const w = this.w, g = w.game;
    const huntOn = now >= ms(g.hunt_starts_at);
    const zone = zoneGeometryAt(this.engineGame(), now);
    const mePos = this.getPos();
    const meP = this.me();
    for (const p of w.players) {
      const b = w.bots[p.id];
      if (!b || p.status !== 'active') continue;
      if (p.role === 'hider') {
        if (zone && !pointInGeometry(b.pos, zone)) b.target = this.safeSpot(b.pos);
        if (b.target) this.step(b, b.target, 1.6, dt);
      } else if (huntOn) {
        // Sucher: zum neuesten Ping laufen, dort etwas suchen
        const latest = [...w.pings].reverse().find((x) => x.mode !== 'none' && (!x.recipient_id || x.recipient_id === p.id) && w.players.find((h) => h.id === x.hider_id)?.status === 'active');
        if (latest && latest.id !== b.pingId) {
          b.pingId = latest.id;
          b.target = latest.mode === 'direction'
            ? destination({ lat: latest.ref_lat, lon: latest.ref_lon }, latest.distance_m, latest.bearing_deg)
            : { lat: latest.lat, lon: latest.lon };
        }
        if (b.target && distanceM(b.pos, b.target) < 15) b.target = this.safeSpot(destination(b.target, 40 + Math.random() * 80, Math.random() * 360));
        if (b.target) this.step(b, b.target, 2.3, dt);
        // Bot-Gejagte in der Nähe werden gefunden
        for (const hp of w.players.filter((x) => x.role === 'hider' && x.status === 'active' && w.bots[x.id])) {
          if (distanceM(b.pos, w.bots[hp.id].pos) < 18 && now - ms(g.hunt_starts_at) > 60_000 && Math.random() < 0.1) {
            this.msg(`${p.name}: Hab ${hp.name}!`, 'chat', 'all', p);
            this.found(hp);
          }
        }
        // Echte Person als Gejagter: Hinweis, wenn ein Sucher sehr nah ist
        if (meP?.role === 'hider' && meP.status === 'active' && mePos && distanceM(b.pos, mePos) < 25 && (now - (w.warned[p.id] || 0)) > 120_000) {
          w.warned[p.id] = now;
          this.msg(`${p.name} steht direkt vor dir! Wenn du erwischt wurdest, halte „Ich wurde gefunden“ gedrückt.`);
        }
      }
      this.setBotPriv(p, b.pos, now);
      this.record(p.id, b.pos, now);
    }
    // Echte Person als Sucher: Bot-Gejagte in der Nähe geben auf
    if (meP?.role === 'hunter' && mePos && huntOn) {
      for (const hp of w.players.filter((x) => x.role === 'hider' && x.status === 'active' && w.bots[x.id])) {
        if (distanceM(mePos, w.bots[hp.id].pos) < 30) {
          this.msg(pick(['Okay, du hast mich! 😅', 'Mist, gefunden.', 'Gut gesucht!']), 'chat', 'all', hp);
          this.found(hp);
        }
      }
    }
  }

  step(b, target, speed, dt) {
    const d = distanceM(b.pos, target);
    if (d < 1) return;
    const move = Math.min(d, speed * dt * (0.7 + Math.random() * 0.6));
    b.pos = destination(b.pos, move, bearingDeg(b.pos, target) + (Math.random() - 0.5) * 20);
  }
}
