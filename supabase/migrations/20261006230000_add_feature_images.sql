-- Extra photos shown in the scrolling strip under a product's description in
-- the landing page's Featured detail panel. Edited from the admin's Edit window.
alter table public.products add column if not exists feature_images jsonb;

-- anon only has column-level SELECT on products (see
-- 20261006220000_restrict_anon_product_columns.sql), so a new column the
-- storefront reads has to be granted explicitly.
grant select (feature_images) on public.products to anon;
