-- The admin can now rename a VIP link (admin "VIP Links" tab). The label is the
-- event name shown in the admin list and on the link's preview card.
grant update (label) on public.vip_links to authenticated;
