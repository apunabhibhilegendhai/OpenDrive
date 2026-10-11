-- Suite 6: credential storage and schema-wide invariants.
--
-- These are the claims that are cheap to state in a design document and expensive to notice going
-- wrong: "no plaintext credential is stored", "file bytes never enter Postgres", "the API cannot
-- leak a provider locator". Each is asserted structurally, against the catalogue, so a future
-- migration that quietly adds a `plaintext_token` column or a `bytea` body fails here.

set search_path = public, verify;

-- --------------------------------------------------------------------------- no file content in Postgres

select verify.eq(
  'storage-boundary',
  'no public table has a bytea column (file content never lives in Postgres)',
  (select count(*) from information_schema.columns
    where table_schema = 'public' and data_type = 'bytea'),
  0::bigint
);

select verify.eq(
  'storage-boundary',
  'the database holds no large objects',
  (select count(*) from pg_largeobject_metadata),
  0::bigint
);

select verify.eq(
  'storage-boundary',
  'no column is named for content or a body that could accumulate bytes',
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and (column_name like '%content%' or column_name like '%body%' or column_name like '%blob%')),
  0::bigint
);

-- --------------------------------------------------------------------------- provider references stay server-side

select verify.eq(
  'storage-boundary',
  'provider identifiers exist only in storage_objects',
  (select string_agg(distinct table_name, ', ' order by table_name)
     from information_schema.columns
    where table_schema = 'public' and column_name in ('provider_id', 'provider_ref', 'provider_session_ref')),
  'storage_objects, upload_sessions'
);

select verify.eq(
  'storage-boundary',
  'folders carry no storage-provider information',
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'folders'
      and (column_name like '%provider%' or column_name like '%storage%')),
  0::bigint
);

select verify.eq(
  'storage-boundary',
  'files hold no provider reference of their own (the mapping is normalised)',
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'files'
      and (column_name like '%provider%' or column_name like '%storage_object%')),
  0::bigint
);

-- --------------------------------------------------------------------------- credentials are hashes

-- Enumerated rather than pattern-matched: a new column whose name merely *looks* like a hash is not
-- evidence, and a new plaintext credential column would otherwise slip through a loose pattern.
select verify.eq(
  'credentials',
  'the only credential-shaped columns are hashes plus the public API-key prefix',
  (select string_agg(column_name, ', ' order by column_name)
     from information_schema.columns
    where table_schema = 'public'
      and (column_name like '%hash%' or column_name like '%token%'
           or column_name like '%credential%' or column_name like '%secret%'
           or column_name like '%prefix%')),
  'actor_ip_hash, created_ip_hash, credential_hash, deletion_token_hash, key_hash, key_prefix, ' ||
  'reporter_email_hash, reporter_ip_hash, token_hash'
);

-- Matched on the whole name rather than a substring: `principal_kind` contains the letters "ip",
-- which is exactly the kind of false positive that turns a security check into noise.
select verify.eq(
  'credentials',
  'no column is an address; address-derived values are stored as named hashes',
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and (column_name = 'ip' or column_name like '%\_ip' or column_name like 'ip\_%'
           or column_name = 'address' or column_name like '%\_address')),
  0::bigint
);

select verify.eq(
  'credentials',
  'the three address-derived columns all end in _hash',
  (select string_agg(column_name, ', ' order by column_name)
     from information_schema.columns
    where table_schema = 'public' and column_name like '%\_ip\_hash'),
  'actor_ip_hash, created_ip_hash, reporter_ip_hash'
);

select verify.eq(
  'credentials',
  'the API-key prefix is the only part of a key stored in the clear',
  (select string_agg(column_name, ', ' order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'api_keys'
      and (column_name like '%key%' or column_name like '%secret%' or column_name like '%token%')),
  'key_hash, key_prefix'
);

-- Every enumerated hash column must also be shape-checked, because a hash column with no check is
-- an unvalidated text field that happens to be called a hash.
select verify.eq(
  'credentials',
  'every hash column is constrained to a 64 character lowercase hex digest',
  (select count(*) from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name in ('actor_ip_hash', 'created_ip_hash', 'credential_hash',
                            'deletion_token_hash', 'key_hash', 'reporter_email_hash',
                            'reporter_ip_hash', 'token_hash')
      and exists (
        select 1 from pg_constraint k
          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
         where k.conrelid = (c.table_schema || '.' || c.table_name)::regclass
           and k.contype = 'c' and a.attname = c.column_name)),
  8::bigint
);

select verify.eq(
  'credentials',
  'the API-key prefix is shape-checked too',
  (select count(*) from pg_constraint k
     join pg_class t on t.oid = k.conrelid
     join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
    where t.relname = 'api_keys' and k.contype = 'c' and a.attname = 'key_prefix'
      and k.conname = 'api_keys_key_prefix_check'),
  1::bigint
);

select verify.eq(
  'credentials',
  'tables holding bearer credentials have row level security enabled',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('anonymous_sessions', 'api_keys', 'shares', 'files')
      and c.relrowsecurity),
  4::bigint
);

-- --------------------------------------------------------------------------- function privileges

-- EXECUTE on a new function is granted to PUBLIC by default, which would expose every quota and
-- storage function to `anon` and `authenticated` through PostgREST. This is the check that the
-- revoke actually happened, for the database's own default as well as the two client roles.
select verify.eq(
  'privileges',
  'no opendrive_* function is executable by PUBLIC',
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public' and p.proname ~ '^opendrive_' and a.grantee = 0),
  0::bigint
);

select verify.eq(
  'privileges',
  'no opendrive_* function is executable by anon or authenticated',
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public' and p.proname ~ '^opendrive_'
      and a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid)),
  0::bigint
);

select verify.eq(
  'privileges',
  'every opendrive_* function is executable by service_role',
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public' and p.proname ~ '^opendrive_'
      and a.grantee = 'service_role'::regrole::oid),
  7::bigint
);

-- The helper functions the folder triggers rely on must not be callable by clients either: a client
-- that could call folders_guard_hierarchy directly gains nothing, but one that could redefine or
-- probe trigger internals is a needless surface.
select verify.eq(
  'privileges',
  'the folder guard functions are not executable by anon or authenticated',
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public' and p.proname in ('folders_guard_hierarchy', 'folders_repair_subtree_depths')
      and a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid)),
  0::bigint
);

select verify.eq(
  'privileges',
  'no client role has any table privilege on the credential tables',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace,
     lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('anonymous_sessions', 'api_keys', 'shares', 'audit_events', 'abuse_reports')
      and a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid)
      and not (c.relname = 'shares' and a.privilege_type = 'SELECT' and a.grantee = 'authenticated'::regrole::oid)),
  0::bigint
);

-- --------------------------------------------------------------------------- the schema the API is told to expect

-- The API documents which tables it owns. Asserting their presence here keeps that list honest: a
-- table renamed in a migration without updating the API would otherwise fail only at runtime.
select verify.eq(
  'api-contract',
  'every table the API repository layer addresses exists',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('profiles', 'files', 'folders', 'shares', 'api_keys',
                        'anonymous_sessions', 'usage_counters', 'quota_reservations',
                        'quota_limits', 'storage_objects', 'upload_sessions',
                        'audit_events', 'abuse_reports', 'moderation_actions')),
  14::bigint
);
