-- Per-product URL slug, needed for real per-product SEO (see prerender
-- build step) — a single-page app with one URL can't be individually
-- indexed by Google no matter how good its meta tags are.
alter table public.products add column if not exists slug text;

-- Backfill existing rows from title before the uniqueness constraint below.
update public.products
set slug = trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'))
where slug is null;

-- Resolve collisions (e.g. two products both titled "Tee") by suffixing the
-- row's own id on every occurrence after the first.
with dupes as (
  select id, slug, row_number() over (partition by slug order by created_at) as rn
  from public.products
)
update public.products p
set slug = p.slug || '-' || substr(p.id::text, 1, 6)
from dupes d
where p.id = d.id and d.rn > 1;

alter table public.products
  drop constraint if exists products_slug_unique;
alter table public.products
  add constraint products_slug_unique unique (slug);
