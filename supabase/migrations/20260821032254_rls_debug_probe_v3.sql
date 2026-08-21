create or replace function public.debug_whoami()
returns jsonb
language sql
security invoker
as $$
  select jsonb_build_object(
    'current_user', current_user,
    'rowsecurity_enabled', (select relrowsecurity from pg_class where oid = 'public.products'::regclass),
    'force_rowsecurity', (select relforcerowsecurity from pg_class where oid = 'public.products'::regclass),
    'table_owner', (select tableowner from pg_tables where schemaname = 'public' and tablename = 'products'),
    'policies', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', polname,
        'cmd', polcmd,
        'roles', (select array_agg(rolname) from pg_roles where oid = any(polroles)),
        'qual', pg_get_expr(polqual, polrelid),
        'with_check', pg_get_expr(polwithcheck, polrelid)
      )), '[]'::jsonb)
      from pg_policy where polrelid = 'public.products'::regclass
    ),
    'visible_unpublished_count', (select count(*) from public.products where published = false)
  );
$$;
