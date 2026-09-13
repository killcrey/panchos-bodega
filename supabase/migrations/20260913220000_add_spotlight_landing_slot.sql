-- Spotlight (main.js's MULTI_SLOT_CAPS.spotlight, capped at 4 the same way
-- 'featured' is capped at 6) was added to the admin dropdown and storefront
-- rendering, but this check constraint was missed — every attempt to save
-- landing_slot = 'spotlight' failed with "violates check constraint
-- products_landing_slot_check" instead of saving. Widening it to match.
alter table public.products
  drop constraint if exists products_landing_slot_check;

alter table public.products
  add constraint products_landing_slot_check
  check (landing_slot is null or landing_slot in ('featured', 'latest_release', 'pancho_pick', 'spotlight'));
