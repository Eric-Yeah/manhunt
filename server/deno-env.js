// Secret Key für den Server-Zugriff: neue Supabase-Keys (SUPABASE_SECRET_KEYS) oder alter service_role-Key.
export function serviceKey() {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      if (keys.default) return keys.default;
      const first = Object.values(keys)[0];
      if (first) return first;
    } catch { /* fällt zurück */ }
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!legacy) throw new Error('Kein Secret Key gefunden (SUPABASE_SECRET_KEYS oder SUPABASE_SERVICE_ROLE_KEY).');
  return legacy;
}
