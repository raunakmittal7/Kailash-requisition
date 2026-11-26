P="psql -h /var/tmp/kgpg -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
export PGOPTIONS='-c client_min_messages=warning'
$P -c "drop database if exists kgt" && $P -c "create database kgt" && $P -d kgt -f $(dirname "$0")/stub.sql && $P -d kgt -f $(git rev-parse --show-toplevel)/supabase/setup.sql >/dev/null && $P -d kgt -f $(git rev-parse --show-toplevel)/supabase/migrations/001_live_website.sql >/dev/null && $P -d kgt <<'SQL'
select add_person('Raunak Mittal','9000000008','raunak',null,'pass123');
select add_person('Ajay Agarwal','9000000006','ajay',null,'pass123');
select add_person('Ravi Mittal','9000000007','ravi',null,'pass123');
select add_person('Ganesh PM','9000000005','pm',null,'pass123');
select add_person('Sanjay JAI','9000000001','store','JAI','pass123');
select add_person('Siddhartha KAL','9000000004','store','KAL','pass123');
SQL
echo reset-ok
