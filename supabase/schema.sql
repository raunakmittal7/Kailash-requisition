-- Kailasha Group requisition website: Supabase (Postgres) schema, draft 1
-- Logins use Supabase Auth with phone (mobile) + password; OTP via WhatsApp later.

create table sites (
  code text primary key,              -- JAI, MAT, TAL, KAL
  name text not null,
  kind text not null check (kind in ('re','mfg')),
  delivery_address text
);

create table companies (               -- billing companies
  id uuid primary key default gen_random_uuid(),
  name text not null, gstin text, address text
);
create table site_companies (site text references sites, company uuid references companies, primary key(site,company));

create table people (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  mobile text unique not null,
  role text not null check (role in ('store','pm','ajay','ravi','raunak','admin')),
  site text references sites,          -- storekeepers only
  pin_hash text,                       -- 4-digit reject PIN (hashed)
  active boolean default true
);

create table delegations (
  id uuid primary key default gen_random_uuid(),
  from_role text not null, to_person uuid references people,
  starts date, ends date, active boolean default true
);

create table categories (id serial primary key, name text not null, kind text not null check (kind in ('re','mfg')));
create table units (id serial primary key, name text unique not null, permanent boolean default false);

create table items (
  id uuid primary key default gen_random_uuid(),
  name text not null, kind text not null, unit text, sub_unit text,
  category int references categories, brand text, tally_name text
);

create table vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null, gstin text, mobile text, email text, address text,
  categories int[] default '{}'
);
create table vendor_aliases (vendor uuid references vendors, vendor_text text, item uuid references items, primary key(vendor,vendor_text));

create table requisitions (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,          -- KG/JAI/2026/001
  site text references sites not null,
  raised_by uuid references people,
  deadline date, urgent boolean default false,
  area_mode text, area_text text,
  stage text not null,                  -- ravi_ok, ajay_ok, quotes, final, issue, approved, clarify, rejected
  pm_decides boolean default false, small_order boolean default false,
  remarks text, created_at timestamptz default now()
);

create table req_lines (
  id uuid primary key default gen_random_uuid(),
  req uuid references requisitions on delete cascade,
  item uuid references items, name text not null, name_hindi text,
  qty numeric not null, unit text, sub_unit text, category int references categories,
  brand text, specs text, photo_path text, removed boolean default false
);

create table quotes (
  id uuid primary key default gen_random_uuid(),
  req uuid references requisitions on delete cascade,
  vendor uuid references vendors, contract uuid, file_path text,
  gst_pct numeric, freight numeric default 0, terms text, created_at timestamptz default now()
);
create table quote_lines (quote uuid references quotes on delete cascade, line uuid references req_lines, brand text, rate numeric, per text, vendor_text text, sure boolean default true, primary key(quote,line));
create table awards (req uuid references requisitions on delete cascade, line uuid references req_lines, quote uuid references quotes, chosen_by uuid references people, primary key(req,line));

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,           -- KG/JAI/PO/2026/001
  req uuid references requisitions, vendor uuid references vendors, company uuid references companies,
  award_by text, issued_by uuid references people, status text default 'open', created_at timestamptz default now()
);
create table po_lines (id uuid primary key default gen_random_uuid(), po uuid references purchase_orders on delete cascade, line uuid references req_lines, qty numeric, rate numeric, gst_pct numeric);
create table receipts (id uuid primary key default gen_random_uuid(), po_line uuid references po_lines, qty numeric, received_by uuid references people, at timestamptz default now(), tally_synced boolean default false);

create table rate_lists (id uuid primary key default gen_random_uuid(), brand text, vendor uuid references vendors, kind text, gst_pct numeric, valid_till date, default_disc text, group_disc jsonb default '{}');
create table rate_rows (id uuid primary key default gen_random_uuid(), list uuid references rate_lists on delete cascade, grp text, name text, unit text, price numeric);
create table contract_map (list uuid references rate_lists, item_key text, row uuid references rate_rows, sure boolean, primary key(list,item_key));

create table stock_moves (id uuid primary key default gen_random_uuid(), site text references sites, item uuid references items, qty numeric, kind text check (kind in ('in','issue','return')), barcode text, by_person uuid references people, at timestamptz default now());

create table activity (id bigserial primary key, req uuid, po uuid, who uuid references people, what text, at timestamptz default now());
create table outbox (id bigserial primary key, to_mobile text, template text, body text, sent_at timestamptz, status text default 'queued');

-- Row-level security: storekeepers see only their own site; everyone else sees all.
alter table requisitions enable row level security;
create policy req_read on requisitions for select using (
  exists (select 1 from people p where p.id = auth.uid() and (p.role <> 'store' or p.site = requisitions.site))
);
