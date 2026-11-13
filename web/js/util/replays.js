// Wiederholungen auf diesem Gerät merken. Der Server löscht Routen nach der Aufbewahrungszeit
// (Standard 24 h); was hier liegt, bleibt, auch wenn man die Lobby verlässt oder das Spiel gelöscht wird.
import { load, save } from './storage.js';

const KEY = 'replays';
export const MAX_REPLAYS = 8;

/** Gespeicherte Wiederholungen, neueste zuerst. */
export function listReplays() {
  const list = load(KEY, []);
  return Array.isArray(list) ? list.filter((r) => r && r.id && Array.isArray(r.tracks)) : [];
}

export function getSavedReplay(id) {
  return listReplays().find((r) => r.id === id) || null;
}

/** Legt eine Wiederholung ab (ersetzt eine mit gleicher ID). Ist der Speicher voll, fliegen die ältesten raus. */
export function saveReplay(entry) {
  const list = [entry, ...listReplays().filter((r) => r.id !== entry.id)].slice(0, MAX_REPLAYS);
  while (list.length > 1 && !save(KEY, list)) list.pop();
  return list.length > 0 && save(KEY, list);
}

export function deleteReplay(id) {
  save(KEY, listReplays().filter((r) => r.id !== id));
}

/** Kompakte, in sich geschlossene Kopie einer beendeten Runde (Karte + Routen + Spieler). */
export function buildReplayEntry(snap, replay, { ts }) {
  const g = snap.game;
  return {
    id: g.id,
    title: g.area?.properties?.name || `Runde mit ${snap.players.filter((p) => p.status !== 'left').length} Spielern`,
    at: ts(g.ended_at) || Date.now(),
    winner: g.winner || null,
    duration_ms: Math.max(0, ts(g.ended_at) - ts(g.started_at)),
    started_at: ts(replay.started_at) || ts(g.started_at),
    ended_at: ts(replay.ended_at) || ts(g.ended_at),
    area: g.area?.geometry || null,
    players: snap.players.map((p) => ({
      id: p.id, name: p.name, role: p.role, start_role: p.start_role || null, status: p.status, found_at: ts(p.found_at),
    })),
    tracks: (replay.tracks || []).filter((t) => t.points?.length),
    pings: snap.pings.filter((x) => x.mode === 'circle' && !x.recipient_id).map((x) => ({ id: x.id, lat: x.lat, lon: x.lon, radius_m: x.radius_m })),
    decoys: replay.decoys || [],
  };
}
