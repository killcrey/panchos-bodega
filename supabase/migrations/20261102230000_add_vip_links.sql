-- VIP folder links: the secret link written onto an NFC keychain and handed out
-- at events. One link opens a private page (/vip/<token>) with the album, the
-- covers and a thank-you note, and stops working after `expires_at` (7 days
-- from creation) or as soon as it is shut off by hand.
--
-- The table is admin-only on purpose — the token IS the secret, so nothing
-- public may read it. The vip-folder edge function (service role) is the only
-- thing that looks a token up, and it re-checks expiry on every request.
create table if not exists public.vip_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  label text not null default '',
  note text not null default '',
  product_slug text not null default 'memories-of-home',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked boolean not null default false,
  open_count integer not null default 0,
  last_opened_at timestamptz
);

alter table public.vip_links enable row level security;

create policy "Admins can manage vip links"
  on public.vip_links
  for all
  to authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on public.vip_links to authenticated;
