-- Development seed data.
--
-- For local development and the throwaway verification database only. It is deliberately NOT part
-- of the migration history, so it is never applied to a deployment by accident, and never by
-- `supabase db push`.
--
-- Two properties make it safe to keep in the repository:
--
--   * No real personal data. Every account uses a reserved `example.test` address, which can never
--     belong to anyone, and no value here is a credential to anything real.
--   * It refuses a database that looks like it holds real accounts (see the guard below).
--
-- The bearer credentials below are fixtures with published plaintext, because a developer has to be
-- able to paste one into a request to exercise an authenticated path. They are worthless anywhere
-- except this seeded database, and the guard is what keeps it that way: real deployments never run
-- this file, and if someone ran it anyway, the presence of a non-`example.test` account stops it.
--
-- Re-running is safe: every insert is ON CONFLICT DO NOTHING.

do $$
declare
  v_foreign integer;
begin
  select count(*) into v_foreign
    from profiles p
    join auth.users u on u.id = p.id
   where u.email is not null and u.email not like '%@example.test';

  if v_foreign > 0 then
    raise exception
      'refusing to seed: this database holds % account(s) that are not development fixtures', v_foreign;
  end if;
end;
$$;

-- --------------------------------------------------------------------------- identities

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test')
on conflict (id) do nothing;

insert into profiles (id, display_name) values
  ('11111111-1111-4111-8111-111111111111', 'Ada (dev)'),
  ('22222222-2222-4222-8222-222222222222', 'Bob (dev)')
on conflict (id) do nothing;

-- An anonymous session whose credential is the published fixture `dev-session-credential`.
-- Present the value `dev-session-credential` as the `ods_` bearer credential to act as this session.
insert into anonymous_sessions (id, credential_hash, created_ip_hash, created_at, expires_at)
values ('sess_seed0100000000000000000000',
        '264099714a833c565feae163642e54c49ef0b99fa2efc73c6783215eaef52c97',
        repeat('5a', 32), now() - interval '1 hour', now() + interval '30 days')
on conflict (id) do nothing;

-- --------------------------------------------------------------------------- folders

insert into folders (id, owner_user_id, parent_id, name) values
  ('fold_seed0100000000000000000000', '11111111-1111-4111-8111-111111111111', null, 'Documents'),
  ('fold_seed0400000000000000000000', '22222222-2222-4222-8222-222222222222', null, 'Bob uploads')
on conflict (id) do nothing;

insert into folders (id, owner_user_id, parent_id, name) values
  ('fold_seed0200000000000000000000', '11111111-1111-4111-8111-111111111111',
   'fold_seed0100000000000000000000', 'Invoices')
on conflict (id) do nothing;

insert into folders (id, owner_user_id, name)
values ('fold_seed0300000000000000000000', '11111111-1111-4111-8111-111111111111', 'Shared with the team')
on conflict (id) do nothing;

-- --------------------------------------------------------------------------- files

-- One file per lifecycle state that matters locally, so a developer can see how each renders.
insert into files
  (id, owner_user_id, original_filename, download_filename, size_bytes, mime_type, detected_mime_type,
   checksum_sha256, visibility, status, scan_state, scanned_at, deletion_token_hash, created_at)
values
  ('file_seed0100000000000000000000', '11111111-1111-4111-8111-111111111111',
   'release-notes.pdf', 'release-notes.pdf', 204800, 'application/pdf', 'application/pdf',
   repeat('1a', 32), 'public', 'ready', 'clean', now() - interval '2 hours',
   '8c6a06fee4f424146250563c6437b5574928023bf3c5f6fb53a1427d05311f7a',
   now() - interval '2 hours'),
  ('file_seed0200000000000000000000', '11111111-1111-4111-8111-111111111111',
   'private-budget.csv', 'private-budget.csv', 4096, 'text/csv', 'text/csv',
   repeat('2b', 32), 'private', 'ready', 'clean', now() - interval '3 hours', null,
   now() - interval '3 hours'),
  ('file_seed0300000000000000000000', '11111111-1111-4111-8111-111111111111',
   'pending-scan.zip', 'pending-scan.zip', 1048576, 'application/zip', null,
   null, 'private', 'scanning', 'pending', null, null, now() - interval '10 minutes'),
  ('file_seed0600000000000000000000', '11111111-1111-4111-8111-111111111111',
   'quarantined.bin', 'quarantined.bin', 512, 'application/octet-stream', 'application/x-msdownload',
   repeat('6f', 32), 'private', 'quarantined', 'infected', now() - interval '30 minutes', null,
   now() - interval '45 minutes')
on conflict (id) do nothing;

-- A file still being uploaded, inside the nested folder, with an open upload session.
insert into files
  (id, owner_user_id, folder_id, original_filename, size_bytes, mime_type, visibility, status, created_at)
values ('file_seed0400000000000000000000', '11111111-1111-4111-8111-111111111111',
        'fold_seed0200000000000000000000', 'invoice-2026-10.pdf', 51200, 'application/pdf',
        'private', 'uploading', now() - interval '5 minutes')
on conflict (id) do nothing;

-- An anonymous upload, owned by the seeded session.
insert into files
  (id, owner_session_id, original_filename, size_bytes, mime_type, visibility, status, expires_at, created_at)
values ('file_seed0500000000000000000000', 'sess_seed0100000000000000000000',
        'anonymous-note.txt', 256, 'text/plain', 'unlisted', 'ready',
        now() + interval '7 days', now() - interval '1 hour')
on conflict (id) do nothing;

-- --------------------------------------------------------------------------- storage and transfers

insert into storage_objects (id, file_id, provider_id, provider_ref, size_bytes, checksum_sha256)
values
  ('sobj_seed0100000000000000000000', 'file_seed0100000000000000000000', 'local-fs',
   '{"path":"/srv/opendrive/dev/seed01"}'::jsonb, 204800, repeat('1a', 32)),
  ('sobj_seed0200000000000000000000', 'file_seed0200000000000000000000', 'local-fs',
   '{"path":"/srv/opendrive/dev/seed02"}'::jsonb, 4096, repeat('2b', 32))
on conflict (id) do nothing;

insert into upload_sessions (id, file_id, state, declared_size_bytes, chunk_size_bytes,
                             parts_expected, parts_received, bytes_received)
values ('upl_seed0100000000000000000000', 'file_seed0400000000000000000000', 'in_progress',
        51200, 8388608, 1, 0, 0)
on conflict (id) do nothing;

-- --------------------------------------------------------------------------- shares

-- `shr_seed01` uses the published fixture token `dev-share-token`.
insert into shares (id, file_id, kind, token_hash, created_by, expires_at, max_downloads, download_count)
values
  ('shr_seed0100000000000000000000', 'file_seed0100000000000000000000', 'unlisted',
   'd536e33c857c96097580219f7fcd0fe583042abf8e09197fb522d14bbf0843f2',
   '11111111-1111-4111-8111-111111111111', now() + interval '30 days', 100, 3),
  ('shr_seed0200000000000000000000', 'file_seed0500000000000000000000', 'public',
   repeat('e7', 32), null, null, null, 0)
on conflict (id) do nothing;

-- --------------------------------------------------------------------------- API keys and usage

-- `key_seed01` uses the published fixture secret `dev-api-key-secret`, presented as
-- `odk_deadbeef_dev-api-key-secret`.
insert into api_keys (id, owner_id, name, key_prefix, key_hash, scopes, last_used_at)
values ('key_seed0100000000000000000000', '11111111-1111-4111-8111-111111111111', 'dev laptop',
        'odk_deadbeef',
        '712bc960d4a7605413f5ccee5576764b77701fc1a443cd42d113f0417a3b4eff',
        array['files:read', 'shares:write'], now() - interval '20 minutes')
on conflict (id) do nothing;

insert into usage_counters (owner_user_id, owner_session_id, period, period_start,
                            storage_bytes, file_count, upload_bytes, download_bytes)
values
  ('11111111-1111-4111-8111-111111111111', null, 'lifetime', '1970-01-01 00:00:00+00',
   1263616, 4, 0, 0),
  ('11111111-1111-4111-8111-111111111111', null, 'day', date_trunc('day', now()), 0, 0, 1263616, 81920),
  (null, 'sess_seed0100000000000000000000', 'lifetime', '1970-01-01 00:00:00+00', 256, 1, 0, 0)
on conflict (owner_key, period, period_start) do nothing;

-- --------------------------------------------------------------------------- moderation

insert into abuse_reports (id, file_id, reason, details, reporter_email_hash, state)
values ('rpt_seed0100000000000000000000', 'file_seed0600000000000000000000', 'malware',
        'Seed fixture: reported by the automated scanner simulation.',
        repeat('9c', 32), 'open')
on conflict (id) do nothing;

insert into moderation_actions (id, report_id, file_id, action, actor_user_id, note)
values ('mod_seed0100000000000000000000', 'rpt_seed0100000000000000000000',
        'file_seed0600000000000000000000', 'quarantine', '22222222-2222-4222-8222-222222222222',
        'Seed fixture: quarantined pending review.')
on conflict (id) do nothing;

insert into audit_events (id, actor_kind, actor_user_id, actor_ip_hash, action, subject_type, subject_id, metadata)
values
  ('evt_seed0100000000000000000000', 'user', '11111111-1111-4111-8111-111111111111', repeat('4d', 32),
   'file.upload', 'file', 'file_seed0100000000000000000000', '{"seed":true}'::jsonb),
  ('evt_seed0200000000000000000000', 'service', null, null, 'moderation.quarantine', 'file',
   'file_seed0600000000000000000000', '{"seed":true}'::jsonb)
on conflict (id) do nothing;
