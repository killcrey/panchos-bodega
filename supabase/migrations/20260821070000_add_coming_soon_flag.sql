-- Lets a product stay visible on the storefront (title, price, photos,
-- description) while its buy button is disabled and reads "Coming Soon" —
-- distinct from `published`, which hides a product entirely.
alter table public.products
  add column if not exists coming_soon boolean not null default false;
