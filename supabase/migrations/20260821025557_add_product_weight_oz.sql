-- Package weight (ounces) for apparel products, used to request live
-- Shippo shipping rates instead of a flat admin-set shipping cost.
alter table public.products
  add column if not exists weight_oz numeric;
