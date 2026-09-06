-- email_captures had RLS enabled with no policy at all — deny-by-default,
-- which silently hid its 5 real historical rows from the admin panel's
-- Email Captures tab (confirmed live: anon/authenticated saw 0 rows, the
-- service role key saw 5). Same fix as the tips table: admins
-- (authenticated) get full access; the free-download function already
-- writes via the service role key, which bypasses RLS regardless.
create policy "Admins can manage email captures"
  on public.email_captures
  for all
  to authenticated
  using (true)
  with check (true);
