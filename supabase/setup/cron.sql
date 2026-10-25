-- =====================================================================
-- Manhunt – Zeitsteuerung (pg_cron + pg_net)
-- Einmal im Supabase SQL-Editor ausführen, NACHDEM die Edge Functions deployt sind
-- und das TICK_SECRET als Edge-Function-Secret gesetzt ist (siehe README, Schritt 5).
--
-- Vorher die beiden Werte unten ersetzen:
--   DEINE-PROJEKT-URL  z. B. https://abcdefghijklmnop.supabase.co
--   DEIN-TICK-SECRET   derselbe zufällige Text wie beim Edge-Function-Secret TICK_SECRET
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Werte im Vault ablegen (verschlüsselt). Mehrfach ausführbar.
do $$
declare
  v_url constant text := 'DEINE-PROJEKT-URL';
  v_secret constant text := 'DEIN-TICK-SECRET';
  v_id uuid;
begin
  if v_url like 'DEINE%' or v_secret like 'DEIN-%' then
    raise exception 'Bitte zuerst DEINE-PROJEKT-URL und DEIN-TICK-SECRET in dieser Datei ersetzen.';
  end if;
  select id into v_id from vault.secrets where name = 'manhunt_project_url';
  if v_id is null then perform vault.create_secret(rtrim(v_url, '/'), 'manhunt_project_url');
  else perform vault.update_secret(v_id, rtrim(v_url, '/')); end if;
  select id into v_id from vault.secrets where name = 'manhunt_tick_secret';
  if v_id is null then perform vault.create_secret(v_secret, 'manhunt_tick_secret');
  else perform vault.update_secret(v_id, v_secret); end if;
end $$;

-- Ruft die Edge Function "tick" nur auf, wenn wirklich etwas fällig ist
-- (Ping, Spielende, Zone, Strafe). Ohne laufendes Spiel entstehen keine Aufrufe.
create or replace function public.tick_dispatch() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  if not public.has_due_work() then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'manhunt_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'manhunt_tick_secret';
  perform net.http_post(
    url := v_url || '/functions/v1/tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-tick-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
end $$;
revoke execute on function public.tick_dispatch() from public, anon, authenticated;

-- Alle 10 Sekunden prüfen; stündlich alte Spiele und Cron-Protokolle löschen.
select cron.schedule('manhunt-tick', '10 seconds', 'select public.tick_dispatch()');
select cron.schedule('manhunt-purge', '17 * * * *',
  $job$ select public.purge_expired(); delete from cron.job_run_details where end_time < now() - interval '1 day'; $job$);

-- Kontrolle:
-- select jobname, schedule, active from cron.job;
-- select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
