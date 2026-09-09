-- Service bookings (perform, DJ, teach, build sites, etc.) reuse the
-- existing products table with category = 'services' — the storefront
-- already had a "Services" filter tab and upload-category option with no
-- behavior wired to them. What a service can't reuse is checkout: real
-- pricing depends on details (date, venue, scope) a cart can't collect, so
-- a service card requests a quote instead of buying. This table is where
-- that request lands.
create table if not exists public.service_inquiries (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  -- Snapshotted at submit time so an inquiry stays readable even if the
  -- service listing is later renamed or deleted.
  product_title text,
  name text not null,
  email text not null,
  event_date date,
  budget text,
  message text,
  status text not null default 'new',
  created_at timestamptz not null default now()
);

-- Same posture as tips/orders: carries a real person's contact info, so no
-- public access at all. The admin (authenticated) reads and updates status;
-- the edge function inserts with the service role key, which bypasses RLS.
alter table public.service_inquiries enable row level security;

create policy "Admins can manage service inquiries"
  on public.service_inquiries
  for all
  to authenticated
  using (true)
  with check (true);

create index if not exists service_inquiries_created_at_idx on public.service_inquiries (created_at desc);
