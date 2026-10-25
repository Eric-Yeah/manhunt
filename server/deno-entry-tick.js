// Einstieg für Supabase (Deno). Wird von scripts/build-functions.mjs zu supabase/functions/tick/index.ts gebündelt.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { handleTick } from './tick.js';
import { json } from './http.js';
import { serviceKey } from './deno-env.js';

const sb = createClient(Deno.env.get('SUPABASE_URL'), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
const rpc = async (fn, args) => {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};
const getUserId = async (jwt) => {
  const { data, error } = await sb.auth.getUser(jwt);
  return error ? null : data?.user?.id ?? null;
};

Deno.serve(async (req) => {
  try {
    return await handleTick(req, { rpc, getUserId, env: { TICK_SECRET: Deno.env.get('TICK_SECRET') } });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: 'Serverfehler' }, 500);
  }
});
