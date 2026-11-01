-- Position of a product in the landing page's Featured carousel (1 = first
-- slide). Nullable: products with no order sort after every ordered one, so
-- nothing changes until the admin sets an order from the Featured Order tab.
alter table public.products add column if not exists featured_order integer;

-- anon only has column-level SELECT on products (see
-- 20261006220000_restrict_anon_product_columns.sql), so a column the public
-- storefront reads has to be granted explicitly.
grant select (featured_order) on public.products to anon;
