do $$ begin if not exists (select 1 from pg_roles where rolname=$q$anon$q$) then create role anon nologin; create role authenticated nologin; end if; end $$;
grant anon, authenticated to authenticator;
create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
grant usage on schema public, auth, extensions to anon, authenticated;
create table auth.users(instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255) unique,
 encrypted_password varchar(255), email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
 created_at timestamptz, updated_at timestamptz, confirmation_token varchar(255), recovery_token varchar(255),
 email_change_token_new varchar(255), email_change varchar(255), email_change_token_current varchar(255) default '',
 phone_change text default '', phone_change_token varchar(255) default '', reauthentication_token varchar(255) default '');
create table auth.identities(provider_id text not null, user_id uuid not null references auth.users on delete cascade,
 identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
 email text generated always as (lower(identity_data->>'email')) stored, id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(current_setting('request.jwt.claim.sub',true),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')),'')::uuid $$;
grant execute on function auth.uid() to authenticated, anon;
create schema storage; grant usage on schema storage to authenticated;
create table storage.buckets(id text primary key,name text,public boolean);
create table storage.objects(id serial primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated; grant usage on sequence storage.objects_id_seq to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
grant execute on function storage.foldername(text) to authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
