-- Suite 2: constraints and referential actions on the core metadata tables.
--
-- Runs as the migration owner, so a failure here is a constraint failure and not a permission
-- check (permissions are suite 3's subject). Every rejection names the constraint, index, enum or
-- column it must fail on, so a statement that breaks for an unrelated reason fails the suite
-- instead of quietly satisfying it. The recorded detail is the SQLSTATE and the server's message.
--
-- Identity and ownership constraints on the Phase 1 tables (anonymous sessions, folders, quota) are
-- suite 4's subject; file *placement* and the exactly-one-principal rule are covered there too.

set search_path = public, verify;

-- This suite owns its fixtures, so it starts from empty tables: run order must not matter.
-- quota_limits is deliberately NOT truncated: it holds reference data the migration seeds,
-- not test fixtures.
truncate table public.files, public.folders, public.storage_objects, public.upload_sessions,
  public.shares, public.api_keys, public.audit_events, public.abuse_reports,
  public.moderation_actions, public.quota_reservations, public.usage_counters,
  public.anonymous_sessions, public.profiles, auth.users cascade;

-- Parent rows the child tables hang off.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'a@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'b@example.test');

insert into profiles (id, display_name) values
  ('11111111-1111-4111-8111-111111111111', 'Ada'),
  ('22222222-2222-4222-8222-222222222222', 'Bo');

insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, visibility, status)
values ('file_cdefgcdefgcdefgcdefgcdefgc', '11111111-1111-4111-8111-111111111111',
        'payload.bin', 4096, 'application/octet-stream', 'public', 'ready');

-- Bo owns a folder and nothing else. It exists so the account-deletion refusals below are caused
-- by the constraint under test rather than by an empty account that would happily delete.
insert into folders (id, owner_user_id, name) values
  ('fold_bcdefbcdefbcdefbcdefbcdefb', '22222222-2222-4222-8222-222222222222', 'Bo documents');

-- --------------------------------------------------------------------------- files: identifiers

select verify.rejected(
  'identifiers',
  'file id without the file_ prefix is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('xabcdeabcdeabcdeabcdeabcdef', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream')$sql$,
  'files_id_check'
);

select verify.rejected(
  'identifiers',
  'file id with uppercase characters is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_ABCDEABCDEABCDEABCDEABCDEF', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream')$sql$,
  'files_id_check'
);

select verify.rejected(
  'identifiers',
  'file id that is too short is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcde', '11111111-1111-4111-8111-111111111111', 'a.bin', 1, 'application/octet-stream')$sql$,
  'files_id_check'
);

select verify.rejected(
  'identifiers',
  'file id containing the ambiguous character i is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_iiiiiiiiiiiiiiiiiiiiiiiiii', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream')$sql$,
  'files_id_check'
);

select verify.accepted(
  'identifiers',
  'well-formed file id in the unambiguous base-32 alphabet is accepted',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_fghjkfghjkfghjkfghjkfghjkm', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream')$sql$
);

select verify.rejected(
  'identifiers',
  'checksum_sha256 must be 64 lowercase hex characters',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, checksum_sha256)
       values ('file_abcdeabcdeabcdeabcdeabcdeg', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', 'DEADBEEF')$sql$,
  'files_checksum_sha256_check'
);

select verify.accepted(
  'identifiers',
  'a valid sha256 checksum is accepted',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, checksum_sha256)
       values ('file_abcdeabcdeabcdeabcdeabcdeg', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', repeat('a', 64))$sql$
);

select verify.rejected(
  'identifiers',
  'deletion_token_hash must be a sha256 hex digest',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, deletion_token_hash)
       values ('file_abcdeabcdeabcdeabcdeabcdeh', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', 'not-a-hash')$sql$,
  'files_deletion_token_hash_check'
);

-- --------------------------------------------------------------------------- files: the 2 GiB cap

select verify.rejected(
  'limits',
  'a file one byte above 2 GiB is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcdeabcdeabcdeabcdeabcdej', '11111111-1111-4111-8111-111111111111',
               'huge.bin', 2147483649, 'application/octet-stream')$sql$,
  'files_size_bytes_check'
);

select verify.accepted(
  'limits',
  'a file of exactly 2 GiB is accepted (the product target boundary)',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcdeabcdeabcdeabcdeabcdej', '11111111-1111-4111-8111-111111111111',
               'huge.bin', 2147483648, 'application/octet-stream')$sql$
);

select verify.rejected(
  'limits',
  'a zero-byte file is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcdeabcdeabcdeabcdeabcdek', '11111111-1111-4111-8111-111111111111',
               'empty.bin', 0, 'application/octet-stream')$sql$,
  'files_size_bytes_check'
);

select verify.rejected(
  'limits',
  'a negative size is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcdeabcdeabcdeabcdeabcdek', '11111111-1111-4111-8111-111111111111',
               'negative.bin', -1, 'application/octet-stream')$sql$,
  'files_size_bytes_check'
);

select verify.rejected(
  'limits',
  'an empty filename is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcdeabcdeabcdeabcdeabcdem', '11111111-1111-4111-8111-111111111111',
               '', 1, 'application/octet-stream')$sql$,
  'files_original_filename_check'
);

select verify.rejected(
  'limits',
  'a filename longer than 255 characters is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcdeabcdeabcdeabcdeabcdem', '11111111-1111-4111-8111-111111111111',
               repeat('n', 256), 1, 'application/octet-stream')$sql$,
  'files_original_filename_check'
);

-- --------------------------------------------------------------------------- files: state consistency

select verify.rejected(
  'state',
  'status deleted without deleted_at is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status)
       values ('file_abcdeabcdeabcdeabcdeabcden', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', 'deleted')$sql$,
  'files_deleted_consistency'
);

select verify.rejected(
  'state',
  'deleted_at set while status is not deleted is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status, deleted_at)
       values ('file_abcdeabcdeabcdeabcdeabcden', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', 'ready', now())$sql$,
  'files_deleted_consistency'
);

select verify.accepted(
  'state',
  'a soft-deleted file carrying deleted_at is accepted',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status, deleted_at)
       values ('file_abcdeabcdeabcdeabcdeabcden', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', 'deleted', now())$sql$
);

select verify.rejected(
  'state',
  'quarantined with scan_state clean is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status, scan_state)
       values ('file_abcdeabcdeabcdeabcdeabcdes', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', 'quarantined', 'clean')$sql$,
  'files_quarantine_reason'
);

select verify.accepted(
  'state',
  'quarantined with scan_state infected is accepted',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status, scan_state)
       values ('file_abcdeabcdeabcdeabcdeabcdes', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', 'quarantined', 'infected')$sql$
);

-- Phase 1: a servable file cannot be deleted or infected at the same time.
select verify.rejected(
  'state',
  'a ready file with deleted_at set is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status, deleted_at, updated_at)
       values ('file_abcdeabcdeabcdeabcdeabcdet', '11111111-1111-4111-8111-111111111111',
               'a.bin', 1, 'application/octet-stream', 'ready', now(), now())$sql$,
  'files_deleted_consistency'
);

select verify.rejected(
  'state',
  'a ready file that is marked infected is rejected',
  $sql$update files set status = 'ready', scan_state = 'infected'
        where id = 'file_abcdeabcdeabcdeabcdeabcdes'$sql$,
  'files_ready_is_servable'
);

select verify.accepted(
  'state',
  'an uploaded file awaits scanning as a non-servable state',
  $sql$update files set status = 'uploaded' where id = 'file_cdefgcdefgcdefgcdefgcdefgc'$sql$
);

select verify.accepted(
  'state',
  'a scanned clean file can become ready',
  $sql$update files set scan_state = 'clean', scanned_at = now(), status = 'ready'
        where id = 'file_cdefgcdefgcdefgcdefgcdefgc'$sql$
);

select verify.rejected(
  'state',
  'an unknown scan_state is rejected',
  $sql$update files set scan_state = 'probably-fine' where id = 'file_cdefgcdefgcdefgcdefgcdefgc'$sql$,
  'files_scan_state_check'
);

select verify.rejected(
  'state',
  'an unknown file visibility is rejected',
  $sql$update files set visibility = 'secret' where id = 'file_cdefgcdefgcdefgcdefgcdefgc'$sql$,
  'invalid input value for enum file_visibility'
);

select verify.rejected(
  'state',
  'an unknown file status is rejected',
  $sql$update files set status = 'ready-ish' where id = 'file_cdefgcdefgcdefgcdefgcdefgc'$sql$,
  'invalid input value for enum file_status'
);

select verify.rejected(
  'state',
  'the pre-Phase-1 state name available is no longer valid',
  $sql$update files set status = 'available' where id = 'file_cdefgcdefgcdefgcdefgcdefgc'$sql$,
  'invalid input value for enum file_status'
);

-- --------------------------------------------------------------------------- files: ownership

select verify.rejected(
  'ownership',
  'owner_user_id referencing a nonexistent profile is rejected',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcdeabcdeabcdeabcdeabcdeq', '33333333-3333-4333-8333-333333333333',
               'a.bin', 1, 'application/octet-stream')$sql$,
  'files_owner_user_id_fkey'
);

select verify.accepted(
  'ownership',
  'owner_user_id referencing an existing profile is accepted',
  $sql$insert into files (id, owner_user_id, original_filename, size_bytes, mime_type)
       values ('file_abcdeabcdeabcdeabcdeabcdeq', '11111111-1111-4111-8111-111111111111',
               'owned.bin', 1, 'application/octet-stream')$sql$
);

-- --------------------------------------------------------------------------- storage_objects

select verify.accepted(
  'storage_objects',
  'the first active storage object for a file is accepted',
  $sql$insert into storage_objects (id, file_id, provider_id, provider_ref, size_bytes)
       values ('sobj_abcdeabcdeabcdeabcdeabcdef', 'file_cdefgcdefgcdefgcdefgcdefgc', 'local-fs',
               '{"path":"/srv/objects/ab"}'::jsonb, 4096)$sql$
);

select verify.rejected(
  'storage_objects',
  'a second active storage object for the same file is rejected',
  $sql$insert into storage_objects (id, file_id, provider_id, provider_ref, size_bytes)
       values ('sobj_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'telegram',
               '{"chat_id":1,"message_id":2}'::jsonb, 4096)$sql$,
  'storage_objects_one_active_per_file'
);

select verify.accepted(
  'storage_objects',
  'a non-active storage object for the same file is accepted (the migration path)',
  $sql$insert into storage_objects (id, file_id, provider_id, provider_ref, size_bytes, state)
       values ('sobj_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'telegram',
               '{"chat_id":1,"message_id":2}'::jsonb, 4096, 'orphaned')$sql$
);

select verify.rejected(
  'storage_objects',
  'a storage object with zero size is rejected',
  $sql$insert into storage_objects (id, file_id, provider_id, provider_ref, size_bytes)
       values ('sobj_cdefgcdefgcdefgcdefgcdefgc', 'file_cdefgcdefgcdefgcdefgcdefgc', 'local-fs', '{}'::jsonb, 0)$sql$,
  'storage_objects_size_bytes_check'
);

select verify.rejected(
  'storage_objects',
  'an unknown storage object state is rejected',
  $sql$update storage_objects set state = 'lost' where id = 'sobj_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'storage_objects_state_check'
);

select verify.accepted(
  'storage_objects',
  'provider_ref holds provider-specific identifiers as jsonb metadata',
  $sql$update storage_objects set provider_ref = '{"chat_id":-1001234567890,"message_id":42}'::jsonb
        where id = 'sobj_abcdeabcdeabcdeabcdeabcdef'$sql$
);

-- --------------------------------------------------------------------------- upload_sessions

insert into upload_sessions (id, file_id, declared_size_bytes, chunk_size_bytes)
values ('upl_abcdeabcdeabcdeabcdeabcdef', 'file_cdefgcdefgcdefgcdefgcdefgc', 2147483648, 8388608);

select verify.eq(
  'upload_sessions',
  'a session past its expiry is created with a 24 hour default window',
  (select expires_at > initiated_at + interval '23 hours'
     from upload_sessions where id = 'upl_abcdeabcdeabcdeabcdeabcdef'),
  true
);

select verify.eq(
  'upload_sessions',
  'bytes_received starts at zero',
  (select bytes_received from upload_sessions where id = 'upl_abcdeabcdeabcdeabcdeabcdef'),
  0::bigint
);

select verify.rejected(
  'upload_sessions',
  'a chunk size below the 1 MiB floor is rejected',
  $sql$insert into upload_sessions (id, file_id, declared_size_bytes, chunk_size_bytes)
       values ('upl_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 1024, 524288)$sql$,
  'upload_sessions_chunk_size_bytes_check'
);

select verify.rejected(
  'upload_sessions',
  'a chunk size above the 64 MiB ceiling is rejected',
  $sql$insert into upload_sessions (id, file_id, declared_size_bytes, chunk_size_bytes)
       values ('upl_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 1024, 67108865)$sql$,
  'upload_sessions_chunk_size_bytes_check'
);

select verify.accepted(
  'upload_sessions',
  'chunk sizes at both bounds (1 MiB, 64 MiB) are accepted',
  $sql$insert into upload_sessions (id, file_id, declared_size_bytes, chunk_size_bytes)
       values ('upl_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 134217728, 1048576),
              ('upl_cdefgcdefgcdefgcdefgcdefgc', 'file_cdefgcdefgcdefgcdefgcdefgc', 134217728, 67108864)$sql$
);

select verify.rejected(
  'upload_sessions',
  'a declared size above 2 GiB is rejected',
  $sql$insert into upload_sessions (id, file_id, declared_size_bytes, chunk_size_bytes)
       values ('upl_fghjkfghjkfghjkfghjkfghjkm', 'file_cdefgcdefgcdefgcdefgcdefgc', 2147483649, 8388608)$sql$,
  'upload_sessions_declared_size_bytes_check'
);

select verify.rejected(
  'upload_sessions',
  'bytes_received exceeding the declared size is rejected',
  $sql$update upload_sessions set bytes_received = declared_size_bytes + 1
        where id = 'upl_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'upload_sessions_received_within_declared'
);

select verify.accepted(
  'upload_sessions',
  'bytes_received equal to the declared size is accepted',
  $sql$update upload_sessions set bytes_received = declared_size_bytes, state = 'finalized'
        where id = 'upl_abcdeabcdeabcdeabcdeabcdef'$sql$
);

select verify.rejected(
  'upload_sessions',
  'a negative parts_received is rejected',
  $sql$update upload_sessions set parts_received = -1 where id = 'upl_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'upload_sessions_parts_received_check'
);

select verify.rejected(
  'upload_sessions',
  'a non-positive parts_expected is rejected',
  $sql$update upload_sessions set parts_expected = 0 where id = 'upl_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'upload_sessions_parts_expected_check'
);

select verify.rejected(
  'upload_sessions',
  'an unknown upload state is rejected',
  $sql$update upload_sessions set state = 'paused' where id = 'upl_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'invalid input value for enum upload_state'
);

-- --------------------------------------------------------------------------- shares

insert into shares (id, file_id, kind, token_hash, created_by)
values ('shr_abcdeabcdeabcdeabcdeabcdef', 'file_cdefgcdefgcdefgcdefgcdefgc', 'unlisted', repeat('ab', 32),
        '11111111-1111-4111-8111-111111111111');

select verify.eq(
  'shares',
  'a new share link is active',
  (select status::text from shares where id = 'shr_abcdeabcdeabcdeabcdeabcdef'),
  'active'
);

select verify.rejected(
  'shares',
  'a duplicate token hash is rejected',
  $sql$insert into shares (id, file_id, token_hash)
       values ('shr_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', repeat('ab', 32))$sql$,
  'shares_token_hash_key'
);

select verify.rejected(
  'shares',
  'a token hash that is not a sha256 digest is rejected',
  $sql$insert into shares (id, file_id, token_hash)
       values ('shr_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'plaintext-token')$sql$,
  'shares_token_hash_check'
);

select verify.rejected(
  'shares',
  'max_downloads of zero is rejected (use null for unlimited)',
  $sql$insert into shares (id, file_id, token_hash, max_downloads)
       values ('shr_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', repeat('cd', 32), 0)$sql$,
  'shares_max_downloads_check'
);

select verify.rejected(
  'shares',
  'a negative download_count is rejected',
  $sql$update shares set download_count = -1 where id = 'shr_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'shares_download_count_check'
);

select verify.accepted(
  'shares',
  'an unlisted share with no expiry and no download cap is accepted',
  $sql$insert into shares (id, file_id, kind, token_hash)
       values ('shr_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'unlisted', repeat('cd', 32))$sql$
);

select verify.rejected(
  'shares',
  'an unknown share kind is rejected',
  $sql$update shares set kind = 'secret' where id = 'shr_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'invalid input value for enum share_kind'
);

-- Phase 1: revocation is recorded in two places and they must agree.
select verify.rejected(
  'shares',
  'status revoked without revoked_at is rejected',
  $sql$update shares set status = 'revoked' where id = 'shr_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'shares_revoked_consistency'
);

select verify.rejected(
  'shares',
  'revoked_at set while status stays active is rejected',
  $sql$update shares set revoked_at = now() where id = 'shr_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'shares_revoked_consistency'
);

select verify.accepted(
  'shares',
  'revoking a share sets both status and revoked_at',
  $sql$update shares set status = 'revoked', revoked_at = now()
        where id = 'shr_abcdeabcdeabcdeabcdeabcdef'$sql$
);

select verify.rejected(
  'shares',
  'an unknown share status is rejected',
  $sql$update shares set status = 'suspended'
        where id = 'shr_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'invalid input value for enum share_status'
);

-- --------------------------------------------------------------------------- api_keys

select verify.accepted(
  'api_keys',
  'an API key with a subset of the known scopes is accepted',
  $sql$insert into api_keys (id, owner_id, name, key_prefix, key_hash, scopes)
       values ('key_abcdeabcdeabcdeabcdeabcdef', '11111111-1111-4111-8111-111111111111',
               'laptop', 'odk_abcdefgh', repeat('12', 32), array['files:read', 'files:write'])$sql$
);

select verify.rejected(
  'api_keys',
  'an unknown scope is rejected',
  $sql$insert into api_keys (id, owner_id, name, key_prefix, key_hash, scopes)
       values ('key_bcdefbcdefbcdefbcdefbcdefb', '11111111-1111-4111-8111-111111111111',
               'rogue', 'odk_bcdefghj', repeat('34', 32), array['files:read', 'admin:everything'])$sql$,
  'api_keys_scopes_known'
);

select verify.rejected(
  'api_keys',
  'a malformed key prefix is rejected',
  $sql$insert into api_keys (id, owner_id, name, key_prefix, key_hash)
       values ('key_bcdefbcdefbcdefbcdefbcdefb', '11111111-1111-4111-8111-111111111111',
               'short', 'odk_short', repeat('34', 32))$sql$,
  'api_keys_key_prefix_check'
);

select verify.rejected(
  'api_keys',
  'a duplicate key prefix is rejected',
  $sql$insert into api_keys (id, owner_id, name, key_prefix, key_hash)
       values ('key_bcdefbcdefbcdefbcdefbcdefb', '11111111-1111-4111-8111-111111111111',
               'dupe', 'odk_abcdefgh', repeat('56', 32))$sql$,
  'api_keys_key_prefix_key'
);

select verify.rejected(
  'api_keys',
  'an API key with no owner is rejected',
  $sql$insert into api_keys (id, name, key_prefix, key_hash)
       values ('key_bcdefbcdefbcdefbcdefbcdefb', 'ownerless', 'odk_bcdefghj', repeat('78', 32))$sql$,
  'owner_id'
);

select verify.accepted(
  'api_keys',
  'an API key with an empty scope list is accepted (safe default: can do nothing)',
  $sql$insert into api_keys (id, owner_id, name, key_prefix, key_hash, scopes)
       values ('key_bcdefbcdefbcdefbcdefbcdefb', '11111111-1111-4111-8111-111111111111',
               'readonly', 'odk_bcdefghj', repeat('56', 32), '{}')$sql$
);

-- --------------------------------------------------------------------------- audit_events

select verify.rejected(
  'audit_events',
  'actor_kind anonymous with an actor_user_id is rejected',
  $sql$insert into audit_events (id, actor_kind, actor_user_id, action, subject_type)
       values ('evt_abcdeabcdeabcdeabcdeabcdef', 'anonymous', '11111111-1111-4111-8111-111111111111',
               'file.download', 'file')$sql$,
  'audit_events_actor_consistency'
);

select verify.rejected(
  'audit_events',
  'actor_kind service with an actor_user_id is rejected',
  $sql$insert into audit_events (id, actor_kind, actor_user_id, action, subject_type)
       values ('evt_abcdeabcdeabcdeabcdeabcdef', 'service', '11111111-1111-4111-8111-111111111111',
               'file.download', 'file')$sql$,
  'audit_events_actor_consistency'
);

select verify.accepted(
  'audit_events',
  'actor_kind user with an actor_user_id is accepted',
  $sql$insert into audit_events (id, actor_kind, actor_user_id, actor_ip_hash, action, subject_type, subject_id)
       values ('evt_abcdeabcdeabcdeabcdeabcdef', 'user', '11111111-1111-4111-8111-111111111111',
               repeat('9a', 32), 'file.upload', 'file', 'file_cdefgcdefgcdefgcdefgcdefgc')$sql$
);

select verify.rejected(
  'audit_events',
  'a raw IP address stored as actor_ip_hash is rejected',
  $sql$insert into audit_events (id, actor_kind, action, subject_type, actor_ip_hash)
       values ('evt_bcdefbcdefbcdefbcdefbcdefb', 'anonymous', 'file.download', 'file', '203.0.113.7')$sql$,
  'audit_events_actor_ip_hash_check'
);

select verify.rejected(
  'audit_events',
  'an unknown subject_type is rejected',
  $sql$insert into audit_events (id, actor_kind, action, subject_type)
       values ('evt_bcdefbcdefbcdefbcdefbcdefb', 'anonymous', 'file.download', 'user')$sql$,
  'audit_events_subject_type_check'
);

select verify.rejected(
  'audit_events',
  'an action longer than 64 characters is rejected',
  $sql$insert into audit_events (id, actor_kind, action, subject_type)
       values ('evt_bcdefbcdefbcdefbcdefbcdefb', 'anonymous', repeat('x', 65), 'file')$sql$,
  'audit_events_action_check'
);

-- --------------------------------------------------------------------------- abuse and moderation

insert into abuse_reports (id, file_id, reason, details)
values ('rpt_abcdeabcdeabcdeabcdeabcdef', 'file_cdefgcdefgcdefgcdefgcdefgc', 'copyright', 'Reported by rights holder.');

select verify.eq(
  'abuse_reports',
  'a new report starts in the open state',
  (select state::text from abuse_reports where id = 'rpt_abcdeabcdeabcdeabcdeabcdef'),
  'open'
);

select verify.rejected(
  'abuse_reports',
  'details longer than 4000 characters are rejected',
  $sql$insert into abuse_reports (id, file_id, reason, details)
       values ('rpt_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'spam', repeat('x', 4001))$sql$,
  'abuse_reports_details_check'
);

select verify.rejected(
  'abuse_reports',
  'an unknown report reason is rejected',
  $sql$insert into abuse_reports (id, file_id, reason)
       values ('rpt_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'rude')$sql$,
  'invalid input value for enum abuse_reason'
);

select verify.rejected(
  'abuse_reports',
  'a raw reporter IP address is rejected in reporter_ip_hash',
  $sql$insert into abuse_reports (id, file_id, reason, reporter_ip_hash)
       values ('rpt_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'spam', '198.51.100.9')$sql$,
  'abuse_reports_reporter_ip_hash_check'
);

insert into moderation_actions (id, report_id, file_id, action, actor_user_id, note)
values ('mod_abcdeabcdeabcdeabcdeabcdef', 'rpt_abcdeabcdeabcdeabcdeabcdef', 'file_cdefgcdefgcdefgcdefgcdefgc',
        'quarantine', '11111111-1111-4111-8111-111111111111', 'Awaiting scanner verdict.');

select verify.rejected(
  'moderation_actions',
  'an unknown moderation action is rejected',
  $sql$insert into moderation_actions (id, file_id, action)
       values ('mod_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'rm -rf')$sql$,
  'moderation_actions_action_check'
);

select verify.rejected(
  'moderation_actions',
  'a note longer than 2000 characters is rejected',
  $sql$insert into moderation_actions (id, file_id, action, note)
       values ('mod_bcdefbcdefbcdefbcdefbcdefb', 'file_cdefgcdefgcdefgcdefgcdefgc', 'none', repeat('x', 2001))$sql$,
  'moderation_actions_note_check'
);

-- --------------------------------------------------------------------------- profiles

select verify.rejected(
  'profiles',
  'an empty display name is rejected',
  $sql$update profiles set display_name = '' where id = '11111111-1111-4111-8111-111111111111'$sql$,
  'profiles_display_name_check'
);

select verify.rejected(
  'profiles',
  'a display name longer than 80 characters is rejected',
  $sql$update profiles set display_name = repeat('x', 81) where id = '11111111-1111-4111-8111-111111111111'$sql$,
  'profiles_display_name_check'
);

select verify.rejected(
  'profiles',
  'a zero-byte storage quota is rejected',
  $sql$update profiles set storage_quota_bytes = 0 where id = '11111111-1111-4111-8111-111111111111'$sql$,
  'profiles_storage_quota_bytes_check'
);

select verify.rejected(
  'profiles',
  'a zero file-count limit is rejected',
  $sql$update profiles set max_files = 0 where id = '11111111-1111-4111-8111-111111111111'$sql$,
  'profiles_max_files_check'
);

select verify.rejected(
  'profiles',
  'a profile id that is not an auth user is rejected',
  $sql$insert into profiles (id, display_name) values ('44444444-4444-4444-8444-444444444444', 'Ghost')$sql$,
  'profiles_id_fkey'
);

select verify.rejected(
  'profiles',
  'a duplicate profile for the same auth user is rejected',
  $sql$insert into profiles (id, display_name) values ('11111111-1111-4111-8111-111111111111', 'Ada again')$sql$,
  'profiles_pkey'
);

select verify.rejected(
  'profiles',
  'an unknown account status is rejected',
  $sql$update profiles set status = 'paused' where id = '11111111-1111-4111-8111-111111111111'$sql$,
  'invalid input value for enum account_status'
);

select verify.accepted(
  'profiles',
  'suspending an account is recorded on the profile',
  $sql$update profiles set status = 'suspended' where id = '11111111-1111-4111-8111-111111111111'$sql$
);

select verify.accepted(
  'profiles',
  'reactivating an account is recorded on the profile',
  $sql$update profiles set status = 'active' where id = '11111111-1111-4111-8111-111111111111'$sql$
);

-- --------------------------------------------------------------------------- referential actions

-- Deleting a file must not leave children behind: they are cascades, not cleanup jobs.
delete from files where id = 'file_cdefgcdefgcdefgcdefgcdefgc';

select verify.eq(
  'cascades',
  'deleting a file cascades to its storage objects',
  (select count(*) from storage_objects where file_id = 'file_cdefgcdefgcdefgcdefgcdefgc'),
  0::bigint
);

select verify.eq(
  'cascades',
  'deleting a file cascades to its upload sessions',
  (select count(*) from upload_sessions where file_id = 'file_cdefgcdefgcdefgcdefgcdefgc'),
  0::bigint
);

select verify.eq(
  'cascades',
  'deleting a file cascades to its shares',
  (select count(*) from shares where file_id = 'file_cdefgcdefgcdefgcdefgcdefgc'),
  0::bigint
);

select verify.eq(
  'cascades',
  'deleting a file cascades to its abuse reports',
  (select count(*) from abuse_reports where file_id = 'file_cdefgcdefgcdefgcdefgcdefgc'),
  0::bigint
);

select verify.eq(
  'cascades',
  'deleting a file cascades to its moderation actions',
  (select count(*) from moderation_actions where file_id = 'file_cdefgcdefgcdefgcdefgcdefgc'),
  0::bigint
);

select verify.eq(
  'cascades',
  'deleting a file cascades to its quota reservations',
  (select count(*) from quota_reservations where file_id = 'file_cdefgcdefgcdefgcdefgcdefgc'),
  0::bigint
);

-- Phase 1 changes the shape of account deletion. `restrict` (not `set null`, not `cascade`) means
-- an account with resources cannot be deleted by a stray DELETE: the application has to deal with
-- the files — and with the bytes behind them — first. `set null` would have violated the
-- exactly-one-principal rule; `cascade` would have destroyed metadata while leaving bytes in a
-- storage provider with nothing referencing them.
select verify.rejected(
  'cascades',
  'deleting a profile that still owns files is refused',
  $sql$delete from profiles where id = '11111111-1111-4111-8111-111111111111'$sql$,
  'files_owner_user_id_fkey'
);

select verify.rejected(
  'cascades',
  'deleting a profile that still owns folders is refused',
  $sql$delete from profiles where id = '22222222-2222-4222-8222-222222222222'$sql$,
  'folders_owner_user_id_fkey'
);

-- A share whose creator still has files is refused for the same reason; the point is that the
-- refusal names the resource that must be dealt with.
select verify.rejected(
  'cascades',
  'deleting an auth user whose profile still owns resources is refused',
  $sql$delete from auth.users where id = '22222222-2222-4222-8222-222222222222'$sql$,
  'folders_owner_user_id_fkey'
);

-- Bo owns a folder and no files; remove the folder, then the account can be deleted and the
-- profile goes with it (auth.users -> profiles is a cascade).
delete from folders where owner_user_id = '22222222-2222-4222-8222-222222222222';
delete from auth.users where id = '22222222-2222-4222-8222-222222222222';

select verify.eq(
  'cascades',
  'deleting an auth user cascades to its profile once nothing owns it',
  (select count(*) from profiles where id = '22222222-2222-4222-8222-222222222222'),
  0::bigint
);

-- Ada still owns files, so her account deletion needs the resources gone first. Do that, then
-- assert what survives and what disappears.
insert into shares (id, file_id, kind, token_hash, created_by)
values ('shr_cdefgcdefgcdefgcdefgcdefgc', 'file_abcdeabcdeabcdeabcdeabcdej', 'unlisted', repeat('ef', 32),
        '11111111-1111-4111-8111-111111111111');

insert into audit_events (id, actor_kind, actor_user_id, action, subject_type)
values ('evt_cdefgcdefgcdefgcdefgcdefgc', 'user', '11111111-1111-4111-8111-111111111111', 'file.upload', 'file');

delete from files where owner_user_id = '11111111-1111-4111-8111-111111111111';
delete from folders where owner_user_id = '11111111-1111-4111-8111-111111111111';
delete from profiles where id = '11111111-1111-4111-8111-111111111111';

select verify.eq(
  'cascades',
  'removing an account cascades to its API keys (they cannot outlive their owner)',
  (select count(*) from api_keys where owner_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint
);

select verify.eq(
  'cascades',
  'audit events survive account deletion with actor_user_id nulled',
  (select count(*) from audit_events where id = 'evt_cdefgcdefgcdefgcdefgcdefgc' and actor_user_id is null),
  1::bigint
);
