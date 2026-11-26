-- Kailasha Group requisition website: update 002 (table access for signed-in people).
-- Paste all of this into Supabase > SQL Editor > New query, then press Run. Running it again does no harm.
--
-- Newer Supabase projects do not give signed-in users access to tables by default.
-- This gives signed-in people the basic right to use the tables. The row-level security rules
-- from setup.sql and update 001 still decide exactly which rows each person may see or change.

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Never reachable from the website: PIN hashes and the number counters.
revoke all on pins, counters from authenticated;

-- The two views are read-only.
revoke all on people_directory, store_po_lines from authenticated;
grant select on people_directory, store_po_lines to authenticated;

-- Nothing at all for people who are not signed in.
revoke all on all tables in schema public from anon;

-- Tables added by later updates get the same basic access.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;

-- Check: this should say true, true, false.
select has_table_privilege('authenticated', 'requisitions', 'select') as can_read_requisitions,
       has_table_privilege('authenticated', 'sites', 'select') as can_read_sites,
       has_table_privilege('authenticated', 'pins', 'select') as can_read_pins;
