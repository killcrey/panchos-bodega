-- Throwaway follow-up to debug_audit_rls — that one only counted policies
-- per table; order_items having exactly 1 doesn't prove it's a *correct*
-- one (e.g. `to authenticated using (true)`, matching orders/tips) rather
-- than something narrower that still blocks reads. This returns the actual
-- policy definitions. Dropped after use.
create or replace function public.debug_audit_rls_detail()
returns table (
  table_name text,
  policy_name text,
  roles name[],
  cmd text,
  qual text
)
language sql
security definer
set search_path = public
as $$
  select p.tablename, p.policyname, p.roles, p.cmd, p.qual
  from pg_policies p
  where p.schemaname = 'public'
  order by p.tablename;
$$;
