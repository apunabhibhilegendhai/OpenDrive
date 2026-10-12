-- Suite 1: structure, defaults and grant shape.
--
-- Run after 00_local_supabase_shim.sql and after every file in supabase/migrations/, in order.
-- Runs as the migration owner (a superuser here, `postgres` in Supabase).
--
-- The counts here are exact on purpose. Adding a table, a policy or a grant to the schema without
-- extending the suites makes this file fail, which is the point: an unexamined table is an
-- unexamined attack surface.

set search_path = public, verify;

-- --------------------------------------------------------------------------- tables

select verify.eq(
  'structure',
  'public schema holds exactly the 14 metadata tables',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'),
  14::bigint
);

select verify.eq(
  'structure',
  'every metadata table has row level security enabled',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity),
  14::bigint
);

select verify.eq(
  'structure',
  'exactly 7 client-facing policies exist (profiles, files, shares, folders only)',
  (select count(*) from pg_policies where schemaname = 'public'),
  7::bigint
);

select verify.eq(
  'structure',
  'no table is owned by a client role',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relowner in ('anon'::regrole, 'authenticated'::regrole)),
  0::bigint
);

select verify.eq(
  'structure',
  'enum file_visibility has 3 values',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'file_visibility'),
  3::bigint
);

select verify.eq(
  'structure',
  'enum file_status has 9 values after the Phase 1 renames and additions',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'file_status'),
  9::bigint
);

select verify.eq(
  'structure',
  'enum upload_state has 6 values',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'upload_state'),
  6::bigint
);

select verify.eq(
  'structure',
  'enum principal_kind distinguishes user and anonymous principals',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'principal_kind'),
  2::bigint
);

select verify.eq(
  'structure',
  'enum account_status has 3 values',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'account_status'),
  3::bigint
);

select verify.eq(
  'structure',
  'enum session_status has 2 values',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'session_status'),
  2::bigint
);

select verify.eq(
  'structure',
  'enum share_status has 3 values',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'share_status'),
  3::bigint
);

select verify.eq(
  'structure',
  'enum quota_period has 3 values',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'quota_period'),
  3::bigint
);

select verify.eq(
  'structure',
  'enum reservation_state has 4 values',
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'reservation_state'),
  4::bigint
);

-- --------------------------------------------------------------------------- lineage of the rename

-- `available` became `ready` and `pending` became `pending_upload` in the Phase 1 migration. The
-- rename must carry every dependent object with it: defaults and partial index predicates store the
-- enum's OID, so a rename that did NOT propagate would leave a default or an index silently
-- referring to a label that no longer exists. These two checks pin that down.
select verify.eq(
  'structure',
  'files.status default follows the rename to pending_upload',
  (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'files'::regclass and a.attname = 'status'),
  '''pending_upload''::file_status'
);

select verify.eq(
  'structure',
  'the availability index predicate follows the rename to ready',
  (select position('''ready''' in indexdef) > 0 from pg_indexes where indexname = 'files_visibility_created_idx'),
  true
);

-- --------------------------------------------------------------------------- indexes and triggers

select verify.eq(
  'structure',
  'single-active-storage-object index exists and is unique and partial',
  (select count(*) from pg_index i
     join pg_class c on c.oid = i.indexrelid
    where c.relname = 'storage_objects_one_active_per_file' and i.indisunique and i.indpred is not null),
  1::bigint
);

select verify.eq(
  'structure',
  'at most one held quota reservation per file is enforced by a partial unique index',
  (select count(*) from pg_index i
     join pg_class c on c.oid = i.indexrelid
    where c.relname = 'quota_reservations_one_held_per_file' and i.indisunique and i.indpred is not null),
  1::bigint
);

select verify.eq(
  'structure',
  'folder sibling names are unique per owner and parent',
  (select count(*) from pg_indexes where indexname = 'folders_sibling_name_unique'),
  1::bigint
);

select verify.eq(
  'structure',
  'files are indexed by session owner, by folder, and by user owner',
  (select count(*) from pg_indexes
    where indexname in ('files_owner_created_idx', 'files_owner_session_created_idx', 'files_folder_created_idx')),
  3::bigint
);

select verify.eq(
  'structure',
  'updated_at triggers exist on all 8 mutable tables',
  (select count(*) from pg_trigger where not tgisinternal and tgname like '%_set_updated_at'),
  8::bigint
);

select verify.eq(
  'structure',
  'the folder hierarchy guard trigger exists',
  (select count(*) from pg_trigger where not tgisinternal and tgname = 'folders_guard_hierarchy'),
  1::bigint
);

select verify.eq(
  'structure',
  'owner_key is a stored generated column on files, folders, usage_counters and quota_reservations',
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'owner_key' and is_generated = 'ALWAYS'),
  4::bigint
);

-- --------------------------------------------------------------------------- quota functions

select verify.eq(
  'structure',
  'the 7 opendrive_* quota and storage functions exist',
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname ~ '^opendrive_'),
  7::bigint
);

select verify.eq(
  'structure',
  'the quota policy table holds exactly the two principal kinds',
  (select count(*) from quota_limits),
  2::bigint
);

select verify.eq(
  'structure',
  'the anonymous policy is stricter than the user policy on storage',
  (select count(*) from quota_limits a, quota_limits b
    where a.principal_kind = 'anonymous' and b.principal_kind = 'user'
      and a.storage_bytes < b.storage_bytes and a.max_files < b.max_files),
  1::bigint
);

select verify.eq(
  'structure',
  'every policy respects the 5 GiB per-file ceiling',
  (select count(*) from quota_limits where max_file_size_bytes > 5368709120),
  0::bigint
);

-- --------------------------------------------------------------------------- platform

-- The migration's security posture depends on these Supabase properties. Asserting them turns a
-- platform assumption into something a run can falsify.
select verify.eq(
  'platform',
  'roles anon, authenticated and service_role exist',
  (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')),
  3::bigint
);

select verify.eq(
  'platform',
  'service_role has BYPASSRLS (the API path depends on it)',
  (select rolbypassrls from pg_roles where rolname = 'service_role'),
  true
);

select verify.eq(
  'platform',
  'auth.uid() exists',
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'),
  1::bigint
);

select verify.eq(
  'platform',
  'auth.uid() is null without JWT claims',
  auth.uid() is null,
  true
);

set request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111"}';
select verify.eq(
  'platform',
  'auth.uid() resolves the JWT sub claim',
  auth.uid(),
  '11111111-1111-4111-8111-111111111111'::uuid
);
reset request.jwt.claims;

-- --------------------------------------------------------------------------- defaults

insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'ada@example.test');
insert into profiles (id) values ('11111111-1111-4111-8111-111111111111');

insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
values ('file_abcdeabcdeabcdeabcdeabcdef', '11111111-1111-4111-8111-111111111111',
        'quarterly-report.pdf', 1048576, 'application/pdf');

select verify.eq(
  'defaults',
  'visibility defaults to private',
  (select visibility::text from files where id = 'file_abcdeabcdeabcdeabcdeabcdef'),
  'private'
);

select verify.eq(
  'defaults',
  'status defaults to pending_upload (a row with no bytes is never servable)',
  (select status::text from files where id = 'file_abcdeabcdeabcdeabcdeabcdef'),
  'pending_upload'
);

select verify.eq(
  'defaults',
  'a file at the root has no folder',
  (select folder_id is null from files where id = 'file_abcdeabcdeabcdeabcdeabcdef'),
  true
);

select verify.eq(
  'defaults',
  'the principal key of a user-owned file is the user id',
  (select owner_key from files where id = 'file_abcdeabcdeabcdeabcdeabcdef'),
  '11111111-1111-4111-8111-111111111111'
);

select verify.eq(
  'defaults',
  'anonymous deletion token hash defaults to null (nothing to compare)',
  (select deletion_token_hash is null from files where id = 'file_abcdeabcdeabcdeabcdeabcdef'),
  true
);

select verify.eq(
  'defaults',
  'a new profile gets the 5 GiB per-file ceiling',
  (select max_file_size_bytes from profiles where id = '11111111-1111-4111-8111-111111111111'),
  5368709120::bigint
);

select verify.eq(
  'defaults',
  'a new profile gets a 5 GiB storage quota',
  (select storage_quota_bytes from profiles where id = '11111111-1111-4111-8111-111111111111'),
  5368709120::bigint
);

select verify.eq(
  'defaults',
  'a new profile is active',
  (select status::text from profiles where id = '11111111-1111-4111-8111-111111111111'),
  'active'
);

select verify.eq(
  'defaults',
  'a new profile gets the file-count ceiling',
  (select max_files from profiles where id = '11111111-1111-4111-8111-111111111111'),
  100000
);

select verify.eq(
  'defaults',
  'display_name may be null (identity lives in auth.users, not here)',
  (select display_name is null from profiles where id = '11111111-1111-4111-8111-111111111111'),
  true
);

-- --------------------------------------------------------------------------- updated_at trigger

insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, created_at, updated_at)
values (
  'file_bcdefbcdefbcdefbcdefbcdefb',
  '11111111-1111-4111-8111-111111111111',
  'archive.bin',
  2048,
  'application/octet-stream',
  now() - interval '2 hours',
  now() - interval '2 hours'
);

update files set original_filename = 'archive-renamed.bin'
 where id = 'file_bcdefbcdefbcdefbcdefbcdefb';

select verify.eq(
  'triggers',
  'update on files advances updated_at past a backdated created_at',
  (select updated_at > created_at
     from files where id = 'file_bcdefbcdefbcdefbcdefbcdefb'),
  true
);

insert into folders (id, owner_user_id, name) values
  ('fold_abcdeabcdeabcdeabcdeabcdef', '11111111-1111-4111-8111-111111111111', 'Documents');

update folders set name = 'Documents and archives'
 where id = 'fold_abcdeabcdeabcdeabcdeabcdef';

select verify.eq(
  'triggers',
  'update on folders advances updated_at',
  (select updated_at > created_at from folders where id = 'fold_abcdeabcdeabcdeabcdeabcdef'),
  true
);

-- --------------------------------------------------------------------------- grants
-- Read from relacl rather than information_schema.role_table_grants: the information-schema
-- views only expose grants involving a *currently enabled* role, which would hide client roles
-- from this check and make it vacuously pass.

select verify.eq(
  'grants',
  'anon has no table privileges of any kind',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace,
     lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname = 'public' and c.relkind = 'r' and a.grantee = 'anon'::regrole::oid),
  0::bigint
);

select verify.eq(
  'grants',
  'service_role holds select+insert+update+delete on all 14 tables',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace,
     lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname = 'public' and c.relkind = 'r' and a.grantee = 'service_role'::regrole::oid
      and a.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  56::bigint
);

select verify.eq(
  'grants',
  'authenticated holds exactly 7 privileges (profiles r+w, files r+del, shares r, folders r+del)',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace,
     lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname = 'public' and c.relkind = 'r' and a.grantee = 'authenticated'::regrole::oid
      and a.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  7::bigint
);

select verify.eq(
  'grants',
  'authenticated holds exactly one write privilege: updating its own profile',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace,
     lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname = 'public' and c.relkind = 'r' and a.grantee = 'authenticated'::regrole::oid
      and a.privilege_type in ('INSERT', 'UPDATE')),
  1::bigint
);

select verify.eq(
  'grants',
  'authenticated has no SELECT on the server-only tables',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace,
     lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('storage_objects', 'api_keys', 'audit_events', 'abuse_reports', 'moderation_actions')
      and a.grantee = 'authenticated'::regrole::oid and a.privilege_type = 'SELECT'),
  0::bigint
);

select verify.eq(
  'grants',
  'authenticated has no SELECT on anonymous_sessions, quota_limits, usage_counters or quota_reservations',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace,
     lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('anonymous_sessions', 'quota_limits', 'usage_counters', 'quota_reservations')
      and a.grantee = 'authenticated'::regrole::oid),
  0::bigint
);
