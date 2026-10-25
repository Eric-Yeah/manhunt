// Gemeinsame Grundlage beider Backends (Supabase und Demo).
import { ts } from '../util/format.js';
// Ein Backend hält einen "Snapshot" des aktuellen Spiels und meldet jede Änderung an die App.
//
// Snapshot:
//   game      Zeile aus games (Zeiten als ISO-Text)
//   players   alle Spieler des Spiels
//   me        der eigene Spieler (oder null)
//   priv      eigener privater Zustand (geglättete Position, Grenz-Status, Joker)
//   pings     sichtbare Pings (Sucher: alle; Gejagte: nur eigene)
//   secrets   sichtbare Ping-Geheimnisse (Täuschungs-Joker)
//   messages  sichtbare Chatnachrichten
//   teammates letzte Position je Teammitglied {player_id: {lat, lon, at, accuracy}}

export function emptySnap() {
  return { game: null, players: [], me: null, priv: null, pings: [], secrets: [], messages: [], teammates: {} };
}

export class BaseBackend {
  constructor() {
    this.listeners = new Set();
    this.snap = emptySnap();
    this.gameId = null;
    this.userId = null;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.snap.me = this.snap.players.find((p) => p.user_id === this.userId && p.status !== 'left') || null;
    for (const fn of this.listeners) {
      try { fn(this.snap); } catch (e) { console.error(e); }
    }
  }

  /** Zeile in einer Liste einfügen/ersetzen/löschen (für Realtime-Ereignisse). */
  static applyChange(list, eventType, row, oldRow, sortKey = null) {
    const id = (row || oldRow)?.id;
    const i = list.findIndex((x) => x.id === id);
    if (eventType === 'DELETE') {
      if (i >= 0) list.splice(i, 1);
      return list;
    }
    if (i >= 0) list[i] = row;
    else {
      list.push(row);
      if (sortKey) list.sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : a[sortKey] < b[sortKey] ? -1 : 0));
    }
    return list;
  }

  static latestPerPlayer(rows) {
    const out = {};
    for (const r of rows) {
      const at = ts(r.recorded_at);
      if (!out[r.player_id] || out[r.player_id].at < at) {
        out[r.player_id] = { lat: r.s_lat ?? r.lat, lon: r.s_lon ?? r.lon, at, accuracy: r.accuracy };
      }
    }
    return out;
  }
}
