-- Watermark for sync-game-signups: the Game's Supabase project is a
-- separate, unrelated project (vihwbuiobowdreynxmgy.supabase.co) with no
-- backend of its own, so Bodega periodically pulls new rows from its
-- email_signups table and pushes them into the shared Resend Audience.
-- Tracking "how far we've read" here (not in the Game's DB) means this sync
-- never needs write access to that project, only a read-only service key.
create table if not exists public.game_signup_sync_state (
  id boolean primary key default true,
  last_synced_at timestamptz not null default '1970-01-01T00:00:00Z',
  constraint game_signup_sync_state_single_row check (id)
);

insert into public.game_signup_sync_state (id)
values (true)
on conflict (id) do nothing;

-- Written and read only by the sync-game-signups function (service role,
-- bypasses RLS) — no anon/authenticated access needed at all.
alter table public.game_signup_sync_state enable row level security;
