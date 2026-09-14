-- Security-audit fix (AUDIT.md, Pass 1 CRITICAL + Pass 4 HIGH):
-- stripe-webhook's per-line-item loop (inventory decrement, download-block
-- building) used to run unconditionally on every delivery of
-- checkout.session.completed/async_payment_succeeded, including Stripe's
-- own retries/redeliveries of the identical event — a redelivery decremented
-- real stock a second time for one real sale. The only prior dedup was a
-- racy check-then-insert in front of the `orders` table, which only ever
-- covered cart orders anyway (a static Payment Link purchase never gets an
-- orders row, so it was never protected either).
--
-- This table is inserted into atomically, once, before any fulfillment
-- side effect runs, so a genuine redelivery is detected via the same
-- unique-constraint-violation pattern the tips/product_payments tables
-- already use, instead of re-running anything.
create table if not exists public.processed_webhook_sessions (
  stripe_session_id text primary key,
  processed_at timestamptz not null default now()
);

alter table public.processed_webhook_sessions enable row level security;
-- No policies — service role (the webhook) only, same posture as
-- game_signup_sync_state. Nothing here is meaningful to expose either way.

-- decrement_inventory wasn't in any tracked migration before this (see
-- AUDIT.md Pass 1/2 — its real definition couldn't be verified from the
-- repo at all; running this migration is what first confirmed live that it
-- actually exists, as a function returning void with no idempotency/
-- atomicity guard of its own). Replacing it outright with a known-correct,
-- single-statement conditional UPDATE: the WHERE guard means two
-- concurrent calls against the same product can never both succeed past
-- what's actually in stock, and inventory_count can never go negative.
-- Returns the quantity actually decremented (0 means tracked stock was
-- already exhausted by something else — an "oversold" case the caller can
-- act on; untracked/unlimited stock, inventory_count is null, always
-- returns p_quantity since there's nothing to decrement). The return type
-- is changing (void -> integer), which `create or replace` can't do, so
-- the old definition has to be dropped first.
drop function if exists public.decrement_inventory(text, integer);

create function public.decrement_inventory(
  p_stripe_product_id text,
  p_quantity integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_count integer;
begin
  update public.products
  set inventory_count = inventory_count - p_quantity
  where stripe_product_id = p_stripe_product_id
    and inventory_count is not null
    and inventory_count >= p_quantity;

  get diagnostics v_updated_count = row_count;

  if v_updated_count > 0 then
    return p_quantity;
  end if;

  if exists (
    select 1 from public.products
    where stripe_product_id = p_stripe_product_id and inventory_count is null
  ) then
    return p_quantity; -- untracked stock — treat as always-available
  end if;

  return 0; -- oversold: tracked stock was already exhausted
end;
$$;

-- Surfaces the one residual gap this fix doesn't (and can't, without a full
-- stock-reservation system) close: inventory availability is still checked
-- once at Checkout Session creation and committed once at payment
-- confirmation, with an arbitrary customer-controlled gap between — two
-- concurrent buyers of the last unit can still both pay. decrement_inventory
-- returning 0 is how the webhook now finds out that happened for a given
-- line item; this column is where it records it so the admin actually sees
-- it instead of it only ever reaching a log line nothing reads.
alter table public.orders
  add column if not exists oversold_items text;
