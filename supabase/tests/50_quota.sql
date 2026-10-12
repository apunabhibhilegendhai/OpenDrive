-- Suite 5: quota enforcement, reservations and usage counters.
--
-- Quota is the one place where a check-then-act bug is silent: two uploads each see room, both
-- proceed, and nothing fails until the account is far over its limit. The functions in
-- 20261011000001 exist to make that impossible, and this suite exercises every branch of them —
-- including the refusals, which is where the real behaviour lives.
--
-- The sequence below follows one upload through reserve -> commit -> finalize, then a second and a
-- third, so each number can be checked by hand against the quota it was computed from.
--
-- The function calls run as `service_role`, the role the API actually uses, so the grants these
-- functions need are part of what is tested. Two-connection concurrency is tested separately, in
-- tests/integration, because that is the only place two sessions can be held open at once.

set search_path = public, verify;

truncate table public.files, public.folders, public.storage_objects, public.upload_sessions,
  public.shares, public.api_keys, public.audit_events, public.abuse_reports,
  public.moderation_actions, public.quota_reservations, public.usage_counters,
  public.anonymous_sessions, public.profiles, auth.users cascade;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'quota@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'other@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'daily@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'suspended@example.test');

-- Deliberately small quotas, so every number the functions return can be checked by hand.
insert into profiles (id, display_name, storage_quota_bytes, max_file_size_bytes, max_files) values
  ('11111111-1111-4111-8111-111111111111', 'Quota', 10000, 5000, 4),
  ('22222222-2222-4222-8222-222222222222', 'Other', 10000, 5000, 4),
  ('33333333-3333-4333-8333-333333333333', 'Daily', 10000, 5000, 4),
  ('44444444-4444-4444-8444-444444444444', 'Suspended', 10000, 5000, 4);

update profiles set status = 'suspended' where id = '44444444-4444-4444-8444-444444444444';

insert into anonymous_sessions (id, credential_hash, expires_at) values
  ('sess_abcdeabcdeabcdeabcdeabcdef', repeat('11', 32), now() + interval '24 hours');

-- Expired, and revoked. Both are unusable, by different mechanisms.
insert into anonymous_sessions (id, credential_hash, created_at, expires_at)
values ('sess_bcdefbcdefbcdefbcdefbcdefb', repeat('22', 32), now() - interval '2 hours',
        now() - interval '1 hour');

insert into anonymous_sessions (id, credential_hash, created_at, expires_at, status, revoked_at)
values ('sess_cdefgcdefgcdefgcdefgcdefgc', repeat('33', 32), now() - interval '2 hours',
        now() + interval '22 hours', 'revoked', now() - interval '1 hour');

-- Every file starts as pending_upload, which by definition holds no bytes. That matters: it is why
-- the quota below starts at zero even though five metadata rows already exist.
insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status) values
  ('file_qa0000000000000000000000aa', '11111111-1111-4111-8111-111111111111', 'qf1.bin', 4000,
   'application/octet-stream', 'pending_upload'),
  ('file_qb0000000000000000000000bb', '11111111-1111-4111-8111-111111111111', 'qf2.bin', 5000,
   'application/octet-stream', 'pending_upload'),
  ('file_qc0000000000000000000000cc', '11111111-1111-4111-8111-111111111111', 'qf3.bin', 2000,
   'application/octet-stream', 'pending_upload'),
  ('file_qe0000000000000000000000ee', '11111111-1111-4111-8111-111111111111', 'qf5.bin', 6000,
   'application/octet-stream', 'pending_upload'),
  ('file_qf0000000000000000000000ff', '22222222-2222-4222-8222-222222222222', 'other.bin', 100,
   'application/octet-stream', 'pending_upload'),
  ('file_qg0000000000000000000000gg', '33333333-3333-4333-8333-333333333333', 'daily-a.bin', 600,
   'application/octet-stream', 'pending_upload'),
  ('file_qh0000000000000000000000hh', '33333333-3333-4333-8333-333333333333', 'daily-b.bin', 600,
   'application/octet-stream', 'pending_upload');

-- The anonymous session's own file has durable bytes, so it counts against the session's quota.
insert into files (id, owner_session_id, original_filename, size_bytes, mime_type, status)
values ('file_qj0000000000000000000000jj', 'sess_abcdeabcdeabcdeabcdeabcdef', 'anon.bin', 1000,
        'application/octet-stream', 'ready');

-- --------------------------------------------------------------------------- refusals that need no state

set role service_role;

select verify.eq(
  'quota',
  'a principal must be exactly one of a user or a session',
  (opendrive_reserve_storage('resv_0000000000000000000000000a', null, null,
    'file_qa0000000000000000000000aa', 4000) ->> 'reason'),
  'invalid_principal'
);

select verify.eq(
  'quota',
  'passing both a user and a session is refused',
  (opendrive_reserve_storage('resv_0000000000000000000000000a',
    '11111111-1111-4111-8111-111111111111', 'sess_abcdeabcdeabcdeabcdeabcdef',
    'file_qa0000000000000000000000aa', 4000) ->> 'reason'),
  'invalid_principal'
);

select verify.eq(
  'quota',
  'a reservation for an unknown user is refused',
  (opendrive_reserve_storage('resv_0000000000000000000000000a',
    '55555555-5555-4555-8555-555555555555', null,
    'file_qa0000000000000000000000aa', 4000) ->> 'reason'),
  'owner_unknown'
);

select verify.eq(
  'quota',
  'a reservation for an unknown session is refused',
  (opendrive_reserve_storage('resv_0000000000000000000000000a', null,
    'sess_ffffffffffffffffffffffffff', 'file_qj0000000000000000000000jj', 1000) ->> 'reason'),
  'owner_unknown'
);

select verify.eq(
  'quota',
  'a suspended account cannot reserve quota',
  (opendrive_reserve_storage('resv_0000000000000000000000000a',
    '44444444-4444-4444-8444-444444444444', null,
    'file_qa0000000000000000000000aa', 4000) ->> 'reason'),
  'owner_not_active'
);

select verify.eq(
  'quota',
  'an expired session cannot start new work',
  (opendrive_reserve_storage('resv_0000000000000000000000000a', null,
    'sess_bcdefbcdefbcdefbcdefbcdefb', 'file_qj0000000000000000000000jj', 1000) ->> 'reason'),
  'session_expired'
);

select verify.eq(
  'quota',
  'a revoked session cannot start new work',
  (opendrive_reserve_storage('resv_0000000000000000000000000a', null,
    'sess_cdefgcdefgcdefgcdefgcdefgc', 'file_qj0000000000000000000000jj', 1000) ->> 'reason'),
  'session_revoked'
);

select verify.eq(
  'quota',
  'a reservation for an unknown file is refused',
  (opendrive_reserve_storage('resv_0000000000000000000000000a',
    '11111111-1111-4111-8111-111111111111', null,
    'file_zzzzzzzzzzzzzzzzzzzzzzzzzz', 1) ->> 'reason'),
  'file_not_found'
);

select verify.eq(
  'quota',
  'a reservation cannot be attached to another owner''s file',
  (opendrive_reserve_storage('resv_0000000000000000000000000a',
    '11111111-1111-4111-8111-111111111111', null,
    'file_qf0000000000000000000000ff', 100) ->> 'reason'),
  'owner_mismatch'
);

select verify.eq(
  'quota',
  'a caller cannot under-declare the size of the file it is reserving for',
  (opendrive_reserve_storage('resv_0000000000000000000000000a',
    '11111111-1111-4111-8111-111111111111', null,
    'file_qa0000000000000000000000aa', 1) ->> 'reason'),
  'size_mismatch'
);

select verify.eq(
  'quota',
  'a file larger than the per-file ceiling is refused by the reservation, not by the client',
  (opendrive_reserve_storage('resv_0000000000000000000000000a',
    '11111111-1111-4111-8111-111111111111', null,
    'file_qe0000000000000000000000ee', 6000) ->> 'reason'),
  'file_too_large'
);

-- --------------------------------------------------------------------------- one upload, end to end

create temp table quota_probe (step text primary key, result jsonb);

select verify.eq(
  'quota',
  'a principal with only pending_upload rows has used no storage',
  (opendrive_used_storage('11111111-1111-4111-8111-111111111111', null)),
  0::bigint
);

insert into pg_temp.quota_probe values ('qf1_reserve', opendrive_reserve_storage(
  'resv_00000000000000000000000001', '11111111-1111-4111-8111-111111111111', null,
  'file_qa0000000000000000000000aa', 4000));

select verify.eq(
  'quota',
  'a reservation within the quota succeeds',
  (select (result ->> 'ok')::boolean from pg_temp.quota_probe where step = 'qf1_reserve'),
  true
);

select verify.eq(
  'quota',
  'the result reports the limit, the usage including this reservation, and what is left',
  (select format('%s/%s/%s', result ->> 'storageUsedBytes', result ->> 'storageLimitBytes',
                 result ->> 'storageRemainingBytes')
     from pg_temp.quota_probe where step = 'qf1_reserve'),
  '4000/10000/6000'
);

select verify.eq(
  'quota',
  'the same file cannot hold two live reservations',
  (opendrive_reserve_storage('resv_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111', null,
    'file_qa0000000000000000000000aa', 4000) ->> 'reason'),
  'already_reserved'
);

select verify.eq(
  'quota',
  'a held reservation already consumes quota',
  (opendrive_used_storage('11111111-1111-4111-8111-111111111111', null)),
  4000::bigint
);

insert into pg_temp.quota_probe values ('qf1_commit', opendrive_commit_reservation(
  'resv_00000000000000000000000001'));

select verify.eq(
  'quota',
  'committing a reservation succeeds',
  (select (result ->> 'ok')::boolean from pg_temp.quota_probe where step = 'qf1_commit'),
  true
);

insert into pg_temp.quota_probe values ('qf1_commit_again', opendrive_commit_reservation(
  'resv_00000000000000000000000001'));

select verify.eq(
  'quota',
  'committing twice is idempotent and says so',
  (select (result ->> 'alreadyCommitted')::boolean from pg_temp.quota_probe where step = 'qf1_commit_again'),
  true
);

select verify.eq(
  'quota',
  'the lifetime counter records the committed bytes exactly once',
  (select storage_bytes from usage_counters
    where owner_user_id = '11111111-1111-4111-8111-111111111111' and period = 'lifetime'),
  4000::bigint
);

select verify.eq(
  'quota',
  'the lifetime counter records the file exactly once',
  (select file_count from usage_counters
    where owner_user_id = '11111111-1111-4111-8111-111111111111' and period = 'lifetime'),
  1
);

select verify.eq(
  'quota',
  'the day counter records today''s uploaded bytes exactly once',
  (select upload_bytes from usage_counters
    where owner_user_id = '11111111-1111-4111-8111-111111111111' and period = 'day'
      and period_start = date_trunc('day', now())),
  4000::bigint
);

-- Finalizing is the application's step, not the reservation's: the upload workflow marks the file
-- as having durable bytes, and only then do those bytes count as stored.
update files set status = 'uploaded' where id = 'file_qa0000000000000000000000aa';

select verify.eq(
  'quota',
  'once the upload is finalized, its bytes count as stored',
  (opendrive_used_storage('11111111-1111-4111-8111-111111111111', null)),
  4000::bigint
);

update files set status = 'ready', scan_state = 'clean', scanned_at = now()
 where id = 'file_qa0000000000000000000000aa';

select verify.eq(
  'quota',
  'a ready file''s bytes still count as stored',
  (opendrive_used_storage('11111111-1111-4111-8111-111111111111', null)),
  4000::bigint
);

update files set status = 'failed' where id = 'file_qe0000000000000000000000ee';

select verify.eq(
  'quota',
  'a failed upload''s bytes do not count as stored',
  (opendrive_used_storage('11111111-1111-4111-8111-111111111111', null)),
  4000::bigint
);

update files set status = 'pending_upload', scan_state = null, scanned_at = null, deleted_at = null
 where id = 'file_qe0000000000000000000000ee';

-- --------------------------------------------------------------------------- the second and third upload

insert into pg_temp.quota_probe values ('qf2_reserve', opendrive_reserve_storage(
  'resv_00000000000000000000000003', '11111111-1111-4111-8111-111111111111', null,
  'file_qb0000000000000000000000bb', 5000));

select verify.eq(
  'quota',
  'a second reservation is measured against stored usage plus other holds',
  (select (result ->> 'storageUsedBytes')::bigint from pg_temp.quota_probe where step = 'qf2_reserve'),
  9000::bigint
);

select verify.eq(
  'quota',
  'a third upload that would exceed the quota is refused, and told why',
  (opendrive_reserve_storage('resv_00000000000000000000000004',
    '11111111-1111-4111-8111-111111111111', null,
    'file_qc0000000000000000000000cc', 2000) ->> 'reason'),
  'storage_quota_exceeded'
);

select verify.eq(
  'quota',
  'the refusal carries the limit and the usage that caused it',
  (select format('%s/%s', opendrive_reserve_storage('resv_00000000000000000000000004',
      '11111111-1111-4111-8111-111111111111', null,
      'file_qc0000000000000000000000cc', 2000) ->> 'storageLimitBytes',
     opendrive_reserve_storage('resv_00000000000000000000000004',
      '11111111-1111-4111-8111-111111111111', null,
      'file_qc0000000000000000000000cc', 2000) ->> 'storageUsedBytes')),
  '10000/9000'
);

select verify.eq(
  'quota',
  'releasing a hold frees the quota it held',
  (opendrive_release_reservation('resv_00000000000000000000000003') ->> 'ok'),
  'true'
);

insert into pg_temp.quota_probe values ('qf3_reserve', opendrive_reserve_storage(
  'resv_00000000000000000000000005', '11111111-1111-4111-8111-111111111111', null,
  'file_qc0000000000000000000000cc', 2000));

select verify.eq(
  'quota',
  'after the release, the same upload succeeds',
  (select (result ->> 'ok')::boolean from pg_temp.quota_probe where step = 'qf3_reserve'),
  true
);

select verify.eq(
  'quota',
  'a released reservation is no longer counted',
  (select (result ->> 'storageUsedBytes')::bigint from pg_temp.quota_probe where step = 'qf3_reserve'),
  6000::bigint
);

-- --------------------------------------------------------------------------- expiry

insert into pg_temp.quota_probe values ('qf3_release', opendrive_release_reservation(
  'resv_00000000000000000000000005'));

select verify.eq(
  'quota',
  'with no holds left, only the finalized file counts',
  (opendrive_used_storage('11111111-1111-4111-8111-111111111111', null)),
  4000::bigint
);

-- An abandoned upload leaves a hold behind. Once it is past its TTL it must stop consuming quota,
-- and the same file must be reservable again — otherwise a crashed upload wedges that file forever.
insert into quota_reservations (id, file_id, owner_user_id, requested_bytes, state, created_at, expires_at)
values ('resv_00000000000000000000000007', 'file_qc0000000000000000000000cc',
        '11111111-1111-4111-8111-111111111111', 2000, 'held', now() - interval '2 hours',
        now() - interval '1 hour');

select verify.eq(
  'quota',
  'an expired hold is not counted against the quota',
  (opendrive_used_storage('11111111-1111-4111-8111-111111111111', null)),
  4000::bigint
);

insert into pg_temp.quota_probe values ('qf3_reserve_again', opendrive_reserve_storage(
  'resv_00000000000000000000000009', '11111111-1111-4111-8111-111111111111', null,
  'file_qc0000000000000000000000cc', 2000));

select verify.eq(
  'quota',
  'a retried upload for a file whose earlier hold expired succeeds',
  (select (result ->> 'ok')::boolean from pg_temp.quota_probe where step = 'qf3_reserve_again'),
  true
);

select verify.eq(
  'quota',
  'the stale hold was marked expired rather than left live',
  (select state::text from quota_reservations where id = 'resv_00000000000000000000000007'),
  'expired'
);

select verify.eq(
  'quota',
  'a file still holds at most one live reservation afterwards',
  (select count(*) from quota_reservations
    where file_id = 'file_qc0000000000000000000000cc' and state = 'held'),
  1::bigint
);

-- A hold that was already swept can no longer be committed: it is not held any more, and saying so
-- is more accurate than reporting an expiry it has already been recorded as having.
select verify.eq(
  'quota',
  'committing a swept hold is refused',
  (opendrive_commit_reservation('resv_00000000000000000000000007') ->> 'reason'),
  'reservation_not_held'
);

-- A hold that is still marked held but is past its expiry is the other case: the commit notices the
-- expiry itself and invalidates the row, so a late finalize cannot slip past the quota check.
insert into quota_reservations (id, file_id, owner_user_id, requested_bytes, state, created_at, expires_at)
values ('resv_0000000000000000000000000c', 'file_qe0000000000000000000000ee',
        '11111111-1111-4111-8111-111111111111', 6000, 'held', now() - interval '2 hours',
        now() - interval '1 hour');

select verify.eq(
  'quota',
  'committing an expired hold is refused',
  (opendrive_commit_reservation('resv_0000000000000000000000000c') ->> 'reason'),
  'reservation_expired'
);

select verify.eq(
  'quota',
  'the late commit invalidated the hold instead of committing it',
  (select state::text from quota_reservations where id = 'resv_0000000000000000000000000c'),
  'expired'
);

select verify.eq(
  'quota',
  'releasing an unknown reservation reports it rather than failing silently',
  (opendrive_release_reservation('resv_00000000000000000000000099') ->> 'reason'),
  'reservation_not_found'
);

select verify.eq(
  'quota',
  'releasing twice is idempotent',
  (select format('%s/%s',
     opendrive_release_reservation('resv_00000000000000000000000009') ->> 'alreadyReleased',
     opendrive_release_reservation('resv_00000000000000000000000009') ->> 'alreadyReleased')),
  'false/true'
);

select verify.eq(
  'quota',
  'committing after a release is refused (the hold is gone)',
  (opendrive_commit_reservation('resv_00000000000000000000000009') ->> 'reason'),
  'reservation_not_held'
);

select verify.eq(
  'quota',
  'releasing a committed reservation is refused',
  (opendrive_release_reservation('resv_00000000000000000000000001') ->> 'reason'),
  'already_committed'
);

insert into quota_reservations (id, file_id, owner_user_id, requested_bytes, state, created_at, expires_at)
values ('resv_0000000000000000000000000b', 'file_qb0000000000000000000000bb',
        '11111111-1111-4111-8111-111111111111', 5000, 'held', now() - interval '2 hours',
        now() - interval '1 hour');

select verify.eq(
  'quota',
  'the sweeper expires stale holds and reports how many',
  (opendrive_sweep_expired_reservations()),
  1
);

-- --------------------------------------------------------------------------- the file-count ceiling

-- The account is at 4 files (its ceiling) with 4000 of its 10000 bytes stored, so the refusal that
-- follows can only come from the count rule.
insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status)
values ('file_qd0000000000000000000000dd', '11111111-1111-4111-8111-111111111111', 'qf4.bin', 100,
        'application/octet-stream', 'pending_upload');

select verify.eq(
  'quota',
  'a fifth file is refused once the account is at its file ceiling',
  (opendrive_reserve_storage('resv_00000000000000000000000006',
    '11111111-1111-4111-8111-111111111111', null,
    'file_qd0000000000000000000000dd', 100) ->> 'reason'),
  'file_count_exceeded'
);

-- --------------------------------------------------------------------------- the summary the API returns

select verify.eq(
  'quota',
  'a user''s summary reports the profile limits and live usage',
  (select format('%s/%s/%s/%s/%s',
     opendrive_quota_summary('11111111-1111-4111-8111-111111111111', null) ->> 'principalKind',
     opendrive_quota_summary('11111111-1111-4111-8111-111111111111', null) ->> 'storageLimitBytes',
     opendrive_quota_summary('11111111-1111-4111-8111-111111111111', null) ->> 'storageUsedBytes',
     opendrive_quota_summary('11111111-1111-4111-8111-111111111111', null) ->> 'fileCount',
     opendrive_quota_summary('11111111-1111-4111-8111-111111111111', null) ->> 'maxFiles')),
  'user/10000/4000/5/4'
);

select verify.eq(
  'quota',
  'a user''s summary reports its account status',
  (select opendrive_quota_summary('44444444-4444-4444-8444-444444444444', null) ->> 'accountStatus'),
  'suspended'
);

select verify.eq(
  'quota',
  'an anonymous summary reads the anonymous policy, not a user profile',
  (select format('%s/%s/%s',
     opendrive_quota_summary(null, 'sess_abcdeabcdeabcdeabcdeabcdef') ->> 'principalKind',
     opendrive_quota_summary(null, 'sess_abcdeabcdeabcdeabcdeabcdef') ->> 'storageLimitBytes',
     opendrive_quota_summary(null, 'sess_abcdeabcdeabcdeabcdeabcdef') ->> 'storageUsedBytes')),
  'anonymous/5368709120/1000'
);

select verify.eq(
  'quota',
  'a summary for an unknown principal is refused, not fabricated',
  (opendrive_quota_summary('66666666-6666-4666-8666-666666666666', null) ->> 'reason'),
  'owner_unknown'
);

select verify.rejected(
  'quota',
  'a usage counter cannot be driven negative',
  $sql$update usage_counters set storage_bytes = -1
        where owner_user_id = '11111111-1111-4111-8111-111111111111' and period = 'lifetime'$sql$,
  'usage_counters_storage_bytes_check'
);

-- --------------------------------------------------------------------------- daily allowances

-- The daily upload allowance is policy data, not a constant, so this changes the policy rather than
-- trying to upload a gigabyte. It is restored immediately afterwards: a suite must not leave the
-- database in a state the next suite did not expect.
update quota_limits set upload_bytes_per_day = 10 where principal_kind = 'user';

select verify.eq(
  'quota',
  'the daily upload allowance refuses an upload that would exceed it',
  (opendrive_reserve_storage('resv_0000000000000000000000000c',
    '33333333-3333-4333-8333-333333333333', null,
    'file_qg0000000000000000000000gg', 600) ->> 'reason'),
  'upload_bandwidth_exceeded'
);

update quota_limits set upload_bytes_per_day = 1000 where principal_kind = 'user';

insert into pg_temp.quota_probe values ('daily_a', opendrive_reserve_storage(
  'resv_0000000000000000000000000d', '33333333-3333-4333-8333-333333333333', null,
  'file_qg0000000000000000000000gg', 600));

select verify.eq(
  'quota',
  'an upload inside the daily allowance is accepted',
  (select (result ->> 'ok')::boolean from pg_temp.quota_probe where step = 'daily_a'),
  true
);

select verify.eq(
  'quota',
  'today''s outstanding holds count towards the daily allowance, so parallel uploads cannot each pass',
  (opendrive_reserve_storage('resv_0000000000000000000000000e',
    '33333333-3333-4333-8333-333333333333', null,
    'file_qh0000000000000000000000hh', 600) ->> 'reason'),
  'upload_bandwidth_exceeded'
);

update quota_limits set upload_bytes_per_day = 10 where principal_kind = 'anonymous';

select verify.eq(
  'quota',
  'the anonymous upload allowance is enforced for sessions',
  (opendrive_reserve_storage('resv_0000000000000000000000000f', null,
    'sess_abcdeabcdeabcdeabcdeabcdef', 'file_qj0000000000000000000000jj', 1000) ->> 'reason'),
  'upload_bandwidth_exceeded'
);

update quota_limits set upload_bytes_per_day = null where principal_kind = 'anonymous';
update quota_limits set upload_bytes_per_day = null where principal_kind = 'user';

select verify.eq(
  'quota',
  'the policy is restored to unlimited daily uploads for both kinds',
  (select count(*) from quota_limits where upload_bytes_per_day is not null),
  0::bigint
);

reset role;
