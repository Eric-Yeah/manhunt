-- =====================================================================
-- Manhunt – Datenbankschema für Supabase (Postgres 15+)
--
-- Grundsatz: Clients dürfen Tabellen nur LESEN (gefiltert per Row-Level-Security).
-- Alles, was etwas verändert, läuft über Funktionen (RPC), die selbst prüfen,
-- wer was darf. Echte Standorte (locations, player_private) sieht nur der Spieler
-- selbst; Sucher bekommen nur die bereits verfremdeten Pings.
-- Funktionen mit Präfix svc_ darf nur der Server (Edge Functions) aufrufen.
-- =====================================================================

-- ---------- Tabellen ----------

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  host_id uuid not null,
  status text not null default 'lobby' check (status in ('lobby', 'running', 'paused', 'ended')),
  settings jsonb not null default '{}'::jsonb,
  area jsonb,
  exclusions jsonb not null default '[]'::jsonb,
  zone_stages jsonb not null default '[]'::jsonb,
  zone_index int not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  hunt_starts_at timestamptz,
  ends_at timestamptz,
  next_ping_at timestamptz,
  ping_seq int not null default 0,
  hunt_announced boolean not null default false,
  paused_at timestamptz,
  paused_by uuid,
  pause_reason text,
  ended_at timestamptz,
  winner text check (winner in ('hunters', 'hiders')),
  end_reason text,
  purge_at timestamptz,
  rematch_of uuid,
  rematch_id uuid
);
create unique index if not exists games_active_code on public.games (code) where status <> 'ended';
create index if not exists games_status on public.games (status);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null,
  name text not null check (char_length(name) between 1 and 24),
  role text not null default 'random' check (role in ('hunter', 'hider', 'random')),
  is_host boolean not null default false,
  ready boolean not null default false,
  status text not null default 'active' check (status in ('active', 'found', 'eliminated', 'left')),
  found_at timestamptz,
  last_signal_at timestamptz,
  last_traccar_at timestamptz,
  last_web_at timestamptz,
  joined_at timestamptz not null default now(),
  unique (game_id, user_id)
);
create index if not exists players_user on public.players (user_id);
create index if not exists players_game on public.players (game_id);

-- Privater Zustand je Spieler: geglättete Position, Grenz-Status, Joker. Nur für den Spieler selbst lesbar.
create table if not exists public.player_private (
  player_id uuid primary key references public.players (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null,
  kf_lat double precision,
  kf_lon double precision,
  kf_var double precision,
  kf_at timestamptz,
  kf_rejects int not null default 0,
  last_accuracy real,
  inside boolean,
  edge_dist_m real,
  violation text check (violation in ('outside', 'exclusion')),
  violation_name text,
  oob_since timestamptz,
  oob_deadline timestamptz,
  joker_pending text check (joker_pending in ('skip', 'double', 'decoy')),
  joker_used jsonb not null default '{}'::jsonb
);
create index if not exists player_private_game on public.player_private (game_id);

-- Geheimer Tracker-Token pro Nutzer (Gerät). Wird in Traccar als "Gerätekennung" eingetragen.
create table if not exists public.user_trackers (
  user_id uuid primary key,
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{32,128}$'),
  created_at timestamptz not null default now(),
  last_request_at timestamptz,
  last_source text
);

-- Echte Positionen. Nur für den Spieler selbst (und Teammitglieder) sichtbar, nie für das andere Team.
create table if not exists public.locations (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  lat double precision not null,
  lon double precision not null,
  s_lat double precision,
  s_lon double precision,
  accuracy real,
  source text not null check (source in ('traccar', 'web')),
  recorded_at timestamptz not null,
  received_at timestamptz not null default now()
);
create index if not exists locations_game_player_time on public.locations (game_id, player_id, recorded_at);

-- Pings: bereits verfremdet. Für Sucher sichtbar (Richtungs-Pings nur für den jeweiligen Sucher).
create table if not exists public.pings (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  seq int not null,
  hider_id uuid not null references public.players (id) on delete cascade,
  recipient_id uuid references public.players (id) on delete cascade,
  kind text not null check (kind in ('regular', 'penalty', 'joker_skip')),
  mode text not null check (mode in ('exact', 'circle', 'direction', 'none')),
  lat double precision,
  lon double precision,
  radius_m real,
  ref_lat double precision,
  ref_lon double precision,
  ref_is_center boolean,
  bearing_deg real,
  sector_deg real,
  distance_m real,
  dir_label text,
  age_s int,
  no_signal boolean not null default false,
  joker text check (joker in ('skip', 'double')),
  created_at timestamptz not null default now()
);
create index if not exists pings_game_seq on public.pings (game_id, seq);

-- Geheimnisse zu Pings (Joker "falscher Ort"). Erst nach Spielende für alle sichtbar.
create table if not exists public.ping_secrets (
  ping_id bigint primary key references public.pings (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  hider_id uuid not null references public.players (id) on delete cascade,
  is_decoy boolean not null default false
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  player_id uuid references public.players (id) on delete set null,
  sender_name text,
  channel text not null check (channel in ('hunters', 'hiders', 'all')),
  kind text not null default 'chat' check (kind in ('chat', 'host', 'system', 'sos')),
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists messages_game on public.messages (game_id, id);

create table if not exists public.saved_areas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 40),
  area jsonb not null,
  exclusions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  check (octet_length(area::text) < 200000 and octet_length(exclusions::text) < 200000)
);
create index if not exists saved_areas_owner on public.saved_areas (owner_id);

-- ---------- Kleine Helfer ----------

create or replace function public.ms(t timestamptz) returns bigint
language sql immutable set search_path = '' as $$
  select case when t is null then null else (extract(epoch from t) * 1000)::bigint end
$$;

create or replace function public.ts(ms bigint) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when ms is null then null else to_timestamp(ms / 1000.0) end
$$;

create or replace function public.new_token() returns text
language sql volatile set search_path = '' as $$
  -- 2 × UUIDv4 aus dem kryptografischen Zufallsgenerator: 64 Hex-Zeichen, ~244 Bit Zufall
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

create or replace function public.gen_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- ohne 0/O, 1/I/L
  b bytea;
  c text;
begin
  loop
    b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    c := '';
    for i in 0..5 loop
      c := c || substr(alphabet, (get_byte(b, i) % 31) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = c and status <> 'ended');
  end loop;
  return c;
end $$;

-- Muss zu normalizeSettings() in web/js/core/engine.js passen.
create or replace function public.normalize_settings(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  r jsonb := '{
    "ping_interval_s": 300, "ping_mode": "circle", "ping_radius_m": 250, "headstart_s": 600,
    "duration_s": 3600, "role_mode": "choose", "boundary_penalty": "extra_ping", "boundary_warn_s": 30,
    "boundary_tolerance_m": 20, "accuracy_max_m": 50, "shrink_enabled": false, "shrink_every_s": 900,
    "shrink_percent": 10, "joker_skip": false, "joker_double": false, "joker_decoy": false,
    "joker_cooldown_s": 900, "show_teammates": true, "retention_h": 24 }'::jsonb;
  lim constant jsonb := '{
    "ping_interval_s": [60, 3600], "ping_radius_m": [50, 2000], "headstart_s": [0, 3600],
    "duration_s": [300, 21600], "boundary_warn_s": [5, 300], "boundary_tolerance_m": [0, 100],
    "accuracy_max_m": [10, 200], "shrink_every_s": [60, 3600], "shrink_percent": [5, 50],
    "joker_cooldown_s": [60, 3600], "retention_h": [1, 72] }'::jsonb;
  k text;
  v numeric;
begin
  p := coalesce(p, '{}'::jsonb);
  if jsonb_typeof(p) <> 'object' then return r; end if;
  for k in select jsonb_object_keys(lim) loop
    if jsonb_typeof(p -> k) = 'number' then
      v := least((lim -> k ->> 1)::numeric, greatest((lim -> k ->> 0)::numeric, (p ->> k)::numeric));
      r := jsonb_set(r, array[k], to_jsonb(round(v)::int));
    end if;
  end loop;
  if p ->> 'ping_mode' in ('exact', 'circle', 'direction') then r := jsonb_set(r, '{ping_mode}', p -> 'ping_mode'); end if;
  if p ->> 'role_mode' in ('choose', 'random') then r := jsonb_set(r, '{role_mode}', p -> 'role_mode'); end if;
  if p ->> 'boundary_penalty' in ('extra_ping', 'eliminate') then r := jsonb_set(r, '{boundary_penalty}', p -> 'boundary_penalty'); end if;
  foreach k in array array['shrink_enabled', 'joker_skip', 'joker_double', 'joker_decoy', 'show_teammates'] loop
    if jsonb_typeof(p -> k) = 'boolean' then r := jsonb_set(r, array[k], p -> k); end if;
  end loop;
  return r;
end $$;

-- Prüft Typ, Ringe (geschlossen, 4 bis 500 Punkte) und dass alle Koordinaten Zahlen im gültigen Bereich sind.
create or replace function public.is_polygon_feature(f jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  coords jsonb;
  ring jsonb;
  pt jsonb;
  n int;
begin
  if f is null or jsonb_typeof(f) <> 'object' or jsonb_typeof(f -> 'geometry') is distinct from 'object'
     or f -> 'geometry' ->> 'type' is distinct from 'Polygon' then return false; end if;
  coords := f -> 'geometry' -> 'coordinates';
  if jsonb_typeof(coords) is distinct from 'array' or jsonb_array_length(coords) not between 1 and 21 then return false; end if;
  for ring in select * from jsonb_array_elements(coords) loop
    if jsonb_typeof(ring) <> 'array' then return false; end if;
    n := jsonb_array_length(ring);
    if n not between 4 and 500 then return false; end if;
    for pt in select * from jsonb_array_elements(ring) loop
      if jsonb_typeof(pt) <> 'array' or jsonb_array_length(pt) < 2
         or jsonb_typeof(pt -> 0) <> 'number' or jsonb_typeof(pt -> 1) <> 'number' then return false; end if;
      if abs((pt ->> 0)::numeric) > 180 or abs((pt ->> 1)::numeric) > 90 then return false; end if;
    end loop;
    if (ring -> 0 ->> 0)::numeric <> (ring -> (n - 1) ->> 0)::numeric
       or (ring -> 0 ->> 1)::numeric <> (ring -> (n - 1) ->> 1)::numeric then return false; end if;
  end loop;
  return true;
end $$;

-- ---------- Rechte-Helfer (für RLS) ----------

create or replace function public.member_player_id(p_game uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.players where game_id = p_game and user_id = auth.uid() and status <> 'left' limit 1
$$;

create or replace function public.game_status(p_game uuid) returns text
language sql stable security definer set search_path = '' as $$
  select status from public.games where id = p_game
$$;

create or replace function public.can_see_location(p_game uuid, p_player uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me public.players;
  them_role text;
  g_status text;
  show boolean;
begin
  select * into me from public.players where game_id = p_game and user_id = auth.uid() and status <> 'left';
  if not found then return false; end if;
  if me.id = p_player then return true; end if;
  select status, coalesce((settings ->> 'show_teammates')::boolean, true) into g_status, show from public.games where id = p_game;
  if g_status not in ('running', 'paused') or not show or me.status <> 'active' then return false; end if;
  select role into them_role from public.players where id = p_player and game_id = p_game;
  return me.role in ('hunter', 'hider') and them_role = me.role;
end $$;

create or replace function public.can_see_ping(p_game uuid, p_hider uuid, p_recipient uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me public.players;
begin
  select * into me from public.players where game_id = p_game and user_id = auth.uid() and status <> 'left';
  if not found then return false; end if;
  if public.game_status(p_game) = 'ended' then return true; end if;
  if me.role = 'hunter' then return p_recipient is null or p_recipient = me.id; end if;
  if me.role = 'hider' then return p_hider = me.id and p_recipient is null; end if;
  return false;
end $$;

create or replace function public.can_see_message(p_game uuid, p_channel text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me public.players;
begin
  select * into me from public.players where game_id = p_game and user_id = auth.uid() and status <> 'left';
  if not found then return false; end if;
  if p_channel = 'all' or public.game_status(p_game) = 'ended' then return true; end if;
  return (p_channel = 'hunters' and me.role = 'hunter') or (p_channel = 'hiders' and me.role = 'hider');
end $$;

-- ---------- Row-Level-Security ----------

alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.player_private enable row level security;
alter table public.user_trackers enable row level security;
alter table public.locations enable row level security;
alter table public.pings enable row level security;
alter table public.ping_secrets enable row level security;
alter table public.messages enable row level security;
alter table public.saved_areas enable row level security;

drop policy if exists games_read on public.games;
create policy games_read on public.games for select to authenticated
  using (public.member_player_id(id) is not null);

drop policy if exists players_read on public.players;
create policy players_read on public.players for select to authenticated
  using (public.member_player_id(game_id) is not null);

drop policy if exists private_read on public.player_private;
create policy private_read on public.player_private for select to authenticated
  using (user_id = auth.uid());

drop policy if exists trackers_read on public.user_trackers;
create policy trackers_read on public.user_trackers for select to authenticated
  using (user_id = auth.uid());

drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations for select to authenticated
  using (public.can_see_location(game_id, player_id));

drop policy if exists pings_read on public.pings;
create policy pings_read on public.pings for select to authenticated
  using (public.can_see_ping(game_id, hider_id, recipient_id));

drop policy if exists secrets_read on public.ping_secrets;
create policy secrets_read on public.ping_secrets for select to authenticated
  using (
    (public.game_status(game_id) = 'ended' and public.member_player_id(game_id) is not null)
    or hider_id = public.member_player_id(game_id)
  );

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (public.can_see_message(game_id, channel));

drop policy if exists saved_areas_own on public.saved_areas;
create policy saved_areas_own on public.saved_areas for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Gespeicherte Gebiete: höchstens 20 je Nutzer, Zeitstempel kann der Client nicht setzen.
create or replace function public.saved_areas_guard() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.saved_areas where owner_id = new.owner_id) >= 20 then
      raise exception 'Du kannst höchstens 20 Gebiete speichern.';
    end if;
    new.created_at := now();
  else
    new.created_at := old.created_at;
    new.owner_id := old.owner_id;
  end if;
  if not public.is_polygon_feature(new.area) then raise exception 'Ungültiges Spielgebiet.'; end if;
  if jsonb_typeof(new.exclusions) <> 'array' or jsonb_array_length(new.exclusions) > 20 then
    raise exception 'Höchstens 20 Sperrzonen.';
  end if;
  return new;
end $$;

drop trigger if exists saved_areas_guard on public.saved_areas;
create trigger saved_areas_guard before insert or update on public.saved_areas
  for each row execute function public.saved_areas_guard();

-- Clients dürfen nur lesen (Ausnahme: eigene gespeicherte Gebiete).
revoke all on public.games, public.players, public.player_private, public.user_trackers, public.locations,
  public.pings, public.ping_secrets, public.messages, public.saved_areas from anon, authenticated;
grant select on public.games, public.players, public.player_private, public.user_trackers, public.locations,
  public.pings, public.ping_secrets, public.messages to authenticated;
grant select, insert, update, delete on public.saved_areas to authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Realtime liefert so bei UPDATE/DELETE vollständige Zeilen (große jsonb-Spalten, Filter bei DELETE).
alter table public.games replica identity full;
alter table public.players replica identity full;

-- ---------- Interne Spiel-Helfer ----------

create or replace function public.require_uid() returns uuid
language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet.' using errcode = '42501'; end if;
  return auth.uid();
end $$;

create or replace function public.clean_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
declare n text := btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', '', 'g'), '\s+', ' ', 'g'));
begin
  if char_length(n) < 1 then raise exception 'Bitte gib einen Namen ein.'; end if;
  return left(n, 24);
end $$;

create or replace function public.unique_name(p_game uuid, p_name text) returns text
language plpgsql stable set search_path = '' as $$
declare
  n text := p_name;
  i int := 2;
begin
  while exists (select 1 from public.players where game_id = p_game and lower(name) = lower(n) and status <> 'left') loop
    n := left(p_name, 21) || ' ' || i;
    i := i + 1;
  end loop;
  return n;
end $$;

create or replace function public.ensure_tracker(p_user uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare t text;
begin
  insert into public.user_trackers (user_id, token) values (p_user, public.new_token())
  on conflict (user_id) do nothing;
  select token into t from public.user_trackers where user_id = p_user;
  return t;
end $$;

create or replace function public.post_system(p_game uuid, p_body text, p_kind text default 'system', p_channel text default 'all')
returns void language sql volatile security definer set search_path = '' as $$
  insert into public.messages (game_id, channel, kind, body) values (p_game, p_channel, p_kind, left(p_body, 500));
$$;

create or replace function public.finish_game(p_game uuid, p_winner text, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.games;
  msg text;
begin
  select * into g from public.games where id = p_game for update;
  if not found or g.status = 'ended' then return; end if;
  update public.games set
    status = 'ended', ended_at = now(), winner = p_winner, end_reason = p_reason,
    paused_at = null, paused_by = null, pause_reason = null,
    purge_at = now() + make_interval(hours => coalesce((g.settings ->> 'retention_h')::int, 24))
  where id = p_game;
  update public.player_private set oob_since = null, oob_deadline = null, joker_pending = null where game_id = p_game;
  msg := case p_reason
    when 'time' then 'Die Zeit ist abgelaufen. Die Gejagten gewinnen!'
    when 'all_found' then 'Alle Gejagten sind gefunden oder raus. Die Sucher gewinnen!'
    when 'aborted' then 'Der Host hat das Spiel beendet.'
    else 'Das Spiel ist vorbei.' end;
  perform public.post_system(p_game, msg);
end $$;

create or replace function public.finish_if_done(p_game uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.game_status(p_game) in ('running', 'paused')
     and not exists (select 1 from public.players where game_id = p_game and role = 'hider' and status = 'active') then
    perform public.finish_game(p_game, 'hunters', 'all_found');
    return true;
  end if;
  -- Alle Sucher sind gegangen: Die Gejagten gewinnen.
  if public.game_status(p_game) in ('running', 'paused')
     and not exists (select 1 from public.players where game_id = p_game and role = 'hunter' and status = 'active') then
    perform public.finish_game(p_game, 'hiders', 'no_hunters');
    return true;
  end if;
  return false;
end $$;

-- Spieler verlässt ein Spiel (Warteraum: Eintrag löschen; laufend: Status "left").
create or replace function public.leave_player(p_player uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.players;
  g public.games;
  next_host public.players;
begin
  select * into p from public.players where id = p_player;
  if not found then return; end if;
  select * into g from public.games where id = p.game_id for update;
  if g.status = 'lobby' then
    delete from public.players where id = p.id;
  elsif g.status in ('running', 'paused') then
    update public.players set status = 'left', is_host = false where id = p.id;
    update public.player_private set oob_since = null, oob_deadline = null where player_id = p.id;
    perform public.post_system(g.id, p.name || ' hat das Spiel verlassen.');
  else
    update public.players set status = 'left' where id = p.id;
  end if;
  if p.is_host and g.status <> 'ended' then
    select * into next_host from public.players
      where game_id = g.id and status <> 'left' and id <> p.id order by joined_at limit 1;
    if not found then
      delete from public.games where id = g.id;
      return;
    end if;
    update public.players set is_host = true where id = next_host.id;
    update public.games set host_id = next_host.user_id where id = g.id;
    if g.status <> 'lobby' then perform public.post_system(g.id, next_host.name || ' ist jetzt Host.'); end if;
  end if;
  if g.status in ('running', 'paused') then perform public.finish_if_done(g.id); end if;
end $$;

create or replace function public.leave_other_games(p_user uuid, p_except uuid default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select p.id from public.players p join public.games g on g.id = p.game_id
    where p.user_id = p_user and p.status <> 'left' and g.status in ('lobby', 'running', 'paused')
      and (p_except is null or g.id <> p_except)
  loop
    perform public.leave_player(r.id);
  end loop;
end $$;

create or replace function public.add_player(p_game uuid, p_user uuid, p_name text, p_role text, p_host boolean)
returns public.players language plpgsql volatile security definer set search_path = '' as $$
declare p public.players;
begin
  insert into public.players (game_id, user_id, name, role, is_host, ready)
  values (p_game, p_user, public.unique_name(p_game, p_name), p_role, p_host, p_host)
  returning * into p;
  insert into public.player_private (player_id, game_id, user_id) values (p.id, p_game, p_user);
  perform public.ensure_tracker(p_user);
  return p;
end $$;

create or replace function public.my_player(p_game uuid) returns public.players
language plpgsql stable security definer set search_path = '' as $$
declare p public.players;
begin
  select * into p from public.players where game_id = p_game and user_id = public.require_uid() and status <> 'left';
  if not found then raise exception 'Du bist nicht in diesem Spiel.' using errcode = '42501'; end if;
  return p;
end $$;

create or replace function public.host_game(p_game uuid, p_status text[] default null) returns public.games
language plpgsql volatile security definer set search_path = '' as $$
declare g public.games;
begin
  select * into g from public.games where id = p_game for update;
  if not found or g.host_id <> public.require_uid() then
    raise exception 'Nur der Host kann das.' using errcode = '42501';
  end if;
  if p_status is not null and not (g.status = any (p_status)) then
    raise exception 'Das geht in diesem Spielzustand nicht.';
  end if;
  return g;
end $$;

-- ---------- RPCs für die App ----------

create or replace function public.create_game(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := public.require_uid();
  g public.games;
  p public.players;
begin
  perform public.leave_other_games(uid);
  insert into public.games (code, host_id, settings) values (public.gen_code(), uid, public.normalize_settings('{}'))
  returning * into g;
  p := public.add_player(g.id, uid, public.clean_name(p_name), 'random', true);
  return jsonb_build_object('game_id', g.id, 'player_id', p.id, 'code', g.code);
end $$;

create or replace function public.join_game(p_code text, p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := public.require_uid();
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  g public.games;
  p public.players;
  n text := public.clean_name(p_name);
  had_left boolean := false;
begin
  select * into g from public.games where code = c and status <> 'ended' order by created_at desc limit 1 for update;
  if not found then raise exception 'Kein offenes Spiel mit diesem Code gefunden.'; end if;
  select * into p from public.players where game_id = g.id and user_id = uid;
  if found then
    if p.status <> 'left' then
      return jsonb_build_object('game_id', g.id, 'player_id', p.id, 'code', g.code);
    end if;
    had_left := true;
  end if;
  if g.status <> 'lobby' then raise exception 'Das Spiel läuft schon. Beitreten geht nur im Warteraum.'; end if;
  if (select count(*) from public.players where game_id = g.id and status <> 'left') >= 10 then
    raise exception 'Das Spiel ist voll (höchstens 10 Spieler).';
  end if;
  perform public.leave_other_games(uid, g.id);
  if had_left then delete from public.players where id = p.id; end if;
  p := public.add_player(g.id, uid, n, 'random', false);
  return jsonb_build_object('game_id', g.id, 'player_id', p.id, 'code', g.code);
end $$;

create or replace function public.rename_me(p_game uuid, p_name text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.players := public.my_player(p_game);
begin
  update public.players set name = public.unique_name(p_game, public.clean_name(p_name)) where id = me.id and name <> public.clean_name(p_name);
end $$;

create or replace function public.update_game(p_game uuid, p_patch jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.games := public.host_game(p_game, array['lobby']);
  s jsonb := g.settings;
  a jsonb := g.area;
  ex jsonb := g.exclusions;
  st jsonb := g.zone_stages;
  e jsonb;
  prev int := -1;
begin
  if octet_length(coalesce(p_patch, '{}'::jsonb)::text) > 600000 then raise exception 'Die Daten sind zu groß.'; end if;
  if p_patch ? 'settings' then s := public.normalize_settings(p_patch -> 'settings'); end if;
  if p_patch ? 'area' then
    if not public.is_polygon_feature(p_patch -> 'area') then raise exception 'Ungültiges Spielgebiet.'; end if;
    a := p_patch -> 'area';
    if not (p_patch ? 'zone_stages') then
      st := jsonb_build_array(jsonb_build_object('at_s', 0, 'geometry', a -> 'geometry'));
    end if;
  end if;
  if p_patch ? 'exclusions' then
    ex := coalesce(p_patch -> 'exclusions', '[]'::jsonb);
    if jsonb_typeof(ex) <> 'array' or jsonb_array_length(ex) > 20 then raise exception 'Höchstens 20 Sperrzonen.'; end if;
    for e in select * from jsonb_array_elements(ex) loop
      if not public.is_polygon_feature(e) then raise exception 'Ungültige Sperrzone.'; end if;
    end loop;
  end if;
  if p_patch ? 'zone_stages' then
    st := p_patch -> 'zone_stages';
    if jsonb_typeof(st) <> 'array' or jsonb_array_length(st) < 1 or jsonb_array_length(st) > 60 then
      raise exception 'Ungültige Zonen-Stufen.';
    end if;
    for e in select * from jsonb_array_elements(st) loop
      if jsonb_typeof(e -> 'at_s') is distinct from 'number' or (e ->> 'at_s')::numeric <> floor((e ->> 'at_s')::numeric)
         or (e ->> 'at_s')::numeric not between 0 and 86400 or (e ->> 'at_s')::int <= prev
         or not public.is_polygon_feature(jsonb_build_object('geometry', e -> 'geometry')) then
        raise exception 'Ungültige Zonen-Stufen.';
      end if;
      prev := (e ->> 'at_s')::int;
    end loop;
    if (st -> 0 ->> 'at_s')::int <> 0 then raise exception 'Ungültige Zonen-Stufen.'; end if;
  end if;
  update public.games set settings = s, area = a, exclusions = ex, zone_stages = st where id = p_game;
  if (s ->> 'role_mode') = 'random' then
    update public.players set role = 'random' where game_id = p_game;
  end if;
end $$;

create or replace function public.set_role(p_game uuid, p_role text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.players := public.my_player(p_game);
  g public.games;
begin
  select * into g from public.games where id = p_game;
  if g.status <> 'lobby' then raise exception 'Rollen lassen sich nur im Warteraum ändern.'; end if;
  if p_role not in ('hunter', 'hider', 'random') then raise exception 'Unbekannte Rolle.'; end if;
  if g.settings ->> 'role_mode' = 'random' and p_role <> 'random' then
    raise exception 'Der Host lässt die Rollen zufällig verteilen.';
  end if;
  update public.players set role = p_role where id = me.id;
end $$;

create or replace function public.set_player_role(p_player uuid, p_role text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.players;
begin
  select * into p from public.players where id = p_player;
  if not found then raise exception 'Spieler nicht gefunden.'; end if;
  perform public.host_game(p.game_id, array['lobby']);
  if p_role not in ('hunter', 'hider', 'random') then raise exception 'Unbekannte Rolle.'; end if;
  update public.players set role = p_role where id = p_player;
end $$;

create or replace function public.set_ready(p_game uuid, p_ready boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.players := public.my_player(p_game);
begin
  update public.players set ready = coalesce(p_ready, false) where id = me.id;
end $$;

create or replace function public.kick_player(p_player uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare p public.players;
begin
  select * into p from public.players where id = p_player;
  if not found then return; end if;
  perform public.host_game(p.game_id, array['lobby']);
  if p.is_host then raise exception 'Du kannst dich nicht selbst entfernen.'; end if;
  delete from public.players where id = p_player;
end $$;

create or replace function public.start_game(p_game uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.games := public.host_game(p_game, array['lobby']);
  n int;
  target int;
  hunters int;
  r record;
  head int := coalesce((g.settings ->> 'headstart_s')::int, 600);
  dur int := coalesce((g.settings ->> 'duration_s')::int, 3600);
begin
  if g.area is null then raise exception 'Lege zuerst das Spielgebiet fest.'; end if;
  select count(*) into n from public.players where game_id = p_game and status <> 'left';
  if n < 2 then raise exception 'Es braucht mindestens zwei Spieler.'; end if;
  target := greatest(1, round(n / 3.0)::int);
  if g.settings ->> 'role_mode' = 'random' then
    update public.players set role = 'random' where game_id = p_game;
  end if;
  select count(*) into hunters from public.players where game_id = p_game and status <> 'left' and role = 'hunter';
  for r in select id from public.players where game_id = p_game and status <> 'left' and role = 'random' order by random() loop
    if hunters < target then
      update public.players set role = 'hunter' where id = r.id;
      hunters := hunters + 1;
    else
      update public.players set role = 'hider' where id = r.id;
    end if;
  end loop;
  if hunters = 0 then raise exception 'Es braucht mindestens einen Sucher.'; end if;
  if not exists (select 1 from public.players where game_id = p_game and status <> 'left' and role = 'hider') then
    raise exception 'Es braucht mindestens einen Gejagten.';
  end if;
  update public.players set status = 'active', found_at = null where game_id = p_game and status <> 'left';
  update public.player_private set
    kf_lat = null, kf_lon = null, kf_var = null, kf_at = null, kf_rejects = 0, inside = null, edge_dist_m = null,
    violation = null, violation_name = null, oob_since = null, oob_deadline = null, joker_pending = null, joker_used = '{}'::jsonb
  where game_id = p_game;
  update public.games set
    status = 'running', started_at = now(),
    hunt_starts_at = now() + make_interval(secs => head),
    ends_at = now() + make_interval(secs => head + dur),
    next_ping_at = now() + make_interval(secs => head),
    ping_seq = 0, zone_index = 0, hunt_announced = (head = 0)
  where id = p_game;
  perform public.post_system(p_game, case when head > 0
    then 'Das Spiel läuft! Die Gejagten haben ' || round(head / 60.0)::int || ' min Vorsprung.'
    else 'Das Spiel läuft! Kein Vorsprung, die Jagd beginnt sofort.' end);
end $$;

create or replace function public.mark_found(p_game uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.players := public.my_player(p_game);
begin
  if public.game_status(p_game) not in ('running', 'paused') then raise exception 'Das Spiel läuft gerade nicht.'; end if;
  if me.role <> 'hider' or me.status <> 'active' then raise exception 'Nur aktive Gejagte können das.'; end if;
  update public.players set status = 'found', found_at = now() where id = me.id;
  update public.player_private set oob_since = null, oob_deadline = null, joker_pending = null where player_id = me.id;
  perform public.post_system(p_game, me.name || ' wurde gefunden!');
  perform public.finish_if_done(p_game);
end $$;

create or replace function public.pause_game(p_game uuid, p_reason text default 'Pause') returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.players := public.my_player(p_game);
  g public.games;
  reason text := left(btrim(regexp_replace(coalesce(p_reason, 'Pause'), '[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', '', 'g')), 120);
begin
  select * into g from public.games where id = p_game for update;
  if g.status <> 'running' then raise exception 'Das Spiel läuft gerade nicht.'; end if;
  update public.games set status = 'paused', paused_at = now(), paused_by = me.id, pause_reason = reason where id = p_game;
  perform public.post_system(p_game,
    case when upper(reason) = 'SOS' then 'SOS von ' || me.name || '! Das Spiel ist für alle angehalten.'
         else me.name || ' hat das Spiel pausiert: ' || reason end, 'sos');
end $$;

create or replace function public.resume_game(p_game uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.players := public.my_player(p_game);
  g public.games;
  d interval;
begin
  select * into g from public.games where id = p_game for update;
  if g.status <> 'paused' then raise exception 'Das Spiel ist nicht pausiert.'; end if;
  if not me.is_host and g.paused_by is distinct from me.id then
    raise exception 'Fortsetzen kann der Host oder wer pausiert hat.' using errcode = '42501';
  end if;
  d := now() - g.paused_at;
  update public.games set
    status = 'running', hunt_starts_at = hunt_starts_at + d, ends_at = ends_at + d, next_ping_at = next_ping_at + d,
    paused_at = null, paused_by = null, pause_reason = null
  where id = p_game;
  update public.player_private set oob_since = null, oob_deadline = null where game_id = p_game;
  perform public.post_system(p_game, me.name || ' hat das Spiel fortgesetzt. Weiter geht''s!');
end $$;

create or replace function public.end_game(p_game uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare g public.games := public.host_game(p_game, array['lobby', 'running', 'paused']);
begin
  if g.status = 'lobby' then
    delete from public.games where id = p_game;
  else
    perform public.finish_game(p_game, null, 'aborted');
  end if;
end $$;

create or replace function public.leave_game(p_game uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.players := public.my_player(p_game);
begin
  perform public.leave_player(me.id);
end $$;

create or replace function public.send_message(p_game uuid, p_channel text, p_body text, p_announce boolean default false)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.players := public.my_player(p_game);
  b text := btrim(coalesce(p_body, ''));
  st text := public.game_status(p_game);
begin
  if char_length(b) < 1 then raise exception 'Leere Nachricht.'; end if;
  if char_length(b) > 500 then raise exception 'Nachricht zu lang (max. 500 Zeichen).'; end if;
  if p_channel not in ('all', 'hunters', 'hiders') then raise exception 'Unbekannter Kanal.'; end if;
  if p_channel <> 'all' and (st = 'ended' or p_channel <> me.role || 's') then
    raise exception 'Kein Zugriff auf diesen Kanal.' using errcode = '42501';
  end if;
  if (select count(*) from public.messages where player_id = me.id and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Zu viele Nachrichten. Warte kurz.';
  end if;
  insert into public.messages (game_id, player_id, sender_name, channel, kind, body)
  values (p_game, me.id, me.name, p_channel,
          case when me.is_host and p_channel = 'all' and coalesce(p_announce, false) then 'host' else 'chat' end, b);
end $$;

create or replace function public.use_joker(p_game uuid, p_type text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.players := public.my_player(p_game);
  g public.games;
  pv public.player_private;
  cooldown int;
  last_used timestamptz;
begin
  select * into g from public.games where id = p_game;
  if g.status <> 'running' then raise exception 'Joker gibt es nur im laufenden Spiel.'; end if;
  if me.role <> 'hider' or me.status <> 'active' then raise exception 'Nur aktive Gejagte haben Joker.'; end if;
  if p_type not in ('skip', 'double', 'decoy') then raise exception 'Unbekannter Joker.'; end if;
  if not coalesce((g.settings ->> ('joker_' || p_type))::boolean, false) then raise exception 'Dieser Joker ist ausgeschaltet.'; end if;
  select * into pv from public.player_private where player_id = me.id for update;
  if pv.joker_pending is not null then raise exception 'Für den nächsten Ping ist schon ein Joker aktiv.'; end if;
  cooldown := coalesce((g.settings ->> 'joker_cooldown_s')::int, 900);
  select max(value::text::timestamptz) into last_used
    from jsonb_each_text(pv.joker_used) as t(key, value);
  if last_used is not null and last_used + make_interval(secs => cooldown) > now() then
    raise exception 'Joker wieder verfügbar in % min.', ceil(extract(epoch from (last_used + make_interval(secs => cooldown) - now())) / 60);
  end if;
  update public.player_private
    set joker_pending = p_type, joker_used = joker_used || jsonb_build_object(p_type, now())
  where player_id = me.id;
  return jsonb_build_object('pending', p_type, 'available_again', now() + make_interval(secs => cooldown));
end $$;

create or replace function public.cancel_joker(p_game uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.players := public.my_player(p_game);
begin
  -- Abbrechen gibt den Joker nicht zurück (Abklingzeit bleibt), verhindert aber die Wirkung.
  update public.player_private set joker_pending = null where player_id = me.id;
end $$;

create or replace function public.rematch(p_game uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  old public.games := public.host_game(p_game, array['ended']);
  g public.games;
  r record;
begin
  if old.rematch_id is not null and exists (select 1 from public.games where id = old.rematch_id) then
    return jsonb_build_object('game_id', old.rematch_id, 'code', (select code from public.games where id = old.rematch_id));
  end if;
  insert into public.games (code, host_id, settings, area, exclusions, zone_stages, rematch_of)
  values (public.gen_code(), old.host_id, old.settings, old.area, old.exclusions, old.zone_stages, old.id)
  returning * into g;
  for r in
    select p.* from public.players p
    where p.game_id = old.id and p.status <> 'left'
      and not exists (
        select 1 from public.players q join public.games x on x.id = q.game_id
        where q.user_id = p.user_id and q.status <> 'left' and x.status in ('lobby', 'running', 'paused') and x.id <> g.id)
    order by p.joined_at
  loop
    perform public.add_player(g.id, r.user_id, r.name,
      case r.role when 'hunter' then 'hider' when 'hider' then 'hunter' else 'random' end, r.is_host);
  end loop;
  update public.games set rematch_id = g.id where id = old.id;
  perform public.post_system(old.id, 'Revanche! Neues Spiel mit getauschten Rollen. Code: ' || g.code);
  return jsonb_build_object('game_id', g.id, 'code', g.code);
end $$;

create or replace function public.regenerate_tracker() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := public.require_uid();
  t text := public.new_token();
begin
  insert into public.user_trackers (user_id, token) values (uid, t)
  on conflict (user_id) do update set token = excluded.token, last_request_at = null, last_source = null;
  return t;
end $$;

create or replace function public.my_tracker() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := public.require_uid();
  t public.user_trackers;
begin
  perform public.ensure_tracker(uid);
  select * into t from public.user_trackers where user_id = uid;
  return jsonb_build_object('token', t.token, 'last_request_at', t.last_request_at, 'last_source', t.last_source);
end $$;

-- Routen für die Wiederholung nach Spielende (ein Punkt alle 10 s je Spieler).
create or replace function public.get_replay(p_game uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me public.players := public.my_player(p_game);
  g public.games;
begin
  select * into g from public.games where id = p_game;
  if g.status <> 'ended' then raise exception 'Die Wiederholung gibt es erst nach dem Spiel.'; end if;
  return jsonb_build_object(
    'started_at', g.started_at, 'hunt_starts_at', g.hunt_starts_at, 'ended_at', g.ended_at,
    'tracks', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', t.player_id, 'points', t.points))
      from (
        select d.player_id, jsonb_agg(jsonb_build_array(round(d.lon::numeric, 6), round(d.lat::numeric, 6), public.ms(d.recorded_at)) order by d.recorded_at) as points
        from (
          select distinct on (l.player_id, floor(extract(epoch from l.recorded_at) / 10))
            l.player_id, coalesce(l.s_lat, l.lat) as lat, coalesce(l.s_lon, l.lon) as lon, l.recorded_at
          from public.locations l
          where l.game_id = p_game
            and (g.end_reason is distinct from 'aborted' or l.player_id = me.id
                 or exists (select 1 from public.players q where q.id = l.player_id and q.role = me.role))
          order by l.player_id, floor(extract(epoch from l.recorded_at) / 10), l.recorded_at
        ) d
        group by d.player_id
      ) t), '[]'::jsonb),
    'decoys', coalesce((select jsonb_agg(s.ping_id) from public.ping_secrets s where s.game_id = p_game and s.is_decoy), '[]'::jsonb)
  );
end $$;

-- ---------- Server-Funktionen (nur Edge Functions mit Secret Key) ----------

-- Spiele mit fälliger Arbeit (Ping, Ende, Zone, Strafe, Jagdbeginn).
create or replace function public.due_game_ids(p_user uuid default null) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select g.id from public.games g
  where g.status = 'running'
    and (p_user is null or exists (select 1 from public.players p where p.game_id = g.id and p.user_id = p_user and p.status <> 'left'))
    and (
      now() >= g.ends_at
      or (now() >= g.hunt_starts_at and not g.hunt_announced)
      or now() >= g.next_ping_at
      or (jsonb_array_length(g.zone_stages) > g.zone_index + 1
          and now() >= g.hunt_starts_at + make_interval(secs => (g.zone_stages -> (g.zone_index + 1) ->> 'at_s')::int))
      or exists (
        select 1 from public.player_private pp join public.players p on p.id = pp.player_id
        where p.game_id = g.id and p.role = 'hider' and p.status = 'active' and pp.oob_deadline <= now())
    )
$$;

create or replace function public.has_due_work() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.due_game_ids(null))
$$;

create or replace function public.game_ctx(p_game uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'game', jsonb_build_object(
      'id', g.id, 'status', g.status, 'settings', g.settings, 'area', g.area, 'exclusions', g.exclusions,
      'zone_stages', g.zone_stages, 'zone_index', g.zone_index, 'ping_seq', g.ping_seq,
      'hunt_announced', g.hunt_announced, 'started_at', public.ms(g.started_at),
      'hunt_starts_at', public.ms(g.hunt_starts_at), 'ends_at', public.ms(g.ends_at),
      'next_ping_at', public.ms(g.next_ping_at)),
    'players', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'status', p.status))
                         from public.players p where p.game_id = g.id), '[]'::jsonb),
    'privs', coalesce((select jsonb_object_agg(pp.player_id, jsonb_build_object(
                         'kf_lat', pp.kf_lat, 'kf_lon', pp.kf_lon, 'kf_var', pp.kf_var, 'kf_at', public.ms(pp.kf_at),
                         'kf_rejects', pp.kf_rejects, 'oob_since', public.ms(pp.oob_since),
                         'oob_deadline', public.ms(pp.oob_deadline), 'joker_pending', pp.joker_pending))
                       from public.player_private pp where pp.game_id = g.id), '{}'::jsonb))
  from public.games g where g.id = p_game
$$;

create or replace function public.svc_due_games(p_user uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.game_ctx(id)), '[]'::jsonb) from public.due_game_ids(p_user) as id
$$;

create or replace function public.svc_insert_ping(p_game uuid, r jsonb) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id bigint;
  v_hider uuid := (r ->> 'hider_id')::uuid;
begin
  if not exists (select 1 from public.players where id = v_hider and game_id = p_game) then return null; end if;
  insert into public.pings (game_id, seq, hider_id, recipient_id, kind, mode, lat, lon, radius_m, ref_lat, ref_lon,
    ref_is_center, bearing_deg, sector_deg, distance_m, dir_label, age_s, no_signal, joker)
  values (p_game, (r ->> 'seq')::int, v_hider, nullif(r ->> 'recipient_id', '')::uuid, r ->> 'kind',
    coalesce(r ->> 'mode', 'none'), (r ->> 'lat')::double precision, (r ->> 'lon')::double precision,
    (r ->> 'radius_m')::real, (r ->> 'ref_lat')::double precision, (r ->> 'ref_lon')::double precision,
    (r ->> 'ref_is_center')::boolean, (r ->> 'bearing_deg')::real, (r ->> 'sector_deg')::real,
    (r ->> 'distance_m')::real, r ->> 'dir_label', (r ->> 'age_s')::int,
    coalesce((r ->> 'no_signal')::boolean, false), r ->> 'joker')
  returning id into v_id;
  if coalesce((r ->> 'decoy')::boolean, false) then
    insert into public.ping_secrets (ping_id, game_id, hider_id, is_decoy) values (v_id, p_game, v_hider, true);
  end if;
  return v_id;
end $$;

-- Wendet einen von planTick() berechneten Plan an. Prüft alles nochmal, damit doppelte
-- oder verspätete Aufrufe nichts kaputt machen.
create or replace function public.svc_apply_tick(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.games;
  v_regular boolean := false;
  r jsonb;
  pen jsonb;
  pl public.players;
  pv public.player_private;
  idx int;
  n_pings int := 0;
  total int;
begin
  select * into g from public.games where id = (p ->> 'game_id')::uuid for update;
  if not found or g.status <> 'running' then return jsonb_build_object('skipped', true); end if;

  if jsonb_typeof(p -> 'end') = 'object' then
    if now() >= g.ends_at or p -> 'end' ->> 'reason' <> 'time' then
      perform public.finish_game(g.id, p -> 'end' ->> 'winner', p -> 'end' ->> 'reason');
      return jsonb_build_object('ended', true);
    end if;
  end if;

  if coalesce((p ->> 'announce_hunt')::boolean, false) and not g.hunt_announced and now() >= g.hunt_starts_at then
    update public.games set hunt_announced = true where id = g.id;
    perform public.post_system(g.id, 'Der Vorsprung ist vorbei. Die Jagd beginnt!');
  end if;

  idx := (p ->> 'zone_index')::int;
  if idx is not null and idx > g.zone_index and idx < jsonb_array_length(g.zone_stages) then
    update public.games set zone_index = idx where id = g.id;
    total := jsonb_array_length(g.zone_stages) - 1;
    perform public.post_system(g.id, 'Die Zone ist geschrumpft (Stufe ' || idx || ' von ' || total || ').');
  end if;

  if (p ->> 'new_seq') is not null and g.ping_seq = (p ->> 'expected_seq')::int and now() >= g.next_ping_at then
    v_regular := true;
    update public.games set ping_seq = (p ->> 'new_seq')::int, next_ping_at = public.ts((p ->> 'next_ping_at')::bigint)
    where id = g.id;
  end if;

  for pen in select * from jsonb_array_elements(coalesce(p -> 'penalties', '[]'::jsonb)) loop
    select * into pl from public.players where id = (pen ->> 'player_id')::uuid and game_id = g.id;
    if not found or pl.role <> 'hider' or pl.status <> 'active' then continue; end if;
    select * into pv from public.player_private where player_id = pl.id for update;
    if pv.oob_deadline is null or pv.oob_deadline > now() then continue; end if;
    if pen ->> 'type' = 'eliminate' then
      update public.players set status = 'eliminated' where id = pl.id;
      update public.player_private set oob_since = null, oob_deadline = null, joker_pending = null where player_id = pl.id;
      perform public.post_system(g.id, pl.name || ' war zu lange außerhalb des Spielgebiets und ist ausgeschieden.');
    else
      update public.player_private set oob_deadline = public.ts((pen ->> 'oob_deadline')::bigint) where player_id = pl.id;
      for r in select * from jsonb_array_elements(coalesce(p -> 'pings', '[]'::jsonb)) loop
        if r ->> 'kind' = 'penalty' and (r ->> 'hider_id')::uuid = pl.id then
          perform public.svc_insert_ping(g.id, r);
          n_pings := n_pings + 1;
        end if;
      end loop;
      perform public.post_system(g.id, pl.name || ' war zu lange außerhalb. Extra-Ping für die Sucher!');
    end if;
  end loop;

  if v_regular then
    for r in select * from jsonb_array_elements(coalesce(p -> 'pings', '[]'::jsonb)) loop
      if r ->> 'kind' in ('regular', 'joker_skip')
         and exists (select 1 from public.players where id = (r ->> 'hider_id')::uuid and game_id = g.id and status = 'active') then
        perform public.svc_insert_ping(g.id, r);
        n_pings := n_pings + 1;
      end if;
    end loop;
    update public.player_private set joker_pending = null
    where game_id = g.id and player_id in (select (jsonb_array_elements_text(coalesce(p -> 'consumed_jokers', '[]'::jsonb)))::uuid);
  end if;

  perform public.finish_if_done(g.id);
  return jsonb_build_object('regular', v_regular, 'pings', n_pings);
end $$;

-- Tracker-Token prüfen (mit Rate-Limit 1 Anfrage/Sekunde) und Spielkontext liefern.
create or replace function public.svc_location_context(p_token text, p_source text default 'traccar') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid;
  pl public.players;
  g public.games;
  ctx jsonb;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then
    return jsonb_build_object('ok', false, 'reason', 'token');
  end if;
  update public.user_trackers
    set last_request_at = now(), last_source = case when p_source = 'web' then 'web' else 'traccar' end
  where token = p_token and (last_request_at is null or last_request_at < now() - interval '1 second')
  returning user_id into uid;
  if uid is null then
    if exists (select 1 from public.user_trackers where token = p_token) then
      return jsonb_build_object('ok', false, 'reason', 'rate');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'token');
  end if;
  select p.* into pl from public.players p join public.games x on x.id = p.game_id
  where p.user_id = uid and p.status <> 'left' and x.status in ('lobby', 'running', 'paused')
  order by (x.status in ('running', 'paused')) desc, p.joined_at desc limit 1;
  if not found then return jsonb_build_object('ok', true, 'active', false); end if;
  select * into g from public.games where id = pl.game_id;
  ctx := public.game_ctx(g.id);
  return jsonb_build_object(
    'ok', true, 'active', true,
    'player', jsonb_build_object('id', pl.id, 'name', pl.name, 'role', pl.role, 'status', pl.status),
    'game', ctx -> 'game',
    'priv', ctx -> 'privs' -> (pl.id::text));
end $$;

-- Speichert das Ergebnis von processLocation().
create or replace function public.svc_store_location(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  pl public.players;
  g_status text;
  src text := case when p ->> 'source' = 'web' then 'web' else 'traccar' end;
  loc jsonb := p -> 'location';
  kf jsonb := p -> 'kf';
  b jsonb := p -> 'boundary';
  o jsonb := p -> 'oob';
begin
  select * into pl from public.players where id = (p ->> 'player_id')::uuid;
  if not found or pl.status = 'left' then return jsonb_build_object('ok', false); end if;
  -- "Letztes Signal" höchstens alle 20 s schreiben (spart Realtime-Nachrichten)
  update public.players set
    last_signal_at = now(),
    last_traccar_at = case when src = 'traccar' then now() else last_traccar_at end,
    last_web_at = case when src = 'web' then now() else last_web_at end
  where id = pl.id and (
    last_signal_at is null or last_signal_at < now() - interval '20 seconds'
    or (src = 'traccar' and (last_traccar_at is null or last_traccar_at < now() - interval '20 seconds'))
    or (src = 'web' and (last_web_at is null or last_web_at < now() - interval '20 seconds')));
  g_status := public.game_status(pl.game_id);
  if g_status <> 'running' or coalesce((p ->> 'signal_only')::boolean, false) then
    return jsonb_build_object('ok', true, 'stored', false);
  end if;
  if jsonb_typeof(kf) = 'object' then
    update public.player_private set
      kf_lat = (kf ->> 'lat')::double precision, kf_lon = (kf ->> 'lon')::double precision,
      kf_var = (kf ->> 'var')::double precision, kf_at = public.ts((kf ->> 'at')::bigint),
      kf_rejects = coalesce((kf ->> 'rejects')::int, 0)
    where player_id = pl.id;
  end if;
  if not coalesce((p ->> 'accepted')::boolean, false) or jsonb_typeof(loc) <> 'object' then
    return jsonb_build_object('ok', true, 'stored', false);
  end if;
  insert into public.locations (game_id, player_id, lat, lon, s_lat, s_lon, accuracy, source, recorded_at)
  values (pl.game_id, pl.id, (loc ->> 'lat')::double precision, (loc ->> 'lon')::double precision,
          (loc ->> 's_lat')::double precision, (loc ->> 's_lon')::double precision, (loc ->> 'accuracy')::real,
          src, public.ts((loc ->> 'recorded_at')::bigint));
  update public.player_private set
    last_accuracy = (loc ->> 'accuracy')::real,
    inside = (b ->> 'inside')::boolean,
    edge_dist_m = (b ->> 'edge_dist_m')::real,
    violation = b ->> 'violation',
    violation_name = b ->> 'exclusion',
    oob_since = case when pl.status = 'active' then public.ts((o ->> 'since')::bigint) end,
    oob_deadline = case when pl.status = 'active' and pl.role = 'hider' then public.ts((o ->> 'deadline')::bigint) end
  where player_id = pl.id;
  return jsonb_build_object('ok', true, 'stored', true);
end $$;

-- Löscht abgelaufene Spiele samt Standorten, Pings und Chat (läuft stündlich per Cron).
create or replace function public.purge_expired() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  delete from public.games
  where (status = 'ended' and purge_at < now())
     or (status = 'lobby' and created_at < now() - interval '24 hours')
     or (status in ('running', 'paused') and coalesce(ends_at, created_at) < now() - interval '24 hours');
  get diagnostics n = row_count;
  delete from public.saved_areas s where s.created_at < now() - interval '365 days';
  return n;
end $$;

-- Löscht alle Daten des eigenen Kontos: Spieler, Standorte, Pings, gespeicherte Gebiete, Tracker-Kennung.
create or replace function public.delete_my_data() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare uid uuid := public.require_uid();
begin
  perform public.leave_other_games(uid);
  update public.messages set sender_name = 'Gelöscht'
    where player_id in (select id from public.players where user_id = uid);
  delete from public.players where user_id = uid;
  delete from public.saved_areas where owner_id = uid;
  delete from public.user_trackers where user_id = uid;
end $$;

-- ---------- Ausführungsrechte ----------

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.ms(timestamptz), public.ts(bigint),
  public.member_player_id(uuid), public.game_status(uuid), public.can_see_location(uuid, uuid),
  public.can_see_ping(uuid, uuid, uuid), public.can_see_message(uuid, text),
  public.create_game(text), public.join_game(text, text), public.rename_me(uuid, text),
  public.update_game(uuid, jsonb), public.set_role(uuid, text), public.set_player_role(uuid, text),
  public.set_ready(uuid, boolean), public.kick_player(uuid), public.start_game(uuid), public.mark_found(uuid),
  public.pause_game(uuid, text), public.resume_game(uuid), public.end_game(uuid), public.leave_game(uuid),
  public.send_message(uuid, text, text, boolean), public.use_joker(uuid, text), public.cancel_joker(uuid),
  public.rematch(uuid), public.regenerate_tracker(), public.my_tracker(), public.get_replay(uuid), public.delete_my_data()
to authenticated;

grant execute on all functions in schema public to service_role;

-- ---------- Realtime ----------
-- Änderungen an diesen Tabellen werden live an die Apps geschickt (gefiltert per RLS).
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['games', 'players', 'player_private', 'pings', 'messages', 'locations'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
