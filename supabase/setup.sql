-- Kailasha Group requisition website: first-time database setup for Supabase (version 2).
-- Paste all of this into Supabase > SQL Editor > New query, then press Run.
--
-- This is for a NEW, empty project. Running it again will not break anything,
-- but it will not change tables that already exist. Later changes will come as
-- separate, numbered update scripts (supabase/migrations/...).
--
-- Roles: store (one site), pm, ajay, ravi, raunak, admin. The workflow is the beta's:
--   Manufacturing: ravi_ok -> ajay_ok -> quotes -> final -> issue -> approved -> closed
--   Real estate:             ajay_ok -> quotes -> final -> issue -> approved -> closed
--   Any step can go to 'clarify' (back to the storekeeper) and returns to where it was.
--   'rejected' only through reject_requisition(), which needs the approver's 4-digit PIN.

create extension if not exists pgcrypto with schema extensions;

-- ===================================================================
-- 1. Tables
-- ===================================================================

create table if not exists sites (
  code text primary key check (code ~ '^[A-Z]{2,5}$'),
  name text not null,
  kind text not null check (kind in ('re','mfg')),
  delivery_address text
);

create table if not exists companies (            -- billing companies
  id uuid primary key default gen_random_uuid(),
  name text not null, gstin text check (gstin is null or gstin ~ '^[0-9A-Z]{15}$'), address text
);
create table if not exists site_companies (
  site text not null references sites, company uuid not null references companies on delete cascade,
  primary key (site, company)
);

create table if not exists people (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  mobile text unique not null check (mobile ~ '^[0-9]{10}$'),
  role text not null check (role in ('store','pm','ajay','ravi','raunak','admin')),
  site text references sites,
  active boolean not null default true,
  check ((role = 'store') = (site is not null))    -- storekeepers must have a site; others none
);

-- Reject PINs live in their own table that no app screen can read.
create table if not exists pins (
  person uuid primary key references people on delete cascade,
  pin_hash text not null,
  failed int not null default 0,
  locked_until timestamptz
);

create table if not exists delegations (
  id uuid primary key default gen_random_uuid(),
  from_role text not null check (from_role in ('ajay','ravi','raunak')),
  to_person uuid not null references people on delete cascade,
  starts date not null default current_date,
  ends date not null,
  active boolean not null default true,
  created_by uuid references people default auth.uid(),
  check (ends >= starts)
);

create table if not exists categories (
  id serial primary key, name text not null, kind text not null check (kind in ('re','mfg')),
  unique (name, kind)
);
create table if not exists units (
  id serial primary key, name text unique not null, permanent boolean not null default false
);
create table if not exists areas (       -- frequent "specific areas"; Raunak approves them as checkboxes
  id serial primary key, site text not null references sites, name text not null,
  approved boolean not null default false, unique (site, name)
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  name text not null, kind text not null check (kind in ('re','mfg')), unit text, sub_unit text,
  category int references categories, brand text, tally_name text
);

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null, gstin text check (gstin is null or gstin ~ '^[0-9A-Z]{15}$'),
  mobile text, email text, address text,
  categories int[] not null default '{}'
);
create table if not exists vendor_aliases (
  vendor uuid not null references vendors on delete cascade, vendor_text text not null,
  item uuid references items, primary key (vendor, vendor_text)
);

create table if not exists requisitions (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,          -- KG/JAI/2026/001, filled in automatically
  site text not null references sites,
  raised_by uuid references people default auth.uid(),
  deadline date, urgent boolean not null default false,
  area_mode text check (area_mode in ('entire','specific')), area_text text,
  stage text not null check (stage in
    ('ravi_ok','ajay_ok','quotes','final','issue','approved','closed','clarify','rejected')),
  return_to text check (return_to in ('ravi_ok','ajay_ok','quotes','final','issue')),
  pm_decides boolean not null default false, small_order boolean not null default false,
  remarks text, created_at timestamptz not null default now(),
  check ((stage = 'clarify') = (return_to is not null)),
  check (area_mode <> 'specific' or coalesce(area_text, '') <> '')
);

create table if not exists req_lines (
  id uuid primary key default gen_random_uuid(),
  req uuid not null references requisitions on delete cascade,
  item uuid references items, name text not null, name_hindi text,
  qty numeric not null check (qty > 0), unit text not null, sub_unit text,
  category int references categories,
  brand text, specs text, photo_path text, removed boolean not null default false,
  unique (id, req)
);

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  req uuid not null references requisitions on delete cascade,
  vendor uuid not null references vendors, contract uuid, file_path text,
  gst_pct numeric check (gst_pct between 0 and 28),
  freight numeric not null default 0 check (freight >= 0),
  terms text, created_by uuid references people default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, req)
);
create table if not exists quote_lines (
  quote uuid not null references quotes on delete cascade,
  line uuid not null references req_lines on delete cascade,
  brand text, rate numeric check (rate >= 0), per text, vendor_text text,
  sure boolean not null default true,
  primary key (quote, line)
);
-- An award must use a quote and a line from the SAME requisition (enforced by the two keys below).
create table if not exists awards (
  req uuid not null references requisitions on delete cascade,
  line uuid not null,
  quote uuid not null,
  chosen_by uuid references people default auth.uid(),
  primary key (req, line),
  foreign key (line, req) references req_lines (id, req) on delete cascade,
  foreign key (quote, req) references quotes (id, req) on delete cascade
);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,           -- KG/JAI/PO/2026/001, filled in automatically
  req uuid not null references requisitions, vendor uuid not null references vendors,
  company uuid references companies,
  award_by text check (award_by in ('raunak','pm','small_order')),
  issued_by uuid references people default auth.uid(),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  created_at timestamptz not null default now()
);
create table if not exists po_lines (
  id uuid primary key default gen_random_uuid(),
  po uuid not null references purchase_orders on delete cascade,
  line uuid not null references req_lines,
  qty numeric not null check (qty > 0),
  approved_qty numeric,                    -- quantity when the PO was made; set automatically
  rate numeric not null check (rate >= 0),
  gst_pct numeric not null default 18 check (gst_pct between 0 and 28)
);
create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  po_line uuid not null references po_lines,
  qty numeric not null check (qty > 0),
  received_by uuid references people default auth.uid(),
  at timestamptz not null default now(), tally_synced boolean not null default false
);

create table if not exists rate_lists (
  id uuid primary key default gen_random_uuid(),
  brand text not null, vendor uuid references vendors, kind text check (kind in ('re','mfg')),
  gst_pct numeric check (gst_pct between 0 and 28),
  valid_till date, default_disc text, group_disc jsonb not null default '{}'
);
create table if not exists rate_rows (
  id uuid primary key default gen_random_uuid(),
  list uuid not null references rate_lists on delete cascade, grp text, name text not null, unit text,
  price numeric not null check (price >= 0)
);
create table if not exists contract_map (
  list uuid not null references rate_lists on delete cascade, item_key text not null,
  row uuid references rate_rows on delete cascade, sure boolean not null default false,
  primary key (list, item_key)
);

create table if not exists stock_moves (
  id uuid primary key default gen_random_uuid(),
  site text not null references sites, item uuid not null references items,
  qty numeric not null check (qty > 0),
  kind text not null check (kind in ('in','issue','return')), barcode text,
  by_person uuid references people default auth.uid(), at timestamptz not null default now()
);

-- Audit trail: rows can be added, never changed or deleted from the app.
create table if not exists activity (
  id bigserial primary key, req uuid references requisitions on delete set null,
  po uuid references purchase_orders on delete set null,
  who uuid references people default auth.uid(), what text not null, at timestamptz not null default now()
);
create table if not exists outbox (            -- WhatsApp messages waiting to be sent by the server
  id bigserial primary key, to_mobile text not null, template text, body text,
  sent_at timestamptz, status text not null default 'queued' check (status in ('queued','sent','failed'))
);

create table if not exists counters (          -- running numbers; no app access
  site text not null references sites, doc text not null check (doc in ('req','po')),
  year int not null, last int not null default 0,
  primary key (site, doc, year)
);

-- Indexes for the lookups the app makes most.
create index if not exists people_site_idx on people (site);
create index if not exists delegations_to_idx on delegations (to_person);
create index if not exists items_category_idx on items (category);
create index if not exists req_site_stage_idx on requisitions (site, stage);
create index if not exists req_deadline_idx on requisitions (deadline);
create index if not exists req_raised_by_idx on requisitions (raised_by);
create index if not exists req_lines_req_idx on req_lines (req);
create index if not exists req_lines_item_idx on req_lines (item);
create index if not exists quotes_req_idx on quotes (req);
create index if not exists quotes_vendor_idx on quotes (vendor);
create index if not exists quote_lines_line_idx on quote_lines (line);
create index if not exists awards_quote_idx on awards (quote);
create index if not exists po_req_idx on purchase_orders (req);
create index if not exists po_vendor_idx on purchase_orders (vendor);
create index if not exists po_lines_po_idx on po_lines (po);
create index if not exists po_lines_line_idx on po_lines (line);
create index if not exists receipts_po_line_idx on receipts (po_line);
create index if not exists rate_rows_list_idx on rate_rows (list);
create index if not exists stock_site_item_idx on stock_moves (site, item);
create index if not exists activity_req_idx on activity (req);
create index if not exists activity_po_idx on activity (po);

-- ===================================================================
-- 2. Who is signed in (helpers used by the security rules)
-- ===================================================================

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from people where id = auth.uid() and active
$$;
create or replace function my_site() returns text
language sql stable security definer set search_path = public as $$
  select site from people where id = auth.uid() and active
$$;
-- Office = everyone except storekeepers.
create or replace function is_office() returns boolean
language sql stable set search_path = public as $$
  select coalesce(my_role() in ('pm','ajay','ravi','raunak','admin'), false)
$$;
-- Buyers = people who handle vendors, quotes and POs.
create or replace function is_buyer() returns boolean
language sql stable set search_path = public as $$
  select coalesce(my_role() in ('pm','raunak','admin'), false)
$$;
create or replace function is_boss() returns boolean
language sql stable set search_path = public as $$
  select coalesce(my_role() in ('raunak','admin'), false)
$$;
-- True if I hold this approval right myself, or someone handed it to me for today.
create or replace function acts_as(p_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_role() = p_role, false) or exists (
    select 1 from delegations d
    where d.from_role = p_role and d.to_person = auth.uid() and d.active
      and current_date between d.starts and d.ends)
$$;
create or replace function req_site(p_req uuid) returns text
language sql stable security definer set search_path = public as $$
  select site from requisitions where id = p_req
$$;
create or replace function first_stage(p_site text) returns text
language sql stable security definer set search_path = public as $$
  select case kind when 'mfg' then 'ravi_ok' else 'ajay_ok' end from sites where code = p_site
$$;
-- A storekeeper may change a requisition's items only while it is still waiting for the
-- first approval, or after it was sent back to them for clarification.
create or replace function store_can_edit(p_req uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from requisitions r
    where r.id = p_req and my_role() = 'store' and r.site = my_site()
      and (r.stage = 'clarify' or r.stage = first_stage(r.site)))
$$;

-- ===================================================================
-- 3. Automatic numbering
-- ===================================================================

create or replace function next_number(p_site text, p_doc text) returns text
language plpgsql security definer set search_path = public as $$
declare y int := extract(year from now() at time zone 'Asia/Kolkata'); n int;
begin
  if p_doc not in ('req','po') then raise exception 'Unknown document type %', p_doc; end if;
  if not exists (select 1 from sites where code = p_site) then raise exception 'Unknown site %', p_site; end if;
  insert into counters (site, doc, year, last) values (p_site, p_doc, y, 1)
  on conflict (site, doc, year) do update set last = counters.last + 1
  returning last into n;
  return 'KG/' || p_site || case when p_doc = 'po' then '/PO/' else '/' end || y || '/' || lpad(n::text, 3, '0');
end $$;
-- Only the database itself hands out numbers; the app cannot call this directly.
revoke all on function next_number(text, text) from public, anon, authenticated;

create or replace function set_req_number() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.number := next_number(new.site, 'req');
  return new;
end $$;
drop trigger if exists req_number on requisitions;
create trigger req_number before insert on requisitions for each row execute function set_req_number();

create or replace function set_po_number() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.number := next_number(req_site(new.req), 'po');
  return new;
end $$;
drop trigger if exists po_number on purchase_orders;
create trigger po_number before insert on purchase_orders for each row execute function set_po_number();

-- ===================================================================
-- 4. Workflow rules (who may move a requisition to which step)
-- ===================================================================

create or replace function check_req_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := my_role();
begin
  -- Changes made from the Supabase dashboard or the server (no signed-in user) are not checked.
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    if new.stage <> first_stage(new.site) then
      raise exception 'A new requisition must start at %', first_stage(new.site);
    end if;
    return new;
  end if;

  if new.site <> old.site or new.number <> old.number or new.raised_by is distinct from old.raised_by then
    raise exception 'Site, number and raised-by cannot be changed';
  end if;
  if new.pm_decides <> old.pm_decides and not acts_as('raunak') then
    raise exception 'Only Raunak can let the procurement manager decide';
  end if;

  if new.stage is distinct from old.stage then
    if new.stage = 'rejected' and coalesce(current_setting('app.via_reject', true), '') <> 'on' then
      raise exception 'Rejecting needs the approver PIN (use reject_requisition)';
    end if;
    if old.stage in ('rejected','closed') then
      raise exception 'This requisition is finished and cannot be moved';
    end if;
    if r = 'admin' then return new; end if;

    if new.stage = 'clarify' then
      if old.stage = 'ravi_ok' and acts_as('ravi') then null;
      elsif old.stage = 'ajay_ok' and acts_as('ajay') then null;
      elsif old.stage = 'final' and acts_as('raunak') then null;
      elsif old.stage in ('quotes','issue') and (r = 'pm' or acts_as('raunak')) then null;
      else raise exception 'You cannot send this back at this step'; end if;
      if new.return_to is distinct from old.stage then
        raise exception 'return_to must be the step it was sent back from';
      end if;
    elsif old.stage = 'clarify' then
      if new.stage is distinct from old.return_to then
        raise exception 'After clarification it must go back to %', old.return_to;
      end if;
      if not (r = 'store' and old.site = my_site()) and not is_office() then
        raise exception 'Not allowed';
      end if;
    elsif new.stage <> 'rejected' then
      if old.stage = 'ravi_ok' and new.stage = 'ajay_ok' and acts_as('ravi') then null;
      elsif old.stage = 'ajay_ok' and new.stage = 'quotes' and acts_as('ajay') then null;
      elsif old.stage = 'quotes' and new.stage = 'final' and (r = 'pm' or acts_as('raunak')) then null;
      elsif old.stage = 'quotes' and new.stage = 'issue' and r = 'pm' and new.small_order then null;
      elsif old.stage = 'final' and new.stage = 'issue' and acts_as('raunak') then null;
      elsif old.stage = 'issue' and new.stage = 'approved' and (r = 'pm' or acts_as('raunak')) then null;
      elsif old.stage = 'approved' and new.stage = 'closed'
            and (r = 'pm' or acts_as('raunak') or acts_as('ajay') or acts_as('ravi')) then null;
      else raise exception 'You cannot move this requisition from % to %', old.stage, new.stage; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists req_rules on requisitions;
create trigger req_rules before insert or update on requisitions for each row execute function check_req_change();

-- Every step change goes into the audit trail automatically.
create or replace function log_req_stage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into activity (req, who, what) values (new.id, auth.uid(), 'Raised ' || new.number);
  elsif new.stage is distinct from old.stage then
    insert into activity (req, who, what)
    values (new.id, auth.uid(), 'Moved from ' || old.stage || ' to ' || new.stage
            || coalesce(': ' || nullif(new.remarks, old.remarks), ''));
  end if;
  return null;
end $$;
drop trigger if exists req_log on requisitions;
create trigger req_log after insert or update on requisitions for each row execute function log_req_stage();

-- Quote lines and PO lines must belong to the same requisition as their quote / PO.
create or replace function check_quote_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select req from quotes where id = new.quote) is distinct from (select req from req_lines where id = new.line) then
    raise exception 'This item is not part of the quoted requisition';
  end if;
  return new;
end $$;
drop trigger if exists quote_line_check on quote_lines;
create trigger quote_line_check before insert or update on quote_lines for each row execute function check_quote_line();

-- PO lines: same requisition, and the quantity rule after approval
-- (procurement manager alone up to 10%; more than that needs Ajay, Ravi or Raunak).
create or replace function check_po_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select req from purchase_orders where id = new.po) is distinct from (select req from req_lines where id = new.line) then
    raise exception 'This item is not part of the PO''s requisition';
  end if;
  if tg_op = 'INSERT' then
    new.approved_qty := new.qty;
  else
    new.approved_qty := old.approved_qty;
    if auth.uid() is not null and new.qty <> old.qty
       and abs(new.qty - old.approved_qty) > 0.10 * old.approved_qty
       and not (acts_as('ajay') or acts_as('ravi') or acts_as('raunak') or my_role() = 'admin') then
      raise exception 'A change of more than 10%% needs Ajay, Ravi or Raunak';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists po_line_check on po_lines;
create trigger po_line_check before insert or update on po_lines for each row execute function check_po_line();

-- ===================================================================
-- 5. Reject PIN (checked inside the database, never sent back to the app)
-- ===================================================================

-- Set or change my own PIN. Changing an existing PIN needs the old one.
create or replace function set_my_pin(p_new text, p_old text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  if my_role() not in ('ajay','ravi','raunak','admin') then raise exception 'Only approvers have a PIN'; end if;
  if p_new !~ '^[0-9]{4}$' then raise exception 'PIN must be 4 digits'; end if;
  select pin_hash into h from pins where person = auth.uid();
  if h is not null and (p_old is null or crypt(p_old, h) <> h) then
    raise exception 'Old PIN is wrong';
  end if;
  insert into pins (person, pin_hash) values (auth.uid(), crypt(p_new, gen_salt('bf', 10)))
  on conflict (person) do update set pin_hash = excluded.pin_hash, failed = 0, locked_until = null;
end $$;

-- Admin or Raunak can clear someone's forgotten PIN so they can set a new one.
create or replace function reset_pin(p_person uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_boss() then raise exception 'Not allowed'; end if;
  delete from pins where person = p_person;
end $$;

-- Reject a requisition. Answers 'rejected', 'wrong_pin' or 'locked'.
-- 5 wrong PINs in a row lock rejecting for that person for 15 minutes.
create or replace function reject_requisition(p_req uuid, p_pin text, p_remarks text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare p pins; st text;
begin
  select stage into st from requisitions where id = p_req;
  if st is null then raise exception 'Requisition not found'; end if;
  if not (my_role() = 'admin'
          or (st = 'ravi_ok' and acts_as('ravi'))
          or (st = 'ajay_ok' and acts_as('ajay'))
          or (st in ('quotes','final','issue') and acts_as('raunak'))) then
    raise exception 'You cannot reject this requisition at this step';
  end if;
  if coalesce(trim(p_remarks), '') = '' then raise exception 'Please give a reason'; end if;

  select * into p from pins where person = auth.uid() for update;
  if p.person is null then raise exception 'Set your PIN first'; end if;
  if p.locked_until > now() then return 'locked'; end if;
  if crypt(coalesce(p_pin, ''), p.pin_hash) <> p.pin_hash then
    update pins set failed = failed + 1,
      locked_until = case when failed + 1 >= 5 then now() + interval '15 minutes' end
    where person = auth.uid();
    return 'wrong_pin';
  end if;
  update pins set failed = 0, locked_until = null where person = auth.uid();

  perform set_config('app.via_reject', 'on', true);
  update requisitions set stage = 'rejected', return_to = null, remarks = p_remarks where id = p_req;
  perform set_config('app.via_reject', '', true);
  return 'rejected';
end $$;

revoke all on function set_my_pin(text, text) from public, anon;
revoke all on function reset_pin(uuid) from public, anon;
revoke all on function reject_requisition(uuid, text, text) from public, anon;
grant execute on function set_my_pin(text, text), reset_pin(uuid), reject_requisition(uuid, text, text) to authenticated;

-- ===================================================================
-- 6. Security rules (row-level security)
-- ===================================================================
-- Nobody sees anything without signing in. Every table below has separate
-- read / add / change / delete rules.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

do $$
declare t text;
begin
  foreach t in array array['sites','companies','site_companies','people','pins','delegations','categories',
    'units','areas','items','vendors','vendor_aliases','requisitions','req_lines','quotes','quote_lines',
    'awards','purchase_orders','po_lines','receipts','rate_lists','rate_rows','contract_map','stock_moves',
    'activity','outbox','counters']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_add', t);
    execute format('drop policy if exists %I on %I', t || '_change', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
  end loop;
end $$;

-- pins and counters: no rules at all, so the app can never read or change them.
revoke all on pins, counters from authenticated;

-- Sites and billing companies: everyone reads; only Raunak/admin change.
create policy sites_read on sites for select to authenticated using (my_role() is not null);
create policy sites_add on sites for insert to authenticated with check (is_boss());
create policy sites_change on sites for update to authenticated using (is_boss()) with check (is_boss());
create policy sites_delete on sites for delete to authenticated using (is_boss());

create policy companies_read on companies for select to authenticated using (my_role() is not null);
create policy companies_add on companies for insert to authenticated with check (is_boss());
create policy companies_change on companies for update to authenticated using (is_boss()) with check (is_boss());
create policy companies_delete on companies for delete to authenticated using (is_boss());

create policy site_companies_read on site_companies for select to authenticated using (my_role() is not null);
create policy site_companies_add on site_companies for insert to authenticated with check (is_boss());
create policy site_companies_delete on site_companies for delete to authenticated using (is_boss());

-- People: you see your own full record; Raunak/admin see everyone's.
-- Everyone else uses the people_directory view (names and roles only, no mobile numbers).
create policy people_read on people for select to authenticated
  using (id = auth.uid() or is_boss());
create policy people_add on people for insert to authenticated
  with check (is_boss() and (my_role() = 'admin' or role not in ('admin','raunak')));
create policy people_change on people for update to authenticated
  using (is_boss() and (my_role() = 'admin' or role not in ('admin','raunak')))
  with check (is_boss() and (my_role() = 'admin' or role not in ('admin','raunak')));
create policy people_delete on people for delete to authenticated
  using (my_role() = 'admin' and id <> auth.uid());

create or replace view people_directory as
  select id, name, role, site, active from people where my_role() is not null;
revoke all on people_directory from anon;
grant select on people_directory to authenticated;

create or replace function is_trio_person(p_person uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from people where id = p_person and role in ('ajay','ravi','raunak') and active)
$$;

-- Delegation: Ajay, Ravi or Raunak hand their own approval right to another of the three.
create policy delegations_read on delegations for select to authenticated using (is_office());
create policy delegations_add on delegations for insert to authenticated with check (
  (from_role = my_role() or my_role() = 'admin')
  and is_trio_person(to_person));
create policy delegations_change on delegations for update to authenticated
  using (from_role = my_role() or my_role() = 'admin')
  with check ((from_role = my_role() or my_role() = 'admin')
    and is_trio_person(to_person));
create policy delegations_delete on delegations for delete to authenticated
  using (from_role = my_role() or my_role() = 'admin');

-- Categories, units, items: everyone reads and can add new ones (they are learned from
-- requisitions). Only the office changes or removes them; only Raunak/admin approve areas.
create policy categories_read on categories for select to authenticated using (my_role() is not null);
create policy categories_add on categories for insert to authenticated with check (my_role() is not null);
create policy categories_change on categories for update to authenticated using (is_buyer()) with check (is_buyer());
create policy categories_delete on categories for delete to authenticated using (is_boss());

create policy units_read on units for select to authenticated using (my_role() is not null);
create policy units_add on units for insert to authenticated with check (my_role() is not null and not permanent);
create policy units_change on units for update to authenticated using (is_buyer()) with check (is_buyer());
create policy units_delete on units for delete to authenticated using (is_boss() and not permanent);

create policy areas_read on areas for select to authenticated
  using (is_office() or site = my_site());
create policy areas_add on areas for insert to authenticated
  with check ((is_office() or site = my_site()) and (not approved or is_boss()));
create policy areas_change on areas for update to authenticated using (is_boss()) with check (is_boss());
create policy areas_delete on areas for delete to authenticated using (is_boss());

create policy items_read on items for select to authenticated using (my_role() is not null);
create policy items_add on items for insert to authenticated with check (my_role() is not null);
create policy items_change on items for update to authenticated using (is_buyer()) with check (is_buyer());
create policy items_delete on items for delete to authenticated using (is_boss());

-- Vendors, rate lists and quotes: office only. Storekeepers cannot see prices or vendors.
create policy vendors_read on vendors for select to authenticated using (is_office());
create policy vendors_add on vendors for insert to authenticated with check (is_buyer());
create policy vendors_change on vendors for update to authenticated using (is_buyer()) with check (is_buyer());
create policy vendors_delete on vendors for delete to authenticated using (is_boss());

create policy vendor_aliases_read on vendor_aliases for select to authenticated using (is_office());
create policy vendor_aliases_add on vendor_aliases for insert to authenticated with check (is_buyer());
create policy vendor_aliases_change on vendor_aliases for update to authenticated using (is_buyer()) with check (is_buyer());
create policy vendor_aliases_delete on vendor_aliases for delete to authenticated using (is_buyer());

create policy rate_lists_read on rate_lists for select to authenticated using (is_office());
create policy rate_lists_add on rate_lists for insert to authenticated with check (is_buyer());
create policy rate_lists_change on rate_lists for update to authenticated using (is_buyer()) with check (is_buyer());
create policy rate_lists_delete on rate_lists for delete to authenticated using (is_boss());

create policy rate_rows_read on rate_rows for select to authenticated using (is_office());
create policy rate_rows_add on rate_rows for insert to authenticated with check (is_buyer());
create policy rate_rows_change on rate_rows for update to authenticated using (is_buyer()) with check (is_buyer());
create policy rate_rows_delete on rate_rows for delete to authenticated using (is_buyer());

create policy contract_map_read on contract_map for select to authenticated using (is_office());
create policy contract_map_add on contract_map for insert to authenticated with check (is_buyer());
create policy contract_map_change on contract_map for update to authenticated using (is_buyer()) with check (is_buyer());
create policy contract_map_delete on contract_map for delete to authenticated using (is_buyer());

-- Requisitions: storekeepers see and raise only their own site's; the office sees all.
-- Which step it may move to is checked by the workflow rules above.
create policy requisitions_read on requisitions for select to authenticated
  using (is_office() or (my_role() = 'store' and site = my_site()));
create policy requisitions_add on requisitions for insert to authenticated
  with check (raised_by = auth.uid() and (is_office() or (my_role() = 'store' and site = my_site())));
create policy requisitions_change on requisitions for update to authenticated
  using (is_office() or store_can_edit(id))
  with check (is_office() or (my_role() = 'store' and site = my_site()));
create policy requisitions_delete on requisitions for delete to authenticated using (my_role() = 'admin');

-- Requisition items: storekeepers only while waiting for the first approval or when sent back.
-- In the office: Ajay, Ravi, Raunak, the procurement manager and admin may edit.
create policy req_lines_read on req_lines for select to authenticated
  using (is_office() or req_site(req) = my_site());
create policy req_lines_add on req_lines for insert to authenticated
  with check (is_office() or store_can_edit(req));
create policy req_lines_change on req_lines for update to authenticated
  using (is_office() or store_can_edit(req))
  with check (is_office() or store_can_edit(req));
create policy req_lines_delete on req_lines for delete to authenticated
  using (is_office() or store_can_edit(req));

create policy quotes_read on quotes for select to authenticated using (is_office());
create policy quotes_add on quotes for insert to authenticated with check (is_buyer());
create policy quotes_change on quotes for update to authenticated using (is_buyer()) with check (is_buyer());
create policy quotes_delete on quotes for delete to authenticated using (is_buyer());

create policy quote_lines_read on quote_lines for select to authenticated using (is_office());
create policy quote_lines_add on quote_lines for insert to authenticated with check (is_buyer());
create policy quote_lines_change on quote_lines for update to authenticated using (is_buyer()) with check (is_buyer());
create policy quote_lines_delete on quote_lines for delete to authenticated using (is_buyer());

-- Awards (which vendor gets each item): Raunak, or the procurement manager when Raunak let
-- them decide or it is a small order.
create policy awards_read on awards for select to authenticated using (is_office());
create policy awards_add on awards for insert to authenticated with check (
  acts_as('raunak') or my_role() = 'admin'
  or (my_role() = 'pm' and exists (select 1 from requisitions r where r.id = req and (r.pm_decides or r.small_order))));
create policy awards_change on awards for update to authenticated using (
  acts_as('raunak') or my_role() = 'admin'
  or (my_role() = 'pm' and exists (select 1 from requisitions r where r.id = req and (r.pm_decides or r.small_order))))
  with check (
  acts_as('raunak') or my_role() = 'admin'
  or (my_role() = 'pm' and exists (select 1 from requisitions r where r.id = req and (r.pm_decides or r.small_order))));
create policy awards_delete on awards for delete to authenticated using (acts_as('raunak') or my_role() = 'admin');

-- Purchase orders: issued by the procurement manager (or Raunak/admin).
-- Storekeepers see their own site's PO headers (number, vendor id, status) for receiving goods,
-- but not the PO lines with rates. They use the store_po_lines view instead.
create policy purchase_orders_read on purchase_orders for select to authenticated
  using (is_office() or req_site(req) = my_site());
create policy purchase_orders_add on purchase_orders for insert to authenticated with check (is_buyer());
create policy purchase_orders_change on purchase_orders for update to authenticated using (is_buyer()) with check (is_buyer());
create policy purchase_orders_delete on purchase_orders for delete to authenticated using (is_boss());

create policy po_lines_read on po_lines for select to authenticated using (is_office());
create policy po_lines_add on po_lines for insert to authenticated with check (is_buyer());
create policy po_lines_change on po_lines for update to authenticated
  using (is_buyer() or acts_as('ajay') or acts_as('ravi'))
  with check (is_buyer() or acts_as('ajay') or acts_as('ravi'));
create policy po_lines_delete on po_lines for delete to authenticated using (is_boss());

-- What a storekeeper sees when receiving: item, quantity ordered and received so far. No rates.
create or replace view store_po_lines as
  select pl.id as po_line, po.id as po, po.number as po_number, po.status, r.site, r.number as req_number,
         v.name as vendor_name, rl.name as item, rl.unit, pl.qty as ordered,
         coalesce((select sum(x.qty) from receipts x where x.po_line = pl.id), 0) as received
  from po_lines pl
  join purchase_orders po on po.id = pl.po
  join requisitions r on r.id = po.req
  join req_lines rl on rl.id = pl.line
  join vendors v on v.id = po.vendor
  where is_office() or (my_role() = 'store' and r.site = my_site());
revoke all on store_po_lines from anon;
grant select on store_po_lines to authenticated;

-- Receipts: recorded once by the storekeeper of that site (or the office); only admin corrects.
create or replace function po_line_site(p_line uuid) returns text
language sql stable security definer set search_path = public as $$
  select r.site from po_lines pl join purchase_orders po on po.id = pl.po
  join requisitions r on r.id = po.req where pl.id = p_line
$$;
create policy receipts_read on receipts for select to authenticated
  using (is_office() or po_line_site(po_line) = my_site());
create policy receipts_add on receipts for insert to authenticated
  with check (received_by = auth.uid() and (is_office() or (my_role() = 'store' and po_line_site(po_line) = my_site())));
create policy receipts_change on receipts for update to authenticated using (my_role() = 'admin') with check (my_role() = 'admin');
create policy receipts_delete on receipts for delete to authenticated using (my_role() = 'admin');

-- Stock in hand: storekeepers record and see their own site's movements; only admin corrects.
create policy stock_moves_read on stock_moves for select to authenticated
  using (is_office() or site = my_site());
create policy stock_moves_add on stock_moves for insert to authenticated
  with check (by_person = auth.uid() and (is_office() or site = my_site()));
create policy stock_moves_change on stock_moves for update to authenticated using (my_role() = 'admin') with check (my_role() = 'admin');
create policy stock_moves_delete on stock_moves for delete to authenticated using (my_role() = 'admin');

-- Audit trail: add-only. Storekeepers see the history of their own site's requisitions.
create policy activity_read on activity for select to authenticated
  using (is_office() or (req is not null and req_site(req) = my_site()));
create policy activity_add on activity for insert to authenticated
  with check (my_role() is not null and who = auth.uid());

-- WhatsApp outbox: the app can queue a message; only the server sends and updates them.
create policy outbox_read on outbox for select to authenticated using (is_boss());
create policy outbox_add on outbox for insert to authenticated with check (my_role() is not null and status = 'queued');

-- ===================================================================
-- 7. File storage (private)
-- ===================================================================
-- Files are stored as  <SITE>/<folder>/<file>, for example  JAI/photos/abc.jpg
--   photos : item photos from requisitions  (storekeeper of that site can add and see)
--   quotes : vendor quotations              (office only)
--   po     : purchase order PDFs            (office only)
--   ratelists : brand price lists           (office only)

insert into storage.buckets (id, name, public) values ('files', 'files', false) on conflict (id) do nothing;

drop policy if exists files_signed_in on storage.objects;
drop policy if exists files_read on storage.objects;
drop policy if exists files_add on storage.objects;
drop policy if exists files_change on storage.objects;
drop policy if exists files_delete on storage.objects;

create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'files' and (
    is_office()
    or (my_role() = 'store' and (storage.foldername(name))[1] = my_site() and (storage.foldername(name))[2] = 'photos')));
create policy files_add on storage.objects for insert to authenticated with check (
  bucket_id = 'files' and (storage.foldername(name))[1] in (select code from sites) and (
    ((storage.foldername(name))[2] in ('quotes','po','ratelists') and is_buyer())
    or ((storage.foldername(name))[2] = 'photos'
        and (is_office() or (my_role() = 'store' and (storage.foldername(name))[1] = my_site())))));
create policy files_change on storage.objects for update to authenticated
  using (bucket_id = 'files' and is_buyer()) with check (bucket_id = 'files' and is_buyer());
create policy files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'files' and is_boss());

-- ===================================================================
-- 8. Starting data
-- ===================================================================

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
