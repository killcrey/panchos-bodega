-- The admin can now change a VIP link's close date (admin "VIP Links" tab).
-- Until now only `revoked` was updatable; `token` stays insert-by-default only,
-- so a logged-in user still cannot choose or alter a link's secret.
grant update (expires_at) on public.vip_links to authenticated;
