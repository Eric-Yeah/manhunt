// Edge Function "tick": erzeugt fällige Pings, beendet Spiele nach Zeit, schrumpft die Zone
// und verhängt Grenz-Strafen. Wird von pg_cron aufgerufen (mit Secret) und zusätzlich von den
// Apps angestoßen, wenn ein Countdown abläuft (mit Nutzer-Login, dann nur für eigene Spiele).
import { planTick, isPlanEmpty } from '../web/js/core/engine.js';
import { CORS, json, safeEqual } from './http.js';

/**
 * @param {Request} req
 * @param {{rpc: Function, env: {TICK_SECRET?: string}, getUserId: (jwt:string) => Promise<string|null>, now?: () => number, rng?: () => number}} deps
 */
export async function handleTick(req, { rpc, env, getUserId, now = Date.now, rng = Math.random }) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Methode nicht erlaubt' }, 405);

  let userId = null;
  const secret = req.headers.get('x-tick-secret');
  if (secret) {
    if (!env.TICK_SECRET || !safeEqual(secret, env.TICK_SECRET)) return json({ ok: false, error: 'Falsches Secret' }, 401);
  } else {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    userId = jwt ? await getUserId(jwt) : null;
    if (!userId) return json({ ok: false, error: 'Nicht angemeldet' }, 401);
  }

  const games = await rpc('svc_due_games', { p_user: userId });
  const results = [];
  for (const ctx of games || []) {
    const plan = planTick(ctx, now(), rng);
    if (isPlanEmpty(plan)) continue;
    results.push({ game_id: ctx.game.id, ...(await rpc('svc_apply_tick', { p: plan })) });
  }
  return json({ ok: true, due: (games || []).length, results });
}
