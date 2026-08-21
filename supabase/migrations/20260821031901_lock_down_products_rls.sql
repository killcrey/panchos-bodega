-- The products table had no Row Level Security, so the public anon key
-- (embedded in the client bundle, visible to anyone) could insert, update,
-- or delete products directly, bypassing the admin login entirely. Writes
-- were only ever gated by the admin UI, not the database.
--
-- This locks it down to match how the app actually uses the table:
--   - The storefront already queries with .eq('published', true) — public
--     read access is scoped to that, so it's enforced by the database too,
--     not just by the client-side query.
--   - The admin panel's inventory list queries all rows with no filter, and
--     only runs after supabase.auth.signInWithPassword succeeds — so
--     authenticated (logged-in admin) read access covers everything.
--   - There is no public sign-up flow anywhere in this app, so "authenticated"
--     can only ever mean a logged-in admin.
--   - All writes (insert/update/delete) now require being authenticated.
--   - Edge Functions (secure-download, free-download, get-shipping-rates,
--     create-checkout-session, stripe-webhook) use the service role key,
--     which bypasses RLS entirely, so none of them are affected.

alter table public.products enable row level security;

create policy "Public can read published products"
  on public.products
  for select
  to anon, authenticated
  using (published = true);

create policy "Admins can read all products"
  on public.products
  for select
  to authenticated
  using (true);

create policy "Admins can insert products"
  on public.products
  for insert
  to authenticated
  with check (true);

create policy "Admins can update products"
  on public.products
  for update
  to authenticated
  using (true)
  with check (true);

create policy "Admins can delete products"
  on public.products
  for delete
  to authenticated
  using (true);
