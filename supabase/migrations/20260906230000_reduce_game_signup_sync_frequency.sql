-- 30 minutes was a conservative default for a marketing-list sync with no
-- real urgency — nothing is blocked waiting on it. Every 3 hours is still
-- same-day and cuts invocation count 6x. Unschedule-then-reschedule under a
-- name that matches the new interval, rather than reusing the old job name
-- with a now-misleading "-every-30-min" suffix.
select cron.unschedule('sync-game-signups-every-30-min');

select cron.schedule(
  'sync-game-signups-every-3-hours',
  '0 */3 * * *',
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
