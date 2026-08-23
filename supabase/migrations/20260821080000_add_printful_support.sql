-- Printful is a third fulfillment path alongside digital downloads and
-- self-shipped physical items (weight_oz). A Printful product maps each of
-- its sizes to a {variantId, syncVariantId} pair: variantId is Printful's
-- catalog variant (required by their shipping-rate quote API), syncVariantId
-- is the store's synced product variant (required by their order-submission
-- API, and tied to the actual uploaded artwork — designed in the Printful
-- dashboard, not here). They're different endpoints requiring different ids,
-- confirmed against the live Printful API rather than assumed. Sizeless
-- Printful products use the single key "default". Presence of this column
-- being non-null is what marks a product as Printful-fulfilled.
alter table public.products
  add column if not exists printful_variant_map jsonb;

-- Printful's own order id, so a Printful-fulfilled order can be looked up /
-- reconciled in the Printful dashboard after the webhook submits it.
-- printful_order_status mirrors label_status ('pending' | 'submitted' |
-- 'failed') so a submission failure is visible to the admin instead of the
-- order silently never reaching Printful.
alter table public.orders
  add column if not exists printful_order_id bigint,
  add column if not exists printful_order_status text,
  add column if not exists printful_order_error text;

-- Audit trail: which Printful sync variant (order-submission id, not the
-- catalog variantId) an order_items row actually resolved to at purchase time.
alter table public.order_items
  add column if not exists printful_sync_variant_id bigint;
