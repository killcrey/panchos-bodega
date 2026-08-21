-- Orders now come from a multi-item cart checkout instead of one product per
-- session, so a single order can contain several products. order_items holds
-- the per-product breakdown; orders keeps the checkout-level fields (address,
-- totals, label). product_title on orders is no longer populated per-order
-- (the breakdown lives in order_items instead), so it can no longer be
-- required.
alter table public.orders alter column product_title drop not null;

-- orders.weight_oz is repurposed to mean the COMBINED package weight for the
-- whole order (used by purchase-shipping-label to re-quote a rate), not a
-- single product's weight.
comment on column public.orders.weight_oz is 'Combined package weight (oz) for the whole order — used to re-quote a shipping label.';

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_title text not null,
  category text,
  size text,
  quantity integer not null default 1,
  unit_amount_cents integer,
  weight_oz numeric
);

create index order_items_order_id_idx on public.order_items(order_id);

-- Same access rule as orders: no public access, admin (authenticated) only.
-- The webhook inserts using the service role key, which bypasses RLS.
alter table public.order_items enable row level security;

create policy "Admins can manage order items"
  on public.order_items
  for all
  to authenticated
  using (true)
  with check (true);
