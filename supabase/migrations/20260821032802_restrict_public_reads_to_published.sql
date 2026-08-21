-- "Public catalog access" let anyone read every row via the REST API,
-- unpublished drafts included, even though the storefront itself only ever
-- queries .eq('published', true). Replace it with a read policy scoped to
-- published rows for public/anon access — authenticated (admin) reads are
-- unaffected, already covered separately by "Admin Full Access" (cmd *).
drop policy if exists "Public catalog access" on public.products;

create policy "Public can read published products"
  on public.products
  for select
  to anon, authenticated
  using (published = true);
