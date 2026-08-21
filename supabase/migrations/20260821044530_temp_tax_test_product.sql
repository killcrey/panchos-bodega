-- Temporary product to verify automatic_tax works end-to-end against the
-- live Stripe/Shippo functions now that RLS blocks anon writes for this
-- kind of ad hoc testing. Deleted in the very next migration.
insert into public.products (title, price_cents, category, published, weight_oz, stripe_product_id)
values ('ZZZ TAX TEST DELETE ME', 100, 'apparel', true, 6, 'prod_V5QJjx0sVgncf8');
