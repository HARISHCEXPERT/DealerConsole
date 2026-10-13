-- Dealer Console — schema sketch (Supabase / Postgres)
-- NOTE: ye draft hai. Real field shapes DMS raw data dekhne ke baad final honge.

create table if not exists dealers (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  created_at timestamptz default now()
);

-- ===== APPEND-ONLY LEDGER (core) =====
create table if not exists ledger (
  id bigserial primary key,
  dealer_id uuid references dealers(id),
  source text not null,          -- 'hero_dms' | 'warranty_portal'
  entity text not null,          -- 'sale' | 'service' | 'part_stock' | 'warranty' | 'fsc'
  event_type text not null,      -- 'snapshot' | 'sale' | 'stock_in' | 'stock_out'
  ref_no text,                   -- invoice / job card / claim / coupon / part_no
  chassis text,                  -- JOIN KEY (plain, searchable)
  payload jsonb not null,        -- normalized record (PII fields encrypted inside)
  occurred_at timestamptz,
  fetched_at timestamptz default now()
);
create index if not exists idx_ledger_chassis on ledger(chassis);
create index if not exists idx_ledger_entity on ledger(dealer_id, entity, occurred_at);

-- ===== VEHICLE MASTER (140k+, full history) =====
create table if not exists vehicle_master (
  chassis text primary key,
  engine_no text,
  model text,
  section text,
  customer_enc text,             -- encrypted (name/phone)
  sold_on date,
  dealer_id uuid references dealers(id),
  updated_at timestamptz default now()
);

-- ===== PARTS CATALOG (shared Hero data) =====
create table if not exists parts_catalog (
  part_no text primary key,
  name text, category text, fits text, mrp numeric
);

-- ===== PARTS STOCK — daily snapshot per dealer =====
-- Closing = Opening + in_qty - (service_out + counter_out)
create table if not exists parts_stock_daily (
  dealer_id uuid references dealers(id),
  part_no text references parts_catalog(part_no),
  snap_date date not null,
  opening int, in_qty int,
  service_out int,               -- workshop me laga
  counter_out int,               -- counter sale
  closing int,                   -- DMS actual
  calc_closing int,              -- humara calculated
  reconciled boolean default false,
  primary key (dealer_id, part_no, snap_date)
);
