// Einstieg für Supabase (Deno). Wird von scripts/build-functions.mjs zu supabase/functions/location/index.ts gebündelt.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { handleLocation } from './location.js';
import { json } from './http.js';
import { serviceKey } from './deno-env.js';

const sb = createClient(Deno.env.get('SUPABASE_URL'), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
const rpc = async (fn, args) => {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};

Deno.serve(async (req) => {
  try {
    return await handleLocation(req, { rpc });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: 'Serverfehler' }, 500);
  }
});
