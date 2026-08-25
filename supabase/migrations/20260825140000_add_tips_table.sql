-- Fan tips. Deliberately not folded into `orders`: a tip has no items, no
-- shipping, no fulfillment and no inventory effect, so it would leave most
-- of that table null and force every order query to filter it back out.
create table if not exists public.tips (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text not null unique,
  amount_cents integer not null check (amount_cents > 0),
  email text,
  name text,
  message text,
  created_at timestamptz not null default now()
);

-- Tips carry supporter emails, so no public access at all — same posture as
-- `orders`. The admin (authenticated) reads them; the webhook inserts with
-- the service role key, which bypasses RLS.
alter table public.tips enable row level security;

create policy "Admins can manage tips"
  on public.tips
  for all
  to authenticated
  using (true)
  with check (true);

create index if not exists tips_created_at_idx on public.tips (created_at desc);
