-- Suite 3: row level security behaviour, exercised as the roles a client can actually hold.
--
-- The migration's claim is: "the server enforces authorization in application code; RLS is the
-- narrow exception for direct own-row access." This suite falsifies or confirms that claim by
-- running the same queries as `authenticated`, as `anon` and as `service_role`.
--
-- Phase 1 adds a second kind of owner. An anonymous session's files must be invisible to every
-- registered user — that is what the fail-closed `owner_user_id = auth.uid()` predicate gives when
-- owner_user_id is NULL, and it is asserted here rather than assumed.
--
-- Nothing here proves what the *API* does; the API's own authorization is tested in
-- apps/api/src/**/*.test.ts and tests/integration. This file proves what the database will and will
-- not allow underneath it.

set search_path = public, verify;

-- This suite owns its fixtures: start from empty tables so every count below is exact.
truncate table public.files, public.folders, public.storage_objects, public.upload_sessions,
  public.shares, public.api_keys, public.audit_events, public.abuse_reports,
  public.moderation_actions, public.quota_reservations, public.usage_counters,
  public.anonymous_sessions, public.profiles, auth.users cascade;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'a@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'b@example.test');

insert into profiles (id, display_name) values
  ('11111111-1111-4111-8111-111111111111', 'Ada'),
  ('22222222-2222-4222-8222-222222222222', 'Bo');

-- An anonymous visitor with an upload of their own.
insert into anonymous_sessions (id, credential_hash, expires_at)
values ('sess_abcdeabcdeabcdeabcdeabcdef', repeat('a1', 32), now() + interval '24 hours');

-- ada_w: Ada's plain file, deleted in this suite to prove the delete policy works.
-- ada_x: Ada's rich fixture (children in every dependent table) so the service-role checks after
--        Ada's delete still have something to read.
-- bo_y:  Bo's private file — the cross-tenant target.
-- sess_z: the anonymous session's file. No registered user may see it.
insert into files (id, owner_user_id, owner_session_id, original_filename, size_bytes, mime_type, visibility, status) values
  ('file_fghjkfghjkfghjkfghjkfghjka', '11111111-1111-4111-8111-111111111111', null, 'ada-w.bin', 1024,
   'application/octet-stream', 'private', 'ready'),
  ('file_fghjkfghjkfghjkfghjkfghjkb', '11111111-1111-4111-8111-111111111111', null, 'ada-x.bin', 2048,
   'application/octet-stream', 'private', 'ready'),
  ('file_fghjkfghjkfghjkfghjkfghjkc', '22222222-2222-4222-8222-222222222222', null, 'bo-y.bin', 4096,
   'application/octet-stream', 'private', 'ready'),
  ('file_fghjkfghjkfghjkfghjkfghjkd', null, 'sess_abcdeabcdeabcdeabcdeabcdef', 'anon-z.bin', 8192,
   'application/octet-stream', 'private', 'ready');

insert into folders (id, owner_user_id, name) values
  ('fold_fghjkfghjkfghjkfghjkfghjka', '11111111-1111-4111-8111-111111111111', 'Ada documents'),
  ('fold_fghjkfghjkfghjkfghjkfghjkb', '22222222-2222-4222-8222-222222222222', 'Bo documents');

insert into storage_objects (id, file_id, provider_id, provider_ref, size_bytes)
values ('sobj_fghjkfghjkfghjkfghjkfghjka', 'file_fghjkfghjkfghjkfghjkfghjkb', 'telegram',
        '{"chat_id":-1001234567890,"message_id":4242}'::jsonb, 2048);

insert into upload_sessions (id, file_id, declared_size_bytes, chunk_size_bytes, state)
values ('upl_fghjkfghjkfghjkfghjkfghjka', 'file_fghjkfghjkfghjkfghjkfghjkb', 2048, 8388608, 'finalized');

insert into shares (id, file_id, kind, token_hash, created_by) values
  ('shr_fghjkfghjkfghjkfghjkfghjka', 'file_fghjkfghjkfghjkfghjkfghjkb', 'unlisted', repeat('a1', 32),
   '11111111-1111-4111-8111-111111111111'),
  ('shr_fghjkfghjkfghjkfghjkfghjkb', 'file_fghjkfghjkfghjkfghjkfghjkb', 'public', repeat('b2', 32), null),
  ('shr_fghjkfghjkfghjkfghjkfghjkc', 'file_fghjkfghjkfghjkfghjkfghjkc', 'unlisted', repeat('c3', 32),
   '22222222-2222-4222-8222-222222222222'),
  ('shr_fghjkfghjkfghjkfghjkfghjkd', 'file_fghjkfghjkfghjkfghjkfghjka', 'unlisted', repeat('d4', 32),
   '11111111-1111-4111-8111-111111111111');

insert into api_keys (id, owner_id, name, key_prefix, key_hash, scopes)
values ('key_fghjkfghjkfghjkfghjkfghjka', '11111111-1111-4111-8111-111111111111', 'ada-laptop',
        'odk_abcdefgh', repeat('e5', 32), array['files:read']);

insert into audit_events (id, actor_kind, actor_user_id, action, subject_type, subject_id)
values ('evt_fghjkfghjkfghjkfghjkfghjka', 'user', '11111111-1111-4111-8111-111111111111',
        'file.upload', 'file', 'file_fghjkfghjkfghjkfghjkfghjkb');

insert into abuse_reports (id, file_id, reason)
values ('rpt_fghjkfghjkfghjkfghjkfghjka', 'file_fghjkfghjkfghjkfghjkfghjkb', 'malware');

insert into moderation_actions (id, report_id, file_id, action, actor_user_id)
values ('mod_fghjkfghjkfghjkfghjkfghjka', 'rpt_fghjkfghjkfghjkfghjkfghjka',
        'file_fghjkfghjkfghjkfghjkfghjkb', 'quarantine', '22222222-2222-4222-8222-222222222222');

insert into usage_counters (owner_user_id, period, period_start, storage_bytes, file_count)
values ('11111111-1111-4111-8111-111111111111', 'lifetime', '1970-01-01 00:00:00+00', 3072, 2);

insert into quota_reservations (id, file_id, owner_user_id, requested_bytes, state)
values ('resv_fghjkfghjkfghjkfghjkfghjka', 'file_fghjkfghjkfghjkfghjkfghjkb',
        '11111111-1111-4111-8111-111111111111', 2048, 'held');

-- --------------------------------------------------------------------------- documented hazards

-- RLS does not apply to a table's owner. The API is therefore only safe as a NON-OWNER role
-- (service_role, which bypasses RLS deliberately and explicitly). If the application were ever
-- pointed at the migration owner's credentials, every client policy below would silently stop
-- applying. Asserting the current state keeps that hazard visible.
select verify.eq(
  'hazards',
  'files does not use FORCE RLS, so the API must connect as a non-owner role',
  (select c.relforcerowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'files'),
  false
);

select verify.eq(
  'hazards',
  'no client role owns a table (owner bypass cannot be reached by anon/authenticated)',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relowner in ('anon'::regrole, 'authenticated'::regrole)),
  0::bigint
);

-- --------------------------------------------------------------------------- no identity

-- The fail-closed case: the role is `authenticated` but the request carries no claims. The
-- policies compare owner_user_id to auth.uid(), which is null here, and `owner_id = null` matches
-- nothing, so nothing is visible.
select verify.eq('rls:no-identity', 'auth.uid() is null outside an authenticated request', auth.uid() is null, true);

set role authenticated;
select verify.eq(
  'rls:no-identity',
  'authenticated with no JWT claims sees no rows at all (fails closed, not open)',
  (select count(*) from files),
  0::bigint
);
reset role;

-- --------------------------------------------------------------------------- authenticated: Ada

-- Ada's request carries her JWT sub claim, exactly as a Supabase client's would.
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', false);

set role authenticated;

select verify.eq(
  'rls:ada',
  'Ada sees her own 2 files out of 4 rows (row filtering, not just privileges)',
  (select count(*) from files),
  2::bigint
);

select verify.eq(
  'rls:ada',
  'Ada cannot see the anonymous session''s file',
  (select count(*) from files where id = 'file_fghjkfghjkfghjkfghjkfghjkd'),
  0::bigint
);

select verify.eq(
  'rls:ada',
  'IDOR probe: fetching Bo''s file by its exact id returns nothing',
  (select count(*) from files where id = 'file_fghjkfghjkfghjkfghjkfghjkc'),
  0::bigint
);

select verify.eq(
  'rls:ada',
  'Ada sees only her own profile',
  (select count(*) from profiles),
  1::bigint
);

select verify.eq(
  'rls:ada',
  'Ada cannot read Bo''s profile row',
  (select count(*) from profiles where id = '22222222-2222-4222-8222-222222222222'),
  0::bigint
);

select verify.eq(
  'rls:ada',
  'Ada sees only her own folder',
  (select count(*) from folders),
  1::bigint
);

select verify.eq(
  'rls:ada',
  'Ada cannot read Bo''s folder row',
  (select count(*) from folders where id = 'fold_fghjkfghjkfghjkfghjkfghjkb'),
  0::bigint
);

select verify.eq(
  'rls:ada',
  'Ada sees 3 shares: hers, the anonymous share on her file, and the one on the file she will delete',
  (select count(*) from shares),
  3::bigint
);

select verify.eq(
  'rls:ada',
  'Ada cannot see the share on Bo''s file',
  (select count(*) from shares where id = 'shr_fghjkfghjkfghjkfghjkfghjkc'),
  0::bigint
);

select verify.rejected(
  'rls:ada',
  'Ada cannot insert a file row directly (the API does this as service_role)',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_fghjkfghjkfghjkfghjkfghjke', '11111111-1111-4111-8111-111111111111',
               'sneaky.bin', 1, 'application/octet-stream')$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot update a file row directly (no UPDATE privilege exists for clients)',
  $sql$update files set original_filename = 'renamed.bin'
        where id = 'file_fghjkfghjkfghjkfghjkfghjkb'$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot mint a share row directly (tokens are server-issued)',
  $sql$insert into shares (id, file_id, token_hash)
       values ('shr_fghjkfghjkfghjkfghjkfghjke', 'file_fghjkfghjkfghjkfghjkfghjkb', repeat('f6', 32))$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot insert a profile row directly',
  $sql$insert into profiles (id, display_name) values ('55555555-5555-4555-8555-555555555555', 'Eve')$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot create a folder directly (creation goes through the API)',
  $sql$insert into folders (id, owner_user_id, name)
       values ('fold_fghjkfghjkfghjkfghjkfghjke', '11111111-1111-4111-8111-111111111111', 'Sneaky')$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read storage_objects (provider locators are server-side only)',
  $sql$select count(*) from storage_objects$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read api_keys (even her own: key material never leaves the server)',
  $sql$select count(*) from api_keys$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read audit_events',
  $sql$select count(*) from audit_events$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read abuse_reports',
  $sql$select count(*) from abuse_reports$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read moderation_actions',
  $sql$select count(*) from moderation_actions$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read anonymous_sessions (a client that could would enumerate visitors)',
  $sql$select count(*) from anonymous_sessions$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read quota_limits',
  $sql$select count(*) from quota_limits$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read usage_counters',
  $sql$select count(*) from usage_counters$sql$,
  'permission denied'
);

select verify.rejected(
  'rls:ada',
  'Ada cannot read quota_reservations',
  $sql$select count(*) from quota_reservations$sql$,
  'permission denied'
);

-- A data-modifying CTE has to be at the top level of its statement, so each of these is written as
-- `with <change> as (...) select verify.eq(...)`: the row count the function asserts is the number
-- of rows the change actually touched under RLS.
with cross_tenant_update as (
  update profiles set display_name = 'Owned'
   where id = '22222222-2222-4222-8222-222222222222'
  returning 1
)
select verify.eq(
  'rls:ada',
  'Ada cannot update Bo''s profile (0 rows matched)',
  (select count(*) from cross_tenant_update),
  0::bigint
);

with own_update as (
  update profiles set display_name = 'Ada L.'
   where id = '11111111-1111-4111-8111-111111111111'
  returning 1
)
select verify.eq(
  'rls:ada',
  'Ada can update her own profile (1 row)',
  (select count(*) from own_update),
  1::bigint
);

with cross_tenant_delete as (
  delete from files where id = 'file_fghjkfghjkfghjkfghjkfghjkc' returning 1
)
select verify.eq(
  'rls:ada',
  'Ada cannot delete Bo''s file (0 rows matched, and the row is untouched)',
  (select count(*) from cross_tenant_delete),
  0::bigint
);

with cross_tenant_folder_delete as (
  delete from folders where id = 'fold_fghjkfghjkfghjkfghjkfghjkb' returning 1
)
select verify.eq(
  'rls:ada',
  'Ada cannot delete Bo''s folder (0 rows matched)',
  (select count(*) from cross_tenant_folder_delete),
  0::bigint
);

with session_file_delete as (
  delete from files where id = 'file_fghjkfghjkfghjkfghjkfghjkd' returning 1
)
select verify.eq(
  'rls:ada',
  'Ada cannot delete the anonymous session''s file',
  (select count(*) from session_file_delete),
  0::bigint
);

with own_delete as (
  delete from files where id = 'file_fghjkfghjkfghjkfghjkfghjka' returning 1
)
select verify.eq(
  'rls:ada',
  'Ada can delete her own file (1 row), cascading to its share',
  (select count(*) from own_delete),
  1::bigint
);

select verify.eq(
  'rls:ada',
  'after the delete Ada sees 2 shares: the cascade removed the share on her deleted file',
  (select count(*) from shares),
  2::bigint
);

reset role;

-- --------------------------------------------------------------------------- authenticated: Bo

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', false);
set role authenticated;

select verify.eq(
  'rls:bo',
  'Bo sees exactly his own file',
  (select count(*) from files),
  1::bigint
);

select verify.eq(
  'rls:bo',
  'IDOR probe: Bo cannot fetch Ada''s file by its exact id',
  (select count(*) from files where id = 'file_fghjkfghjkfghjkfghjkfghjkb'),
  0::bigint
);

select verify.eq(
  'rls:bo',
  'Bo sees only the share on his own file',
  (select count(*) from shares),
  1::bigint
);

with cross_tenant_delete as (
  delete from files where id = 'file_fghjkfghjkfghjkfghjkfghjkb' returning 1
)
select verify.eq(
  'rls:bo',
  'Bo cannot delete Ada''s file',
  (select count(*) from cross_tenant_delete),
  0::bigint
);

reset role;

-- --------------------------------------------------------------------------- the second tenant's rows survived

select verify.eq(
  'rls:cross-tenant',
  'Ada''s cross-tenant delete attempt left Bo''s file intact',
  (select count(*) from files where id = 'file_fghjkfghjkfghjkfghjkfghjkc'),
  1::bigint
);

select verify.eq(
  'rls:cross-tenant',
  'Ada''s cross-tenant profile update left Bo''s display name intact',
  (select display_name from profiles where id = '22222222-2222-4222-8222-222222222222'),
  'Bo'
);

select verify.eq(
  'rls:cross-tenant',
  'Bo''s cross-tenant delete attempt left Ada''s file intact',
  (select count(*) from files where id = 'file_fghjkfghjkfghjkfghjkfghjkb'),
  1::bigint
);

select verify.eq(
  'rls:cross-tenant',
  'the anonymous session''s file is still present after both users tried to delete it',
  (select count(*) from files where id = 'file_fghjkfghjkfghjkfghjkfghjkd'),
  1::bigint
);

-- --------------------------------------------------------------------------- anonymous

-- An anonymous request carries no identity at all.
reset request.jwt.claims;

set role anon;

select verify.rejected(
  'rls:anon', 'anon cannot select files', $sql$select count(*) from files$sql$, 'permission denied'
);
select verify.rejected(
  'rls:anon', 'anon cannot select profiles', $sql$select count(*) from profiles$sql$, 'permission denied'
);
select verify.rejected(
  'rls:anon', 'anon cannot select shares', $sql$select count(*) from shares$sql$, 'permission denied'
);
select verify.rejected(
  'rls:anon', 'anon cannot select folders', $sql$select count(*) from folders$sql$, 'permission denied'
);
select verify.rejected(
  'rls:anon',
  'anon cannot insert files',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_fghjkfghjkfghjkfghjkfghjkf', '11111111-1111-4111-8111-111111111111',
               'anon.bin', 1, 'application/octet-stream')$sql$,
  'permission denied'
);
select verify.rejected(
  'rls:anon', 'anon cannot delete files', $sql$delete from files$sql$, 'permission denied'
);
select verify.rejected(
  'rls:anon',
  'anon cannot read storage_objects',
  $sql$select count(*) from storage_objects$sql$,
  'permission denied'
);
select verify.rejected(
  'rls:anon',
  'anon cannot read anonymous_sessions (session credentials are resolved server-side only)',
  $sql$select count(*) from anonymous_sessions$sql$,
  'permission denied'
);
select verify.rejected(
  'rls:anon',
  'anon cannot call the quota functions (EXECUTE is revoked from PUBLIC)',
  $sql$select opendrive_quota_summary(null, 'sess_abcdeabcdeabcdeabcdeabcdef')$sql$,
  'permission denied'
);

reset role;

-- --------------------------------------------------------------------------- service role

set role service_role;

-- Note the asymmetry: service_role sees the session-owned file too. Bypassing RLS is the whole
-- point of the server role, and it is also why every authorization decision has to be made in
-- application code rather than delegated to the database.
select verify.eq(
  'rls:service',
  'service_role sees all 3 remaining files, including the anonymous session''s',
  (select count(*) from files),
  3::bigint
);

select verify.eq(
  'rls:service',
  'service_role sees all profiles',
  (select count(*) from profiles),
  2::bigint
);

select verify.eq(
  'rls:service',
  'service_role can read the provider locator it needs to fetch bytes',
  (select provider_ref ->> 'message_id' from storage_objects
    where id = 'sobj_fghjkfghjkfghjkfghjkfghjka'),
  '4242'
);

select verify.eq(
  'rls:service',
  'service_role can resolve a share by token hash',
  (select count(*) from shares where token_hash = repeat('b2', 32)),
  1::bigint
);

select verify.eq(
  'rls:service',
  'service_role can read the anonymous session it must resolve credentials against',
  (select count(*) from anonymous_sessions where credential_hash = repeat('a1', 32)),
  1::bigint
);

select verify.eq(
  'rls:service',
  'service_role can call the quota summary function',
  (select (opendrive_quota_summary('11111111-1111-4111-8111-111111111111', null) ->> 'ok')::boolean),
  true
);

with service_insert as (
  insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
  values ('file_fghjkfghjkfghjkfghjkfghjkf', '22222222-2222-4222-8222-222222222222',
          'service-created.bin', 16, 'application/octet-stream')
  returning 1
)
select verify.eq(
  'rls:service',
  'service_role can write metadata (upload workflow)',
  (select count(*) from service_insert),
  1::bigint
);

with service_update as (
  update files set status = 'quarantined', scan_state = 'infected'
   where id = 'file_fghjkfghjkfghjkfghjkfghjkf'
  returning 1
)
select verify.eq(
  'rls:service',
  'service_role can quarantine a file as part of a takedown',
  (select count(*) from service_update),
  1::bigint
);

reset role;

-- --------------------------------------------------------------------------- final state

select verify.eq(
  'rls:final',
  'the files table holds exactly the 4 rows the suite accounts for',
  (select count(*) from files),
  4::bigint
);
