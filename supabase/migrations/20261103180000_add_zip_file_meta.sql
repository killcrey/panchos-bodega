-- Remembers each song/cover's size and CRC-32 so a zip download can start right
-- away. Before this, every zip request first read the whole album just to get
-- those two numbers (~25 s for Memories Of Home) because a zip's headers need
-- them before the first byte goes out.
--
-- Keyed by storage path (or "url:<address>" for a public file). A row is only
-- trusted while the object's current size AND ETag still match what is stored
-- here (checked with a 1-byte range request on every download), so a file
-- replaced at the same path is simply re-read. Service role only.
create table if not exists public.zip_file_meta (
  path text primary key,
  size bigint not null,
  crc bigint not null,
  etag text not null,
  updated_at timestamptz not null default now()
);

alter table public.zip_file_meta enable row level security;
revoke all on public.zip_file_meta from anon, authenticated;
