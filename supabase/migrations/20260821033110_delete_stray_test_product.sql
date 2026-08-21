-- Leftover "ZZZ TEST DELETE ME" product was live and published on the real
-- storefront (not created by this session's own throwaway test rows, which
-- were already cleaned up separately). It had no cover art, audio, or Stripe
-- product attached, so nothing in Storage needs cleaning up alongside it.
delete from public.products where id = 'e8b1ed4c-0f87-4345-ad77-480c8a370956';
