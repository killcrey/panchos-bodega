-- Pricing Mode generalizes how a product's price is determined beyond a
-- flat admin-set number. 'standard' (default) preserves every existing
-- product's behavior exactly — services still quote, everything else still
-- checks out at price_cents. The other three are opt-in per product:
--   'free'        — price forced to $0, digital-only (already how a $0
--                    product behaves today; this just makes it an explicit
--                    admin choice instead of an implicit price side-effect).
--   'offer_based' — the buyer names a price within [offer_min_cents,
--                    offer_max_cents] instead of a fixed one. A physical
--                    item still goes through the normal cart/shipping/Stripe
--                    pipeline; a service (no cart entry point at all) uses a
--                    standalone Stripe session instead.
--   'reserve'     — services only (enforced in the UI and in
--                    create-product-payment-session, not in a CHECK
--                    constraint, since "services only" is a product rule,
--                    not a data-shape rule): a fixed $25 non-refundable
--                    deposit toward the final price, via the same
--                    standalone-session path as offer_based-for-services.
alter table public.products add column if not exists pricing_mode text not null default 'standard'
  check (pricing_mode in ('standard', 'free', 'offer_based', 'reserve'));
alter table public.products add column if not exists offer_min_cents integer;
alter table public.products add column if not exists offer_max_cents integer;

-- Reserve and services' offer_based payments never touch the products-cart-
-- Stripe pipeline (no stripe_product_id, no order_items, no shipping) — same
-- reasoning `tips` got its own table instead of overloading `orders`.
create table if not exists public.product_payments (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text not null unique,
  product_id uuid references public.products(id) on delete set null,
  product_title text,
  pricing_mode text not null,
  amount_cents integer not null check (amount_cents > 0),
  email text,
  name text,
  created_at timestamptz not null default now()
);

-- Same posture as tips/orders/service_inquiries: carries a real person's
-- contact info, so no public access — admin (authenticated) reads it, the
-- webhook inserts with the service role key, which bypasses RLS.
alter table public.product_payments enable row level security;

create policy "Admins can manage product payments"
  on public.product_payments
  for all
  to authenticated
  using (true)
  with check (true);

create index if not exists product_payments_created_at_idx on public.product_payments (created_at desc);
