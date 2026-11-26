-- Kailasha Group requisition website: update 001 (live website and logins).
-- Run this ONCE, after setup.sql. Paste all of it into Supabase > SQL Editor > New query, then press Run.
-- Running it a second time does no harm.
--
-- What it adds:
--   1. Logins by mobile number + password (no SMS provider needed). People are added with add_person().
--   2. A few extra columns and tables the website needs (stock items, quantity-change requests, settings).
--   3. Small rule fixes found while connecting the website:
--      - Raunak can send a requisition back to the procurement manager for more quotes (final -> quotes).
--      - Storekeepers (and approvers) can okay closing a PO and record when it is fully received,
--        but they still cannot change its vendor, company or rates.
--      - The procurement manager and approvers can see the WhatsApp outbox.
--      - Ravi sees only Kaveri Agro, unless Ajay or Raunak has handed approvals to him.
--   4. Two helper functions the website uses to save changes safely (app_update, app_delete).

create extension if not exists pgcrypto with schema extensions;

-- ===================================================================
-- 1. Extra columns
-- ===================================================================
-- "extra" holds the website's details that the security rules do not depend on
-- (remarks, notes, item descriptions on PO lines, and so on).

alter table requisitions    add column if not exists extra jsonb not null default '{}';
alter table req_lines       add column if not exists extra jsonb not null default '{}';
alter table quotes          add column if not exists extra jsonb not null default '{}';
alter table purchase_orders add column if not exists extra jsonb not null default '{}';
alter table po_lines        add column if not exists extra jsonb not null default '{}';
alter table receipts        add column if not exists extra jsonb not null default '{}';
alter table vendors         add column if not exists extra jsonb not null default '{}';
alter table items           add column if not exists extra jsonb not null default '{}';
alter table rate_lists      add column if not exists extra jsonb not null default '{}';
alter table contract_map    add column if not exists extra jsonb not null default '{}';
alter table vendor_aliases  add column if not exists item_name text;
alter table activity        add column if not exists ref text;

-- PO status: 'done' = everything received.
alter table purchase_orders drop constraint if exists purchase_orders_status_check;
alter table purchase_orders add constraint purchase_orders_status_check
  check (status in ('open','done','closed','cancelled'));

-- WhatsApp outbox: who it is for (people and/or a vendor), and what kind of message.
alter table outbox alter column to_mobile drop not null;
alter table outbox add column if not exists to_names text;
alter table outbox add column if not exists to_people uuid[] not null default '{}';
alter table outbox add column if not exists kind text;
alter table outbox add column if not exists created_at timestamptz not null default now();
alter table outbox add column if not exists created_by uuid references people default auth.uid();

-- ===================================================================
-- 2. New tables
-- ===================================================================

-- Stock items per site (with their own barcode). Quantity in hand = sum of stock_moves.
create table if not exists stock_items (
  id uuid primary key default gen_random_uuid(),
  site text not null references sites,
  name text not null, unit text, barcode text,
  extra jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (site, barcode)
);
alter table stock_moves alter column item drop not null;
alter table stock_moves add column if not exists stock_item uuid references stock_items on delete cascade;
alter table stock_moves add column if not exists extra jsonb not null default '{}';
alter table stock_moves drop constraint if exists stock_moves_kind_check;
alter table stock_moves add constraint stock_moves_kind_check check (kind in ('opening','in','issue','return'));
create index if not exists stock_moves_stock_item_idx on stock_moves (stock_item);

-- Quantity change requests on a PO (storekeeper asks; procurement manager / approver decides).
create table if not exists qty_requests (
  id uuid primary key default gen_random_uuid(),
  po uuid not null references purchase_orders on delete cascade,
  status text not null default 'pm' check (status in ('pm','trio','approved','declined')),
  created_by uuid references people default auth.uid(),
  created_at timestamptz not null default now(),
  extra jsonb not null default '{}'
);
create index if not exists qty_requests_po_idx on qty_requests (po);

-- Small shared settings: PO terms, area suggestions, learned categories.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null default 'null',
  updated_at timestamptz not null default now()
);
insert into app_settings (key, value) values
  ('terms', '["Rates are inclusive of loading and delivery to site unless stated.","Material must match the brand and specification in this order.","Delivery challan must quote this PO number.","Payment as per agreed terms after receipt and checking at site.","Kailasha Group may reject material that does not meet the specification."]'),
  ('areaCounts', '{}'), ('areaDismissed', '[]'), ('catHistory', '{}')
on conflict (key) do nothing;

revoke all on stock_items, qty_requests, app_settings from anon;
grant select, insert, update, delete on stock_items, qty_requests, app_settings to authenticated;

-- ===================================================================
-- 3. Rule fixes
-- ===================================================================

-- Same as setup.sql, plus: Raunak (or whoever holds his approvals) can send 'final' back to 'quotes'.
create or replace function check_req_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := my_role();
begin
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
      elsif old.stage = 'final' and new.stage = 'quotes' and acts_as('raunak') then null;
      elsif old.stage = 'issue' and new.stage = 'approved' and (r = 'pm' or acts_as('raunak')) then null;
      elsif old.stage = 'approved' and new.stage = 'closed'
            and (r = 'pm' or acts_as('raunak') or acts_as('ajay') or acts_as('ravi')) then null;
      else raise exception 'You cannot move this requisition from % to %', old.stage, new.stage; end if;
    end if;
  end if;
  return new;
end $$;

-- POs: people other than the buyers may only change the status and notes (closing, fully received).
create or replace function check_po_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or is_buyer() then return new; end if;
  if new.req <> old.req or new.vendor <> old.vendor or new.company is distinct from old.company
     or new.number <> old.number or new.award_by is distinct from old.award_by
     or new.issued_by is distinct from old.issued_by then
    raise exception 'Only the procurement manager can change this purchase order';
  end if;
  if new.status not in ('open','done','closed') then raise exception 'Not allowed'; end if;
  return new;
end $$;
drop trigger if exists po_rules on purchase_orders;
create trigger po_rules before update on purchase_orders for each row execute function check_po_change();

create or replace function po_site(p_po uuid) returns text
language sql stable security definer set search_path = public as $$
  select r.site from purchase_orders po join requisitions r on r.id = po.req where po.id = p_po
$$;

-- ===================================================================
-- 4. Security rules for the new and changed tables
-- ===================================================================

alter table stock_items enable row level security;
alter table qty_requests enable row level security;
alter table app_settings enable row level security;

drop policy if exists purchase_orders_status_change on purchase_orders;
create policy purchase_orders_status_change on purchase_orders for update to authenticated
  using (is_office() or (my_role() = 'store' and req_site(req) = my_site()))
  with check (is_office() or (my_role() = 'store' and req_site(req) = my_site()));

drop policy if exists stock_items_read on stock_items;
drop policy if exists stock_items_add on stock_items;
drop policy if exists stock_items_change on stock_items;
drop policy if exists stock_items_delete on stock_items;
create policy stock_items_read on stock_items for select to authenticated using (is_office() or site = my_site());
create policy stock_items_add on stock_items for insert to authenticated with check (is_office() or site = my_site());
create policy stock_items_change on stock_items for update to authenticated
  using (is_office() or site = my_site()) with check (is_office() or site = my_site());
create policy stock_items_delete on stock_items for delete to authenticated using (my_role() = 'admin');

drop policy if exists qty_requests_read on qty_requests;
drop policy if exists qty_requests_add on qty_requests;
drop policy if exists qty_requests_change on qty_requests;
drop policy if exists qty_requests_delete on qty_requests;
create policy qty_requests_read on qty_requests for select to authenticated
  using (is_office() or po_site(po) = my_site());
create policy qty_requests_add on qty_requests for insert to authenticated
  with check (is_office() or (my_role() = 'store' and po_site(po) = my_site()));
create policy qty_requests_change on qty_requests for update to authenticated
  using (is_office()) with check (is_office());
create policy qty_requests_delete on qty_requests for delete to authenticated using (my_role() = 'admin');

drop policy if exists app_settings_read on app_settings;
drop policy if exists app_settings_add on app_settings;
drop policy if exists app_settings_change on app_settings;
create policy app_settings_read on app_settings for select to authenticated using (my_role() is not null);
create policy app_settings_add on app_settings for insert to authenticated with check (is_boss());
create policy app_settings_change on app_settings for update to authenticated
  using (is_boss() or (key in ('areaCounts','catHistory') and my_role() is not null))
  with check (is_boss() or (key in ('areaCounts','catHistory') and my_role() is not null));

drop policy if exists outbox_read on outbox;
create policy outbox_read on outbox for select to authenticated using (is_office());

-- Ravi sees only Kaveri Agro (manufacturing), except while Ajay or Raunak has handed approvals to him.
-- Storekeepers see only their own site. Everyone else in the office sees every site.
create or replace function sees_site(p_site text) returns boolean
language sql stable security definer set search_path = public as $$
  select my_role() is not null and coalesce(case my_role()
    when 'store' then p_site = my_site()
    when 'ravi' then exists (select 1 from sites where code = p_site and kind = 'mfg') or acts_as('ajay') or acts_as('raunak')
    else true end, false)
$$;
create or replace function quote_site(p_quote uuid) returns text
language sql stable security definer set search_path = public as $$
  select r.site from quotes q join requisitions r on r.id = q.req where q.id = p_quote
$$;

drop policy if exists requisitions_read on requisitions;
create policy requisitions_read on requisitions for select to authenticated using (sees_site(site));
drop policy if exists requisitions_change on requisitions;
create policy requisitions_change on requisitions for update to authenticated
  using ((is_office() and sees_site(site)) or store_can_edit(id))
  with check (is_office() or (my_role() = 'store' and site = my_site()));
drop policy if exists req_lines_read on req_lines;
create policy req_lines_read on req_lines for select to authenticated using (sees_site(req_site(req)));
drop policy if exists req_lines_change on req_lines;
create policy req_lines_change on req_lines for update to authenticated
  using ((is_office() and sees_site(req_site(req))) or store_can_edit(req))
  with check (is_office() or store_can_edit(req));
drop policy if exists quotes_read on quotes;
create policy quotes_read on quotes for select to authenticated using (is_office() and sees_site(req_site(req)));
drop policy if exists quote_lines_read on quote_lines;
create policy quote_lines_read on quote_lines for select to authenticated using (is_office() and sees_site(quote_site(quote)));
drop policy if exists awards_read on awards;
create policy awards_read on awards for select to authenticated using (is_office() and sees_site(req_site(req)));
drop policy if exists purchase_orders_read on purchase_orders;
create policy purchase_orders_read on purchase_orders for select to authenticated using (sees_site(req_site(req)));
drop policy if exists purchase_orders_status_change on purchase_orders;
create policy purchase_orders_status_change on purchase_orders for update to authenticated
  using (sees_site(req_site(req))) with check (sees_site(req_site(req)));
drop policy if exists po_lines_read on po_lines;
create policy po_lines_read on po_lines for select to authenticated using (is_office() and sees_site(po_site(po)));
drop policy if exists receipts_read on receipts;
create policy receipts_read on receipts for select to authenticated using (sees_site(po_line_site(po_line)));
drop policy if exists stock_moves_read on stock_moves;
create policy stock_moves_read on stock_moves for select to authenticated using (sees_site(site));
drop policy if exists stock_items_read on stock_items;
create policy stock_items_read on stock_items for select to authenticated using (sees_site(site));
drop policy if exists qty_requests_read on qty_requests;
create policy qty_requests_read on qty_requests for select to authenticated using (sees_site(po_site(po)));
drop policy if exists activity_read on activity;
create policy activity_read on activity for select to authenticated
  using ((req is not null and sees_site(req_site(req))) or (req is null and is_office() and my_role() <> 'ravi'));
drop policy if exists files_read on storage.objects;
create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'files' and sees_site((storage.foldername(name))[1]) and (
    is_office() or (storage.foldername(name))[2] = 'photos'));

-- What a storekeeper sees when receiving: now also the line's description and its requisition item.
create or replace view store_po_lines as
  select pl.id as po_line, po.id as po, po.number as po_number, po.status, r.site, r.number as req_number,
         v.name as vendor_name, rl.name as item, rl.unit, pl.qty as ordered,
         coalesce((select sum(x.qty) from receipts x where x.po_line = pl.id), 0) as received,
         pl.line as req_line, pl.extra as line_extra, po.vendor as vendor
  from po_lines pl
  join purchase_orders po on po.id = pl.po
  join requisitions r on r.id = po.req
  join req_lines rl on rl.id = pl.line
  join vendors v on v.id = po.vendor
  where sees_site(r.site);
revoke all on store_po_lines from anon;
grant select on store_po_lines to authenticated;

-- ===================================================================
-- 5. Saving changes from the website
-- ===================================================================
-- Update one row, changing only the given columns, and merging (not replacing) the "extra" details,
-- so two people working on the same requisition do not overwrite each other's notes.
-- Runs with the caller's own rights, so every security rule above still applies.
create or replace function app_update(p_table text, p_key jsonb, p_set jsonb,
                                      p_extra jsonb default '{}', p_drop text[] default '{}')
returns void language plpgsql security invoker set search_path = public as $$
declare sets text := ''; wh text := ''; k text; n int;
begin
  if p_table not in ('requisitions','req_lines','quotes','quote_lines','awards','purchase_orders','po_lines',
      'vendors','vendor_aliases','items','categories','units','areas','rate_lists','contract_map',
      'stock_items','qty_requests','delegations','app_settings','sites','companies','people') then
    raise exception 'Unknown table %', p_table;
  end if;
  for k in select jsonb_object_keys(p_set) loop
    sets := sets || format('%I = (jsonb_populate_record(null::%I, $2)).%I, ', k, p_table, k);
  end loop;
  if coalesce(p_extra, '{}') <> '{}'::jsonb or coalesce(cardinality(p_drop), 0) > 0 then
    sets := sets || 'extra = (coalesce(extra, ''{}''::jsonb) - $4) || coalesce($3, ''{}''::jsonb), ';
  end if;
  if sets = '' then return; end if;
  sets := left(sets, length(sets) - 2);
  for k in select jsonb_object_keys(p_key) loop
    wh := wh || format(' and %I = (jsonb_populate_record(null::%I, $1)).%I', k, p_table, k);
  end loop;
  if wh = '' then raise exception 'No row given'; end if;
  execute format('update %I set %s where true%s', p_table, sets, wh) using p_key, p_set, p_extra, p_drop;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'You are not allowed to change this, or it was removed' using errcode = '42501';
  end if;
end $$;

create or replace function app_delete(p_table text, p_key jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare wh text := ''; k text;
begin
  if p_table not in ('req_lines','quotes','quote_lines','awards','po_lines','vendors','vendor_aliases',
      'items','categories','units','areas','rate_lists','contract_map','delegations','site_companies','companies') then
    raise exception 'Unknown table %', p_table;
  end if;
  for k in select jsonb_object_keys(p_key) loop
    wh := wh || format(' and %I = (jsonb_populate_record(null::%I, $1)).%I', k, p_table, k);
  end loop;
  if wh = '' then raise exception 'No row given'; end if;
  execute format('delete from %I where true%s', p_table, wh) using p_key;
end $$;

revoke all on function app_update(text, jsonb, jsonb, jsonb, text[]) from public, anon;
revoke all on function app_delete(text, jsonb) from public, anon;
grant execute on function app_update(text, jsonb, jsonb, jsonb, text[]), app_delete(text, jsonb) to authenticated;

-- ===================================================================
-- 6. Logins: mobile number + password
-- ===================================================================
-- Supabase needs an e-mail-style login name, so each mobile number gets a private one:
--   9876543210  ->  9876543210@phone.kailasha.local
-- Nothing is ever e-mailed to it. People only ever type their mobile number.

create or replace function login_email(p_mobile text) returns text
language sql immutable as $$ select p_mobile || '@phone.kailasha.local' $$;

-- Add a person who can log in.
--   From the website: Raunak (or admin) only. Raunak and admin accounts can only be made here in the SQL Editor.
--   Role is one of: store, pm, ajay, ravi, raunak, admin. Site (JAI, MAT, TAL, KAL) only for storekeepers.
create or replace function add_person(p_name text, p_mobile text, p_role text, p_site text, p_password text)
returns uuid language plpgsql security definer set search_path = public, extensions, auth as $$
declare new_id uuid := gen_random_uuid(); em text; c record;
begin
  if auth.uid() is not null then
    if not is_boss() then raise exception 'Only Raunak can add people'; end if;
    if p_role in ('admin','raunak') and my_role() <> 'admin' then
      raise exception 'This role can only be added from the Supabase SQL Editor';
    end if;
  end if;
  p_name := trim(coalesce(p_name, ''));
  p_mobile := regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g');
  if length(p_mobile) = 12 and left(p_mobile, 2) = '91' then p_mobile := substr(p_mobile, 3); end if;
  if p_name = '' then raise exception 'Add the person''s name'; end if;
  if p_mobile !~ '^[0-9]{10}$' then raise exception 'The mobile number must have 10 digits'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'The password must have at least 6 characters'; end if;
  if p_role not in ('store','pm','ajay','ravi','raunak','admin') then raise exception 'Unknown role %', p_role; end if;
  if p_role = 'store' then
    if not exists (select 1 from sites where code = p_site) then raise exception 'Choose the storekeeper''s site'; end if;
  else
    p_site := null;
  end if;
  em := login_email(p_mobile);
  if exists (select 1 from people where mobile = p_mobile) or exists (select 1 from auth.users where email = em) then
    raise exception 'Someone already uses this mobile number';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', new_id, 'authenticated', 'authenticated', em,
          crypt(p_password, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', jsonb_build_object('name', p_name), now(), now());
  -- Supabase's login service expects these text columns to be empty rather than missing.
  for c in select column_name from information_schema.columns
           where table_schema = 'auth' and table_name = 'users'
             and column_name in ('confirmation_token','recovery_token','email_change_token_new','email_change',
                                 'email_change_token_current','phone_change','phone_change_token','reauthentication_token')
  loop
    execute format('update auth.users set %I = coalesce(%I, '''') where id = $1', c.column_name, c.column_name) using new_id;
  end loop;
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (new_id::text, new_id,
          jsonb_build_object('sub', new_id::text, 'email', em, 'email_verified', true, 'phone_verified', false),
          'email', now(), now(), now());

  insert into people (id, name, mobile, role, site) values (new_id, p_name, p_mobile, p_role, p_site);
  return new_id;
end $$;

-- Give someone a new password (when they forget it). Raunak or admin only.
create or replace function set_person_password(p_person uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions, auth as $$
declare target_role text;
begin
  select role into target_role from people where id = p_person;
  if target_role is null then raise exception 'Person not found'; end if;
  if auth.uid() is not null then
    if not is_boss() then raise exception 'Only Raunak can reset passwords'; end if;
    if target_role = 'admin' and my_role() <> 'admin' then raise exception 'Not allowed'; end if;
  end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'The password must have at least 6 characters'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_person;
end $$;

revoke all on function add_person(text, text, text, text, text) from public, anon;
revoke all on function set_person_password(uuid, text) from public, anon;
grant execute on function add_person(text, text, text, text, text), set_person_password(uuid, text) to authenticated;

-- Final check: this should show 4 sites and 4 settings.
select (select count(*) from sites) as sites, (select count(*) from app_settings) as settings;

-- ===================================================================
-- AFTER RUNNING THE ABOVE: create your own login (one time)
-- ===================================================================
-- In a NEW query, paste the line below, put in your mobile number and a starting password
-- (at least 6 characters), and press Run. Then log in on the website and change the password
-- under "My account".
--
--   select add_person('Raunak', '98XXXXXXXX', 'raunak', null, 'your-starting-password');
--
-- Everyone else can then be added from the website: Settings > People > Add person.
