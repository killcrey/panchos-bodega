-- Drops the throwaway probe from the previous migration — confirmed the
-- reschedule took effect, no longer needed. See the earlier
-- create/drop pair (20260906093000 / 20260906093500) for why this isn't
-- left callable via PostgREST RPC.
drop function if exists public.debug_list_cron_jobs();
