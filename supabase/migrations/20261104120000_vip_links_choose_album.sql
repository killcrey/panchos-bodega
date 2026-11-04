-- VIP folder links can now be made for more than one album (Memories Of Home and
-- Layers). The admin picks the album when making a link, so `product_slug` joins
-- the columns an admin may set on insert.
--
-- It stays locked down: a CHECK limits it to the albums the band actually hands
-- out, so a link can never be pointed at some other (e.g. paid or unreleased)
-- product's files — adding a third album means adding its slug here on purpose.
alter table public.vip_links
  add constraint vip_links_product_slug_allowed
  check (product_slug in ('memories-of-home', 'the-invisible-panchos-layers-download'));

grant insert (product_slug) on public.vip_links to authenticated;
