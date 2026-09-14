-- Security-audit fix (AUDIT.md, Pass 1 "Event coverage"): stripe-webhook
-- only ever handled checkout.session.completed/async_payment_succeeded — a
-- refund issued from the Stripe Dashboard, or a dispute/chargeback, had
-- zero effect anywhere in Supabase. Adding tracking columns to every table
-- that can represent a real charge (a refund/dispute can land on a cart
-- order, a tip, or a service payment alike).
alter table public.orders
  add column if not exists refund_status text,
  add column if not exists refunded_amount_cents integer,
  add column if not exists dispute_status text;

alter table public.tips
  add column if not exists refund_status text,
  add column if not exists refunded_amount_cents integer,
  add column if not exists dispute_status text;

alter table public.product_payments
  add column if not exists refund_status text,
  add column if not exists refunded_amount_cents integer,
  add column if not exists dispute_status text;
