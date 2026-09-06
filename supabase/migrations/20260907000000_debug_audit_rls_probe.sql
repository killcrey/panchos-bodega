-- Throwaway — audits every public-schema table for the exact failure mode
-- just found on email_captures (RLS enabled, zero policies = silently
-- returns nothing to anon/authenticated, with no error). Dropped after use.
create or replace function public.debug_audit_rls()
returns table (
  table_name text,
  rls_enabled boolean,
  policy_count bigint
)
language sql
security definer
set search_path = public
as $$
  select
    c.relname::text as table_name,
    c.relrowsecurity as rls_enabled,
    count(p.policyname) as policy_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
  where n.nspname = 'public' and c.relkind = 'r'
  group by c.relname, c.relrowsecurity
  order by c.relname;
$$;
