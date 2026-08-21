create or replace function public.debug_whoami()
returns jsonb
language sql
security invoker
as $$
  select jsonb_build_object(
    'current_user', current_user,
    'session_user', session_user,
    'jwt_role', current_setting('request.jwt.claim.role', true),
    'jwt_claims', current_setting('request.jwt.claims', true),
    'anon_is_member_of_authenticated', pg_has_role('anon', 'authenticated', 'member'),
    'visible_unpublished_count', (select count(*) from public.products where published = false)
  );
$$;
