-- Throwaway — confirms the reschedule in the previous migration took effect
-- (old job gone, new one active with the right schedule). Dropped after use.
create or replace function public.debug_list_cron_jobs()
returns setof cron.job
language sql
security definer
set search_path = cron, public
as $$
  select * from cron.job;
$$;
