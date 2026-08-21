-- Temporary product + order used to verify the fulfillment flow end-to-end
-- (checkout session metadata, label purchase). Deleted in the next migration.
insert into public.products (id, title, price_cents, category, published, weight_oz, stripe_product_id)
values ('11111111-1111-1111-1111-111111111111', 'ZZZ FULFILLMENT TEST DELETE ME', 100, 'apparel', true, 6, 'prod_V5QJjx0sVgncf8');

insert into public.orders (
  stripe_session_id, product_id, product_title, weight_oz, amount_total_cents,
  shipping_name, shipping_street1, shipping_city, shipping_state, shipping_zip, shipping_country,
  shipping_service, label_status
)
values (
  'cs_test_fulfillment_probe', '11111111-1111-1111-1111-111111111111', 'ZZZ FULFILLMENT TEST DELETE ME', 6, 754,
  'Test Buyer', '1600 Pennsylvania Ave NW', 'Washington', 'DC', '20500', 'US',
  'USPS Ground Advantage', 'pending'
);
