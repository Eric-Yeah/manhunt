// Edge Function "location": nimmt Standorte von Traccar Client und der Web-App entgegen.
// Ablauf: Format lesen -> Token prüfen (inkl. Rate-Limit) -> Filter/Glättung/Grenzprüfung -> speichern.
import { parseLocationRequest, TOKEN_RE } from '../web/js/core/traccar.js';
import { processLocation } from '../web/js/core/engine.js';
import { CORS, json } from './http.js';

const MAX_BODY = 20_000;

/**
 * @param {Request} req
 * @param {{rpc: (fn:string, args:object) => Promise<any>, now?: () => number}} deps
 */
export async function handleLocation(req, { rpc, now = Date.now }) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET' && req.method !== 'POST') return json({ ok: false, error: 'Methode nicht erlaubt' }, 405);

  const bodyText = req.method === 'POST' ? await req.text() : '';
  if (bodyText.length > MAX_BODY) return json({ ok: false, error: 'Anfrage zu groß' }, 413);

  const m = parseLocationRequest({ method: req.method, url: req.url, contentType: req.headers.get('content-type') || '', bodyText });
  // Unbekannte oder falsch geformte Kennung: 401, damit man den Fehler in Traccar sieht.
  if (!m.token || !TOKEN_RE.test(m.token)) return json({ ok: false, error: 'Unbekannte Gerätekennung' }, 401);

  const ctx = await rpc('svc_location_context', { p_token: m.token, p_source: m.source });
  if (!ctx?.ok) {
    if (ctx?.reason === 'rate') return json({ ok: true, ignored: 'zu schnell hintereinander' });
    return json({ ok: false, error: 'Unbekannte Gerätekennung' }, 401);
  }
  if (!ctx.active) return json({ ok: true, active: false, info: 'Kein aktives Spiel. Standort wird nicht gespeichert.' });

  const base = { player_id: ctx.player.id, source: m.source };
  if (ctx.game.status !== 'running' || m.invalidFix) {
    // Warteraum/Pause: nur "Signal empfangen" vermerken, keinen Standort speichern.
    await rpc('svc_store_location', { p: { ...base, signal_only: true } });
    return json({ ok: true, stored: false, status: ctx.game.status });
  }

  const res = processLocation(
    { game: ctx.game, player: ctx.player, priv: ctx.priv },
    { lat: m.lat, lon: m.lon, accuracy: m.accuracy, at: m.at },
    now(),
  );
  await rpc('svc_store_location', {
    p: { ...base, accepted: res.accepted, kf: res.kf, location: res.location, boundary: res.boundary, oob: res.oob },
  });
  return json({ ok: true, accepted: res.accepted, reason: res.reason || undefined, boundary: res.boundary || undefined });
}
