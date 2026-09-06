-- Throwaway — lets a debug edge function confirm the cron job scheduled in
-- the previous migration actually registered. Dropped immediately after use.
create or replace function public.debug_list_cron_jobs()
returns setof cron.job
language sql
security definer
set search_path = cron, public
as $$
  select * from cron.job;
$$;
