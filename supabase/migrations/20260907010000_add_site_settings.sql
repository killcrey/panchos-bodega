-- Admin-editable custom messages appended to automated emails — a personal
-- note from the band, distinct from the transactional content (order
-- details, download links) those emails already carry. Two separate
-- messages since purchases/downloads and tips are different moments and
-- the admin may want different wording for each.
create table if not exists public.site_settings (
  id boolean primary key default true,
  purchase_thank_you_message text,
  tip_thank_you_message text,
  constraint site_settings_single_row check (id)
);

insert into public.site_settings (id)
values (true)
on conflict (id) do nothing;

-- Read by every email-sending edge function (service role, bypasses RLS)
-- and read/written by the admin panel (authenticated).
alter table public.site_settings enable row level security;

create policy "Admins can manage site settings"
  on public.site_settings
  for all
  to authenticated
  using (true)
  with check (true);
