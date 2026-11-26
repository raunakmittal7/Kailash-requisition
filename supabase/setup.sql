-- Kailasha Group requisition website: one-time database setup for Supabase.
-- Paste all of this into Supabase > SQL Editor > New query, then press Run.
-- Safe to run again: it skips anything that already exists.

-- ============ Tables ============

create table if not exists sites (
  code text primary key,              -- JAI, MAT, TAL, KAL
  name text not null,
  kind text not null check (kind in ('re','mfg')),
  delivery_address text
);

create table if not exists companies (  -- billing companies
  id uuid primary key default gen_random_uuid(),
  name text not null, gstin text, address text
);
create table if not exists site_companies (
  site text references sites, company uuid references companies on delete cascade,
  primary key (site, company)
);

create table if not exists people (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  mobile text unique not null,
  role text not null check (role in ('store','pm','ajay','ravi','raunak','admin')),
  site text references sites,          -- storekeepers only
  pin_hash text,                       -- 4-digit reject PIN (hashed)
  active boolean default true
);

create table if not exists delegations (
  id uuid primary key default gen_random_uuid(),
  from_role text not null, to_person uuid references people,
  starts date, ends date, active boolean default true
);

create table if not exists categories (
  id serial primary key, name text not null, kind text not null check (kind in ('re','mfg')),
  unique (name, kind)
);
create table if not exists units (id serial primary key, name text unique not null, permanent boolean default false);
create table if not exists areas (       -- frequent "specific areas" that Raunak approves as checkboxes
  id serial primary key, site text references sites, name text not null,
  approved boolean default false, unique (site, name)
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  name text not null, kind text not null, unit text, sub_unit text,
  category int references categories, brand text, tally_name text
);

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null, gstin text, mobile text, email text, address text,
  categories int[] default '{}'
);
create table if not exists vendor_aliases (
  vendor uuid references vendors on delete cascade, vendor_text text, item uuid references items,
  primary key (vendor, vendor_text)
);

create table if not exists requisitions (
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

create table if not exists req_lines (
  id uuid primary key default gen_random_uuid(),
  req uuid references requisitions on delete cascade,
  item uuid references items, name text not null, name_hindi text,
  qty numeric not null, unit text, sub_unit text, category int references categories,
  brand text, specs text, photo_path text, removed boolean default false
);

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  req uuid references requisitions on delete cascade,
  vendor uuid references vendors, contract uuid, file_path text,
  gst_pct numeric, freight numeric default 0, terms text, created_at timestamptz default now()
);
create table if not exists quote_lines (
  quote uuid references quotes on delete cascade, line uuid references req_lines on delete cascade,
  brand text, rate numeric, per text, vendor_text text, sure boolean default true,
  primary key (quote, line)
);
create table if not exists awards (
  req uuid references requisitions on delete cascade, line uuid references req_lines on delete cascade,
  quote uuid references quotes, chosen_by uuid references people,
  primary key (req, line)
);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,           -- KG/JAI/PO/2026/001
  req uuid references requisitions, vendor uuid references vendors, company uuid references companies,
  award_by text, issued_by uuid references people, status text default 'open', created_at timestamptz default now()
);
create table if not exists po_lines (
  id uuid primary key default gen_random_uuid(),
  po uuid references purchase_orders on delete cascade, line uuid references req_lines,
  qty numeric, rate numeric, gst_pct numeric
);
create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  po_line uuid references po_lines, qty numeric, received_by uuid references people,
  at timestamptz default now(), tally_synced boolean default false
);

create table if not exists rate_lists (
  id uuid primary key default gen_random_uuid(),
  brand text, vendor uuid references vendors, kind text, gst_pct numeric,
  valid_till date, default_disc text, group_disc jsonb default '{}'
);
create table if not exists rate_rows (
  id uuid primary key default gen_random_uuid(),
  list uuid references rate_lists on delete cascade, grp text, name text, unit text, price numeric
);
create table if not exists contract_map (
  list uuid references rate_lists on delete cascade, item_key text, row uuid references rate_rows,
  sure boolean, primary key (list, item_key)
);

create table if not exists stock_moves (
  id uuid primary key default gen_random_uuid(),
  site text references sites, item uuid references items, qty numeric,
  kind text check (kind in ('in','issue','return')), barcode text,
  by_person uuid references people, at timestamptz default now()
);

create table if not exists activity (
  id bigserial primary key, req uuid, po uuid, who uuid references people, what text, at timestamptz default now()
);
create table if not exists outbox (
  id bigserial primary key, to_mobile text, template text, body text, sent_at timestamptz, status text default 'queued'
);

-- Running numbers: KG/JAI/2026/001 for requisitions, KG/JAI/PO/2026/001 for POs.
create table if not exists counters (
  site text, doc text, year int, last int not null default 0,
  primary key (site, doc, year)
);
create or replace function next_number(p_site text, p_doc text) returns text
language plpgsql security definer set search_path = public as $$
declare y int := extract(year from now()); n int;
begin
  insert into counters (site, doc, year, last) values (p_site, p_doc, y, 1)
  on conflict (site, doc, year) do update set last = counters.last + 1
  returning last into n;
  return 'KG/' || p_site || case when p_doc = 'po' then '/PO/' else '/' end || y || '/' || lpad(n::text, 3, '0');
end $$;

-- ============ Who is signed in ============

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from people where id = auth.uid() and active
$$;
create or replace function my_site() returns text
language sql stable security definer set search_path = public as $$
  select site from people where id = auth.uid() and active
$$;

-- ============ Security ============
-- Nobody can see anything without signing in.
-- Storekeepers see only their own site's requisitions and stock. Everyone else sees all.
-- Only the admin and Raunak can add or change people.

do $$
declare t text;
begin
  foreach t in array array['sites','companies','site_companies','delegations','categories','units','areas',
    'items','vendors','vendor_aliases','quotes','quote_lines','awards','purchase_orders','po_lines',
    'receipts','rate_lists','rate_rows','contract_map','activity','outbox','counters']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists signed_in on %I', t);
    execute format('create policy signed_in on %I for all to authenticated using (my_role() is not null) with check (my_role() is not null)', t);
  end loop;
end $$;

alter table people enable row level security;
drop policy if exists people_read on people;
create policy people_read on people for select to authenticated using (my_role() is not null or id = auth.uid());
drop policy if exists people_write on people;
create policy people_write on people for all to authenticated
  using (my_role() in ('admin','raunak')) with check (my_role() in ('admin','raunak'));

alter table requisitions enable row level security;
drop policy if exists req_read on requisitions;
drop policy if exists req_all on requisitions;
create policy req_all on requisitions for all to authenticated
  using (my_role() is not null and (my_role() <> 'store' or site = my_site()))
  with check (my_role() is not null and (my_role() <> 'store' or site = my_site()));

alter table req_lines enable row level security;
drop policy if exists lines_all on req_lines;
create policy lines_all on req_lines for all to authenticated
  using (exists (select 1 from requisitions r where r.id = req_lines.req))
  with check (exists (select 1 from requisitions r where r.id = req_lines.req));

alter table stock_moves enable row level security;
drop policy if exists stock_all on stock_moves;
create policy stock_all on stock_moves for all to authenticated
  using (my_role() is not null and (my_role() <> 'store' or site = my_site()))
  with check (my_role() is not null and (my_role() <> 'store' or site = my_site()));

-- File storage for quotes, item photos and PO PDFs (private; signed-in users only).
insert into storage.buckets (id, name, public) values ('files', 'files', false) on conflict (id) do nothing;
drop policy if exists files_signed_in on storage.objects;
create policy files_signed_in on storage.objects for all to authenticated
  using (bucket_id = 'files' and my_role() is not null)
  with check (bucket_id = 'files' and my_role() is not null);

-- ============ Starting data ============

insert into sites (code, name, kind) values
  ('JAI','Jaigaon Project','re'),
  ('MAT','Matigara Project','re'),
  ('TAL','Talma land project','re'),
  ('KAL','Kaveri Agro LLP','mfg')
on conflict (code) do nothing;

insert into units (name, permanent)
select u, true from unnest(array['bags','kg','MT','nos','metres','sqft','cft','brass','litres','boxes',
  'rolls','coils','sets','pairs','packets']) as u
on conflict (name) do nothing;

insert into categories (name, kind)
select c, 're' from unnest(array['Civil and structural','Steel and reinforcement','Electrical',
  'Plumbing and sanitary','Tiles and flooring','Paint and finishing','Doors, windows and hardware',
  'Wood and plywood','Glass and aluminium','Waterproofing and chemicals','Fire safety',
  'Lifts and machinery','Tools and consumables','Safety gear','Shuttering and scaffolding']) as c
on conflict (name, kind) do nothing;

insert into categories (name, kind)
select c, 'mfg' from unnest(array['Raw materials','Packaging','Machinery spares','Electrical',
  'Plumbing and piping','Lab and QC','Cleaning chemicals','Lubricants and fuel',
  'Office and stationery','Grocery & Ration','Others']) as c
on conflict (name, kind) do nothing;

-- Final check: this should show 4 sites, 15 units, 26 categories.
select (select count(*) from sites) as sites,
       (select count(*) from units) as units,
       (select count(*) from categories) as categories;
