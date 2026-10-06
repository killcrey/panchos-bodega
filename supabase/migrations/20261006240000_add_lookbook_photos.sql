-- Look Book / ad photos for the scrolling strip on the landing page's Featured
-- panel. One shared set (not per product), capped at 4 by the admin code —
-- adding a 5th drops the oldest. `source` = 'upload' (a file uploaded to
-- bodega-images for this strip, safe to delete from storage with the row) or
-- 'product' (points at an existing product photo — only the row may ever be
-- deleted, never the storage object, which the product still uses).
create table if not exists public.lookbook_photos (
  id uuid primary key default gen_random_uuid(),
  image_url text not null,
  source text not null default 'upload' check (source in ('upload', 'product')),
  created_at timestamptz not null default now()
);

alter table public.lookbook_photos enable row level security;

-- Public read (it's shown to every storefront visitor); only the logged-in
-- admin can change it.
create policy "Anyone can read lookbook photos"
  on public.lookbook_photos
  for select
  to anon, authenticated
  using (true);

create policy "Admins can manage lookbook photos"
  on public.lookbook_photos
  for all
  to authenticated
  using (true)
  with check (true);

grant select on public.lookbook_photos to anon;
grant select, insert, update, delete on public.lookbook_photos to authenticated;

create index if not exists lookbook_photos_created_at_idx on public.lookbook_photos (created_at);
