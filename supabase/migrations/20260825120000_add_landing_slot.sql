-- Drives the landing page a visitor sees right after the Enter gate.
-- One column instead of three booleans keeps the slots mutually exclusive
-- for free: a product occupies at most one spot on that page.
--   'featured'       -> auto-scrolling carousel (up to 3, capped in the admin form)
--   'latest_release' -> top-right box (exactly one)
--   'pancho_pick'    -> bottom-right box (exactly one)
--   null             -> not on the landing page
alter table public.products
  add column if not exists landing_slot text;

alter table public.products
  drop constraint if exists products_landing_slot_check;

alter table public.products
  add constraint products_landing_slot_check
  check (landing_slot is null or landing_slot in ('featured', 'latest_release', 'pancho_pick'));

-- The two single-occupancy slots can only ever be held by one product each.
-- 'featured' is deliberately excluded — it holds up to three.
create unique index if not exists products_single_landing_slot_idx
  on public.products (landing_slot)
  where landing_slot in ('latest_release', 'pancho_pick');
