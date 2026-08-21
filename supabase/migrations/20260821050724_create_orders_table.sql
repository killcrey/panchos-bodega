-- Orders placed through the live Shippo apparel checkout. Populated by the
-- Stripe webhook when payment succeeds; the shipping label is purchased
-- automatically at the same time (or retried later from the admin panel).
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  stripe_session_id text not null unique,
  product_id uuid references public.products(id) on delete set null,
  product_title text not null,
  size text,
  weight_oz numeric,
  amount_total_cents integer,
  customer_email text,
  shipping_name text,
  shipping_street1 text,
  shipping_street2 text,
  shipping_city text,
  shipping_state text,
  shipping_zip text,
  shipping_country text,
  shipping_service text,
  shipping_rate_id text,
  label_status text not null default 'pending',
  label_error text,
  label_url text,
  tracking_number text,
  tracking_url text,
  fulfilled_at timestamptz
);

-- Orders contain customer PII (name, address, email) — no public access at
-- all, unlike products. Only the admin (authenticated) can read/write, and
-- the webhook inserts using the service role key, which bypasses RLS.
alter table public.orders enable row level security;

create policy "Admins can manage orders"
  on public.orders
  for all
  to authenticated
  using (true)
  with check (true);
