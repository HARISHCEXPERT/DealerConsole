-- ============================================================
--  DEALER CONSOLE — LICENSE SERVER (Supabase)
--  Supabase dashboard → SQL Editor → New query → ye poora paste → Run
--  Phir neeche wali line me apna admin email daal ke Run (sirf tum admin panel khol paoge).
-- ============================================================

create table if not exists public.dealers (
  id            bigint generated always as identity primary key,
  dealer_code   text not null unique,               -- jaise 22839
  name          text not null,                      -- Shree Balaji Motors
  city          text,
  phone         text,
  login_id      text not null unique,               -- dealer is ID se app me license chalu karega
  pass_hash     text not null,                      -- pbkdf2$100000$salt$hash (asli password kabhi nahi)
  plan          text not null default 'trial',      -- trial | monthly | yearly | custom
  expires_at    timestamptz not null,               -- kab tak chalega
  status        text not null default 'active',     -- active | suspended
  device_id     text,                               -- jis PC se bandha (null = koi bhi pehla PC)
  device_name   text,
  device_bound_at timestamptz,
  last_seen     timestamptz,
  app_version   text,
  notes         text,
  created_at    timestamptz not null default now()
);

create table if not exists public.license_log (
  id         bigint generated always as identity primary key,
  dealer_code text,
  action     text,                                  -- activate | refresh | denied | device_reset ...
  detail     text,
  device_id  text,
  at         timestamptz not null default now()
);

create table if not exists public.admins (email text primary key);

alter table public.dealers enable row level security;
alter table public.license_log enable row level security;
alter table public.admins enable row level security;

-- sirf admins table me jo email hai wahi padh/likh sake (admin panel). Dealer app seedha table nahi chhoota — sirf Edge Function se.
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

drop policy if exists dealers_admin on public.dealers;
create policy dealers_admin on public.dealers for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists log_admin on public.license_log;
create policy log_admin on public.license_log for select to authenticated using (public.is_admin());
drop policy if exists admins_self on public.admins;
create policy admins_self on public.admins for select to authenticated using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- >>> APNA ADMIN EMAIL YAHAN (wahi jo Authentication → Users me banaya) <<<
-- insert into public.admins (email) values ('tumhara-email@example.com') on conflict do nothing;
