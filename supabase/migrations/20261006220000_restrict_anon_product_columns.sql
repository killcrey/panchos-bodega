-- The storefront only ever needs the columns listed below, but the public anon
-- key could previously read EVERY column of products via the REST API,
-- including stripe_url (a permanently price-frozen Stripe Payment Link) and
-- stripe_product_id. Row-level security can't hide individual columns, so
-- this switches anon from a table-wide SELECT to an explicit column list.
--
-- The logged-in admin (role "authenticated") and edge functions
-- (service_role) keep their full table access — only anon is narrowed.
--
-- IMPORTANT: any NEW products column the public storefront needs must also be
-- added to this grant (and to the select list in src/main.js), or anon
-- queries asking for it will fail with "permission denied".
revoke select on public.products from anon;

grant select (
  id, title, type, price_cents, cover_art_url, image_2_url, image_3_url,
  gallery_images, description, sizes, audio_preview_url, tracklist_snippets,
  download_files, category, published, coming_soon, inventory_count, weight_oz,
  domestic_shipping_cents, international_shipping_cents, printful_variant_map,
  landing_slot, slug, pricing_mode, offer_min_cents, offer_max_cents, created_at
) on public.products to anon;
