-- 30-second plays: one row each time a visitor has actually listened to a song
-- for 30+ seconds (the same bar streaming services use). Written only by the
-- log-play edge function (service role); only the admin can read it.
-- listener_id is a random id the visitor's browser makes for itself - no email,
-- no IP - so "unique listeners" can be counted without knowing who anyone is.
create table if not exists public.track_plays (
  id bigint generated always as identity primary key,
  played_at timestamptz not null default now(),
  product_slug text not null,
  track_slug text not null default '',
  track_name text not null default '',
  album text not null default '',
  -- 'site' = played on the store, 'shared' = played from a shared song link, 'vip' = the VIP folder page
  source text not null default 'site',
  listener_id text not null
);

create index if not exists track_plays_played_at_idx on public.track_plays (played_at desc);
create index if not exists track_plays_track_idx on public.track_plays (product_slug, track_slug);
create index if not exists track_plays_listener_idx on public.track_plays (listener_id, played_at desc);

alter table public.track_plays enable row level security;

create policy "Admins can read track plays"
  on public.track_plays
  for select
  to authenticated
  using (true);

-- Read-only for the admin; nothing public. Inserts come from the service role.
revoke all on public.track_plays from anon, authenticated;
grant select on public.track_plays to authenticated;

-- What the admin "Plays" tab reads: totals per song and overall. security_invoker
-- makes the views obey the table's own access rules (admin only), not the
-- view owner's.
create or replace view public.track_play_stats with (security_invoker = true) as
select
  product_slug,
  track_slug,
  max(track_name) as track_name,
  max(album) as album,
  count(*) as plays,
  count(distinct listener_id) as listeners,
  count(*) filter (where played_at > now() - interval '7 days') as plays_7d,
  count(distinct listener_id) filter (where played_at > now() - interval '7 days') as listeners_7d,
  count(*) filter (where source = 'shared') as shared_plays,
  count(*) filter (where source = 'vip') as vip_plays
from public.track_plays
group by product_slug, track_slug;

create or replace view public.track_play_totals with (security_invoker = true) as
select
  count(*) as plays,
  count(distinct listener_id) as listeners,
  count(*) filter (where played_at > now() - interval '7 days') as plays_7d,
  count(distinct listener_id) filter (where played_at > now() - interval '7 days') as listeners_7d
from public.track_plays;

revoke all on public.track_play_stats, public.track_play_totals from anon, authenticated;
grant select on public.track_play_stats, public.track_play_totals to authenticated;
