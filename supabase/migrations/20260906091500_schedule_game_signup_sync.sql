-- Runs sync-game-signups on a schedule via pg_net, since the Game's static
-- site has no backend of its own to push signups from in real time.
--
-- The anon key below is deliberately not a secret (same key already shipped
-- in the client bundle and committed in this repo's .env) — it only clears
-- the platform gateway's "is this a request for this project" check. The
-- function itself (verify_jwt = false, like create-checkout-session and
-- friends) does no further per-caller authentication because there is
-- nothing sensitive to protect here: worst case of an extra/early
-- invocation is a marketing-email sync running a bit more often than
-- scheduled, not any data exposure or mutation of consequence.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'sync-game-signups-every-30-min',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://defanfglngsszhyurpfn.supabase.co/functions/v1/sync-game-signups',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_LVLozou99ZqeoTOxU7pdLQ_JaXPQr-4',
      'Authorization', 'Bearer sb_publishable_LVLozou99ZqeoTOxU7pdLQ_JaXPQr-4'
    ),
    body := '{}'::jsonb
  );
  $$
);
