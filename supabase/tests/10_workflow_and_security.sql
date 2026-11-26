\set ON_ERROR_STOP 0
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'),('00000000-0000-0000-0000-00000000000b'),('00000000-0000-0000-0000-00000000000c'),('00000000-0000-0000-0000-00000000000d'),('00000000-0000-0000-0000-00000000000e'),('00000000-0000-0000-0000-00000000000f'),('00000000-0000-0000-0000-000000000010');
insert into people(id,name,mobile,role,site) values
('00000000-0000-0000-0000-00000000000a','Admin','9000000001','admin',null),
('00000000-0000-0000-0000-00000000000b','Ravi','9000000002','ravi',null),
('00000000-0000-0000-0000-00000000000c','Ajay','9000000003','ajay',null),
('00000000-0000-0000-0000-00000000000d','Raunak','9000000004','raunak',null),
('00000000-0000-0000-0000-00000000000e','PM','9000000005','pm',null),
('00000000-0000-0000-0000-00000000000f','SK KAL','9000000006','store','KAL'),
('00000000-0000-0000-0000-000000000010','SK JAI','9000000007','store','JAI');
set role authenticated;
-- storekeeper KAL raises
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000f';
insert into requisitions(site,stage,deadline) values ('KAL','ravi_ok','2026-12-01') returning number, stage;
insert into requisitions(site,stage) values ('JAI','ajay_ok');  -- expect fail (other site)
insert into requisitions(site,stage) values ('KAL','quotes');  -- expect fail
insert into req_lines(req,name,qty,unit) select id,'Sugar',100,'kg' from requisitions;
select count(*) as people_seen_by_store from people;
select count(*) as directory from people_directory;
select count(*) as vendors_seen from vendors;
update requisitions set stage='ajay_ok';  -- expect fail
-- SK JAI sees nothing of KAL
set request.jwt.claim.sub='00000000-0000-0000-0000-000000000010';
select count(*) as jai_sees_kal from requisitions; select count(*) from req_lines;
-- Ajay cannot approve at ravi step
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000c';
update requisitions set stage='ajay_ok';
-- Ravi delegates to Ajay
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000b';
insert into delegations(from_role,to_person,ends) values ('ravi','00000000-0000-0000-0000-00000000000c','2026-12-31');
insert into delegations(from_role,to_person,ends) values ('ravi','00000000-0000-0000-0000-00000000000e','2026-12-31'); -- fail: pm not trio
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000c';
update requisitions set stage='ajay_ok' returning stage;
update requisitions set stage='clarify', return_to='ajay_ok', remarks='Which grade?' returning stage;
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000f';
update req_lines set qty=120;
update requisitions set stage='ajay_ok', return_to=null returning stage;
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000c';
update requisitions set stage='rejected';  -- fail
select set_my_pin('1234');
select reject_requisition(id,'9999','no') from requisitions;
select stage from requisitions;
select * from pins; -- fail
update requisitions set stage='quotes' returning stage;
-- PM: vendor, quote, award not allowed (not pm_decides), small order
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000e';
insert into vendors(name) values ('Shree Traders');
insert into quotes(req,vendor,gst_pct) select r.id,v.id,5 from requisitions r, vendors v;
insert into quote_lines(quote,line,rate) select q.id,l.id,40 from quotes q, req_lines l;
insert into awards(req,line,quote) select q.req,l.id,q.id from quotes q, req_lines l;  -- fail
update requisitions set stage='final' returning stage;
select next_number('KAL','po'); -- fail
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000d';
insert into awards(req,line,quote) select q.req,l.id,q.id from quotes q, req_lines l;
update requisitions set stage='issue' returning stage;
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000e';
insert into purchase_orders(req,vendor) select r.id,v.id from requisitions r, vendors v returning number;
insert into po_lines(po,line,qty,rate,gst_pct) select p.id,l.id,120,40,5 from purchase_orders p, req_lines l;
update po_lines set qty=130 returning qty;  -- 8% ok
update po_lines set qty=140;  -- 16% fail
update requisitions set stage='approved' returning stage;
set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000f';
select po_number, vendor_name, item, ordered, received from store_po_lines;
select count(*) as store_po_lines_direct from po_lines;
insert into receipts(po_line,qty) select po_line,60 from store_po_lines;
select received from store_po_lines;
insert into storage.objects(bucket_id,name) values ('files','KAL/photos/a.jpg');
insert into storage.objects(bucket_id,name) values ('files','KAL/quotes/a.pdf'); -- fail
insert into storage.objects(bucket_id,name) values ('files','JAI/photos/a.jpg'); -- fail
select count(*) from activity;
delete from activity; select count(*) from activity;
reset role;
select who, what from activity order by id;
