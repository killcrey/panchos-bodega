-- Drops both throwaway audit probes from the previous two migrations —
-- confirmed email_captures was the only RLS gap in the project (order_items,
-- orders, tips, products all correctly policied; game_signup_sync_state's
-- zero policies are intentional, service-role-only by design). Kept as
-- forward migrations rather than rewriting history, per this project's
-- existing convention for throwaway debug probes.
drop function if exists public.debug_audit_rls();
drop function if exists public.debug_audit_rls_detail();
