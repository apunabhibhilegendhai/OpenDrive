-- Local-development shim: the Supabase-provided surface the migration depends on.
--
-- NOT A MIGRATION. NEVER RUN THIS AGAINST SUPABASE. Supabase already owns these objects;
-- running this file there would either no-op or collide with objects Supabase manages.
--
-- A bare PostgreSQL instance provides none of it, so `20261010000001_initial_schema.sql`
-- cannot be applied to a plain Postgres without this shim first. It exists so the schema can
-- be proven against a throwaway database (see supabase/tests/run-local.sh).
--
-- What it emulates, and how faithfully:
--   * Roles `anon`, `authenticated` and `service_role`, all NOLOGIN, mirroring Supabase's
--     role split. `service_role` holds BYPASSRLS because that is precisely what makes the
--     migration's "server enforces authorization, RLS is the narrow exception" posture work.
--     If a future platform change removed BYPASSRLS from service_role, the API's own queries
--     would start being filtered by client policies — a silent, serious regression.
--   * Schema `auth` and table `auth.users` with only the `id` column, because the migration's
--     foreign key references exactly that column and nothing else.
--   * `auth.uid()`, copied from Supabase's own definition: the JWT `sub` claim from
--     `request.jwt.claim.sub` or `request.jwt.claims`, cast to uuid, null when absent.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

comment on function auth.uid() is
  'Shim: the authenticated user id from the JWT claims, or null. Supabase defines this identically.';

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
