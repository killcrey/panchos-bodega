-- The "Request a Quote" form only ever collected email — a phone number is
-- a much faster way to actually reach someone about a service booking, so
-- it's now offered as an optional field alongside it.
alter table public.service_inquiries
  add column if not exists phone text;
