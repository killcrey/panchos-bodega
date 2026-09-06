-- Drops the throwaway SECURITY DEFINER probe from the previous migration —
-- confirmed the cron job registered, no longer needed, and shouldn't be
-- left callable via PostgREST RPC (it exposes cron.job to anyone who can
-- call it under default grants).
drop function if exists public.debug_list_cron_jobs();
