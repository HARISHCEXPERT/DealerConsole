-- Dealer Console — per-dealer TAB ACCESS
-- Supabase dashboard → SQL Editor → ye chala do (ek baar).
-- tabs = JSON array jaise ["dashboard","sale","parts"]. null / khaali = dealer ko SAARE tab.
alter table public.dealers add column if not exists tabs text;
