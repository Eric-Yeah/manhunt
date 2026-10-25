// Backend für das echte Spiel: Supabase (Auth, Postgres mit RLS, Realtime, Edge Functions).
import { createClient } from '../../vendor/supabase.esm.js';
import { BaseBackend, emptySnap } from './base.js';
import { ts } from '../util/format.js';

function friendly(error) {
  const msg = error?.message || String(error);
  if (/permission denied|42501/i.test(msg)) return 'Keine Berechtigung für diese Aktion.';
  if (/JWT|token is expired|invalid claim/i.test(msg)) return 'Sitzung abgelaufen. Bitte die App neu laden.';
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'Keine Verbindung zum Server. Prüfe dein Internet.';
  return msg;
}

export class SupabaseBackend extends BaseBackend {
  constructor(cfg) {
    super();
    this.mode = 'supabase';
    this.cfg = cfg;
    this.sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'manhunt-auth', detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    this.channel = null;
    this.tracker = null;
    this.lastPoke = 0;
    this.reloadTimer = null;
    this.locationUrl = `${cfg.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/location`;
    this.tickUrl = `${cfg.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/tick`;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.gameId) this.reload().catch(() => {});
    });
  }

  async init() {
    const { data } = await this.sb.auth.getSession();
    let session = data.session;
    if (!session) {
      const { data: d, error } = await this.sb.auth.signInAnonymously();
      if (error) {
        if (/anonymous/i.test(error.message)) throw new Error('Anonyme Anmeldung ist in Supabase noch nicht eingeschaltet (README, Schritt 2: Authentication → Sign In / Providers → "Allow anonymous sign-ins").');
        throw new Error(`Anmeldung fehlgeschlagen: ${friendly(error)}`);
      }
      session = d.session;
    }
    this.userId = session.user.id;
    return this.userId;
  }

  async call(fn, args = {}) {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) throw new Error(friendly(error));
    this.scheduleReload();
    return data;
  }

  /** Nach Änderungen sicherheitshalber neu laden, falls ein Realtime-Ereignis verloren ging. */
  scheduleReload(ms = 1500) {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.reload().catch(() => {}), ms);
  }

  async findActiveGame(dismissed = []) {
    const { data, error } = await this.sb
      .from('players')
      .select('game_id, status, joined_at, games(status)')
      .eq('user_id', this.userId)
      .neq('status', 'left')
      .order('joined_at', { ascending: false })
      .limit(10);
    if (error) throw new Error(friendly(error));
    const active = data.find((r) => r.games && ['lobby', 'running', 'paused'].includes(r.games.status));
    if (active) return active.game_id;
    const ended = data.find((r) => r.games?.status === 'ended' && !dismissed.includes(r.game_id));
    return ended?.game_id ?? null;
  }

  async openGame(gameId) {
    if (this.gameId === gameId && this.channel) return this.reload();
    this.closeGame(false);
    this.gameId = gameId;
    await this.reload();
    if (this.gameId) this.subscribe();
  }

  closeGame(emit = true) {
    if (this.channel) this.sb.removeChannel(this.channel);
    this.channel = null;
    this.setPolling(false);
    this.gameId = null;
    this.snap = emptySnap();
    if (emit) this.emit();
  }

  async reload() {
    const id = this.gameId;
    if (!id) return;
    const gen = (this.reloadGen = (this.reloadGen || 0) + 1);
    const q = (t) => this.sb.from(t);
    const [g, pl, pv, pi, se, ms, lo] = await Promise.all([
      q('games').select('*').eq('id', id).maybeSingle(),
      q('players').select('*').eq('game_id', id).order('joined_at'),
      q('player_private').select('*').eq('game_id', id),
      q('pings').select('*').eq('game_id', id).order('id', { ascending: false }).limit(600),
      q('ping_secrets').select('*').eq('game_id', id),
      q('messages').select('*').eq('game_id', id).order('id', { ascending: false }).limit(300),
      q('locations').select('player_id, lat, lon, s_lat, s_lon, accuracy, recorded_at').eq('game_id', id).order('id', { ascending: false }).limit(300),
    ]);
    if (this.gameId !== id || gen !== this.reloadGen) return; // veraltete Antwort verwerfen
    for (const r of [g, pl, pv, pi, se, ms, lo]) if (r.error) throw new Error(friendly(r.error));
    if (!g.data || !pl.data.some((p) => p.user_id === this.userId && p.status !== 'left')) {
      // Spiel gelöscht oder man wurde entfernt
      this.closeGame(false);
      this.snap.gone = true;
      this.emit();
      return;
    }
    this.snap = {
      game: g.data,
      players: pl.data,
      priv: pv.data.find((r) => r.user_id === this.userId) || null,
      pings: pi.data.reverse(),
      secrets: se.data,
      messages: ms.data.reverse(),
      teammates: BaseBackend.latestPerPlayer(lo.data),
      offline: this.snap.offline,
    };
    this.emit();
  }

  subscribe() {
    const id = this.gameId;
    const ch = this.sb.channel(`game-${id}-${Math.random().toString(36).slice(2, 8)}`);
    const on = (table, filter, fn) => ch.on('postgres_changes', { event: '*', schema: 'public', table, filter }, (p) => {
      if (this.gameId === id) fn(p);
    });
    on('games', `id=eq.${id}`, (p) => {
      if (p.eventType === 'DELETE') return this.reload().catch(() => {});
      this.snap.game = { ...this.snap.game, ...p.new };
      this.emit();
    });
    on('players', `game_id=eq.${id}`, (p) => {
      BaseBackend.applyChange(this.snap.players, p.eventType, p.new, p.old, 'joined_at');
      if (p.eventType === 'DELETE' && p.old?.id && !this.snap.players.some((x) => x.user_id === this.userId)) return this.reload().catch(() => {});
      this.emit();
    });
    on('player_private', `game_id=eq.${id}`, (p) => {
      if (p.new?.user_id === this.userId) {
        this.snap.priv = p.new;
        this.emit();
      }
    });
    on('pings', `game_id=eq.${id}`, (p) => {
      BaseBackend.applyChange(this.snap.pings, p.eventType, p.new, p.old, 'id');
      this.emit();
    });
    on('messages', `game_id=eq.${id}`, (p) => {
      BaseBackend.applyChange(this.snap.messages, p.eventType, p.new, p.old, 'id');
      this.emit();
    });
    on('locations', `game_id=eq.${id}`, (p) => {
      if (p.eventType !== 'INSERT') return;
      const r = p.new;
      const at = ts(r.recorded_at);
      const cur = this.snap.teammates[r.player_id];
      if (!cur || cur.at <= at) this.snap.teammates[r.player_id] = { lat: r.s_lat ?? r.lat, lon: r.s_lon ?? r.lon, at, accuracy: r.accuracy };
      this.emit();
    });
    let first = true;
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.snap.offline = false;
        this.setPolling(false);
        if (!first) this.reload().catch(() => {});
        first = false;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // Realtime gestört (z. B. schlechtes Netz): bis zur Wiederverbindung alle 4 s neu laden
        if (this.channel !== ch) return;
        this.snap.offline = true;
        this.setPolling(true);
        this.emit();
      }
    });
    this.channel = ch;
  }

  setPolling(on) {
    clearInterval(this.pollTimer);
    this.pollTimer = on ? setInterval(() => {
      if (document.visibilityState === 'visible') this.reload().catch(() => {});
    }, 4000) : null;
  }

  // ---------- Aktionen ----------
  async createGame(name) {
    const r = await this.call('create_game', { p_name: name });
    await this.openGame(r.game_id);
    return r;
  }
  async joinGame(code, name) {
    const r = await this.call('join_game', { p_code: code, p_name: name });
    await this.openGame(r.game_id);
    return r;
  }
  rename(name) { return this.call('rename_me', { p_game: this.gameId, p_name: name }); }
  updateGame(patch) { return this.call('update_game', { p_game: this.gameId, p_patch: patch }); }
  setRole(role) { return this.call('set_role', { p_game: this.gameId, p_role: role }); }
  setPlayerRole(playerId, role) { return this.call('set_player_role', { p_player: playerId, p_role: role }); }
  setReady(ready) { return this.call('set_ready', { p_game: this.gameId, p_ready: ready }); }
  kick(playerId) { return this.call('kick_player', { p_player: playerId }); }
  startGame() { return this.call('start_game', { p_game: this.gameId }); }
  markFound() { return this.call('mark_found', { p_game: this.gameId }); }
  pause(reason) { return this.call('pause_game', { p_game: this.gameId, p_reason: reason }); }
  resume() { return this.call('resume_game', { p_game: this.gameId }); }
  endGame() { return this.call('end_game', { p_game: this.gameId }); }
  async leaveGame() {
    await this.call('leave_game', { p_game: this.gameId });
    this.closeGame();
  }
  sendMessage(channel, body, announce = false) {
    return this.call('send_message', { p_game: this.gameId, p_channel: channel, p_body: body, p_announce: announce });
  }
  useJoker(type) { return this.call('use_joker', { p_game: this.gameId, p_type: type }); }
  cancelJoker() { return this.call('cancel_joker', { p_game: this.gameId }); }
  async rematch() {
    const r = await this.call('rematch', { p_game: this.gameId });
    await this.openGame(r.game_id);
    return r;
  }
  getReplay() { return this.call('get_replay', { p_game: this.gameId }); }

  async getTracker() {
    const t = await this.call('my_tracker', {});
    this.tracker = t;
    return { ...t, url: this.locationUrl };
  }
  async deleteMyData() {
    await this.call('delete_my_data', {});
    this.closeGame(true);
    this.tracker = null;
  }
  async regenerateTracker() {
    const token = await this.call('regenerate_tracker', {});
    this.tracker = { token };
    return token;
  }

  async listSavedAreas() {
    const { data, error } = await this.sb.from('saved_areas').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(friendly(error));
    return data;
  }
  async saveArea(name, area, exclusions) {
    const { error } = await this.sb.from('saved_areas').insert({ name, area, exclusions });
    if (error) throw new Error(friendly(error));
  }
  async deleteSavedArea(id) {
    const { error } = await this.sb.from('saved_areas').delete().eq('id', id);
    if (error) throw new Error(friendly(error));
  }

  /** Standort aus dem Browser an die Edge Function "location" schicken (Fallback zu Traccar). */
  async sendLocation(fix) {
    if (!this.tracker?.token) await this.getTracker();
    const res = await fetch(this.locationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.tracker.token, lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, timestamp: fix.at, source: 'web' }),
      keepalive: true,
    });
    return res.ok ? res.json() : null;
  }

  /** Stößt die Edge Function "tick" an, wenn ein Countdown abgelaufen ist (Ersatz, falls Cron hakt). */
  async pokeTick() {
    if (Date.now() - this.lastPoke < 8000) return;
    this.lastPoke = Date.now();
    const { data } = await this.sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch(this.tickUrl, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  }
}
