-- Live verification: the anonymous-session migration on a DEPLOYED database.
--
-- `supabase/tests/run-local.sh` proves the schema against a throwaway database with `psql`. This
-- file is the other half: it is a single `do` block, so it can be piped into the HTTPS SQL runner
-- of a running instance (in the infra repository: `./remote.sh run < 70_anonymous_migration_live.sql`).
-- It exists because the local suite needs a PostgreSQL server on this machine, and the migration it
-- verifies is the one addition whose invariants (`migrated iff revoked and targeted`, the transfer
-- itself, the FK that keeps a receiving account from being deleted) are only worth anything when
-- they have actually been enforced by a server.
--
-- Three properties make it safe to run against real data:
--
--   * **It creates everything it needs and deletes nothing.** Every fixture id is fixed and
--     obviously synthetic, and every id it touches lives in a session and account it inserted.
--   * **It rolls itself back.** The block ends by raising, which undoes the subtransaction — so the
--     run leaves no rows behind. That is also why a *pass* looks like a failure to the runner:
--
--         {"ok": false, "error": "VERIFIED 25 checks (rolled back): ..."}
--
--     Read it with that in mind: `VERIFIED` means every check held; `FAILED` lists the ones that
--     did not, with the observed values; any other error means the fixtures themselves did not
--     apply (a schema drift this file exists to catch, but reported as a raw SQLSTATE instead).
--   * **It exercises the migration's own statements**, not paraphrases of them: the folder, file,
--     incomplete-file, reservation and record updates below are copied from
--     `apps/api/src/db/repositories/migration.ts`, so a change to one of those queries is a change
--     that has to be made here too — which is the point.
--
-- Verification status: executed against the self-hosted instance on 2026-10-14 (PostgreSQL 17.6)
-- through the repository's `migrate` function, immediately after
-- `104-opendrive-anonymous-session-migration.sql` was applied there. The result is recorded in the
-- migration file's header.

do $live$
declare
  v_account_a uuid := 'deadbeef-0000-4000-8000-000000000001';
  v_account_b uuid := 'deadbeef-0000-4000-8000-000000000002';
  v_session_probe text := 'sess_' || repeat('a', 26);
  v_session_transfer text := 'sess_' || repeat('b', 26);
  v_folder_root text := 'fold_' || repeat('c', 26);
  v_folder_child text := 'fold_' || repeat('d', 26);
  v_folder_root_2 text := 'fold_' || repeat('j', 26);
  v_folder_removed text := 'fold_' || repeat('k', 26);
  v_file_ready_a text := 'file_' || repeat('e', 26);
  v_file_ready_b text := 'file_' || repeat('f', 26);
  v_file_incomplete text := 'file_' || repeat('g', 26);
  v_file_removed text := 'file_' || repeat('m', 26);
  v_reservation text := 'resv_' || repeat('h', 26);
  v_checks text[] := '{}';
  v_failures text[] := '{}';
  v_state text;
  v_msg text;
  v_count integer;
  v_bytes bigint;
  v_columns integer;
  v_files integer;
  v_folders integer;
  v_skipped integer;
  v_fk text;
  v_target uuid;
  v_status session_status;
begin
  -- -------------------------------------------------------------------------
  -- Fixtures: an account, a second account, a session per account, and a tree.
  -- -------------------------------------------------------------------------
  insert into auth.users (id, email) values
    (v_account_a, 'live-migration-a@opendrive.test'),
    (v_account_b, 'live-migration-b@opendrive.test');
  insert into profiles (id, display_name) values
    (v_account_a, 'Live migration A'),
    (v_account_b, 'Live migration B');
  insert into anonymous_sessions (id, credential_hash, created_at, expires_at) values
    (v_session_probe, repeat('1', 64), now() - interval '1 hour', now() + interval '6 hours'),
    (v_session_transfer, repeat('2', 64), now() - interval '1 hour', now() + interval '6 hours');
  insert into folders (id, owner_session_id, name, depth) values
    (v_folder_root, v_session_transfer, 'Live root', 0),
    (v_folder_root_2, v_session_transfer, 'Live root 2', 0);
  insert into folders (id, owner_session_id, parent_id, name, depth) values
    (v_folder_child, v_session_transfer, v_folder_root, 'Live child', 1);
  -- A soft-deleted folder inside a live one, and a soft-deleted file inside a live folder: both are
  -- states the API can produce (empty a folder, delete it; delete a file) and both reference a
  -- folder whose owner key is about to change, which is what makes them part of this test.
  insert into folders (id, owner_session_id, parent_id, name, depth, deleted_at) values
    (v_folder_removed, v_session_transfer, v_folder_root_2, 'Live removed', 1, now());
  insert into files (id, owner_session_id, folder_id, original_filename, size_bytes, mime_type,
                     status, scan_state, deletion_token_hash, deleted_at) values
    (v_file_ready_a, v_session_transfer, v_folder_root, 'live-a.bin', 4096,
     'application/octet-stream', 'ready', 'clean', repeat('3', 64), null),
    (v_file_ready_b, v_session_transfer, null, 'live-b.bin', 1024,
     'application/octet-stream', 'ready', 'clean', null, null),
    (v_file_incomplete, v_session_transfer, v_folder_root, 'live-part.bin', 512,
     'application/octet-stream', 'pending_upload', 'not_scanned', repeat('4', 64), null),
    (v_file_removed, v_session_transfer, v_folder_root, 'live-removed.bin', 256,
     'application/octet-stream', 'deleted', 'not_scanned', repeat('5', 64), now());
  insert into quota_reservations (id, file_id, owner_session_id, requested_bytes, state) values
    (v_reservation, v_file_incomplete, v_session_transfer, 512, 'held');

  -- -------------------------------------------------------------------------
  -- 1. Structure: the six columns, the constraint, the index, the referential action.
  -- -------------------------------------------------------------------------
  select count(*)::int into v_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'anonymous_sessions'
     and column_name in ('migrated_at', 'migrated_to_user_id', 'migrated_file_count',
                         'migrated_bytes', 'migrated_folders', 'migrated_skipped_files')
     and ((column_name = 'migrated_at' and data_type = 'timestamp with time zone')
       or (column_name = 'migrated_to_user_id' and data_type = 'uuid')
       or (column_name = 'migrated_bytes' and data_type = 'bigint')
       or (column_name in ('migrated_file_count', 'migrated_folders', 'migrated_skipped_files')
           and data_type = 'integer'));
  if v_columns = 6 then
    v_checks := array_append(v_checks, 'six migration columns present with the expected types');
  else
    v_failures := array_append(v_failures, format('expected 6 migrated_* columns with expected types, found %s', v_columns));
  end if;

  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.anonymous_sessions'::regclass
       and conname = 'anonymous_sessions_migration_consistency'
       and contype = 'c'
  ) then
    v_checks := array_append(v_checks, 'consistency check constraint present');
  else
    v_failures := array_append(v_failures, 'consistency check constraint missing');
  end if;

  select c.conname into v_fk
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.conrelid = 'public.anonymous_sessions'::regclass
     and c.contype = 'f'
     and a.attname = 'migrated_to_user_id';
  if v_fk is null then
    v_failures := array_append(v_failures, 'no foreign key on migrated_to_user_id');
  elsif (select confdeltype from pg_constraint where conname = v_fk
         and conrelid = 'public.anonymous_sessions'::regclass) = 'r' then
    v_checks := array_append(v_checks, format('foreign key %s refuses deletion of the receiving account (on delete restrict)', v_fk));
  else
    v_failures := array_append(v_failures, format('foreign key %s does not restrict deletion', v_fk));
  end if;

  if exists (select 1 from pg_indexes where schemaname = 'public'
              and indexname = 'anonymous_sessions_migrated_idx') then
    v_checks := array_append(v_checks, 'partial index on migrated_to_user_id present');
  else
    v_failures := array_append(v_failures, 'partial index on migrated_to_user_id missing');
  end if;

  -- The two ownership keys must be deferrable, or the transfer below has no way to move a folder and
  -- its files together. `condeferred = false` is the contract: nothing changes until a transaction
  -- explicitly asks for deferral, which is what the transfer does.
  select count(*)::int into v_count
    from pg_constraint
   where conname in ('files_folder_same_owner', 'folders_parent_same_owner')
     and conrelid in ('files'::regclass, 'folders'::regclass)
     and condeferrable and not condeferred
     and contype = 'f';
  if v_count = 2 then
    v_checks := array_append(v_checks, 'both ownership keys are deferrable and initially immediate');
  else
    v_failures := array_append(v_failures, format('%s of 2 ownership keys are deferrable initially immediate', v_count));
  end if;

  -- Existing rows: nothing in this deployment — other than the fixtures just inserted — carries a
  -- migration record, so the additive migration left every earlier session exactly as it was.
  select count(*)::int into v_count
    from anonymous_sessions
   where id not in (v_session_probe, v_session_transfer)
     and (migrated_at is not null or migrated_to_user_id is not null
          or migrated_file_count is not null or migrated_bytes is not null
          or migrated_folders is not null or migrated_skipped_files is not null);
  if v_count = 0 then
    v_checks := array_append(v_checks, 'no pre-existing session carries a migration record');
  else
    v_failures := array_append(v_failures, format('%s pre-existing sessions carry a partial migration record', v_count));
  end if;

  -- -------------------------------------------------------------------------
  -- 2. The constraint itself, one invalid combination at a time.
  -- -------------------------------------------------------------------------
  begin
    update anonymous_sessions set migrated_at = now() where id = v_session_probe;
    v_failures := array_append(v_failures, 'migrated_at without a target account was accepted');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if position('anonymous_sessions_migration_consistency' in v_msg) > 0 then
      v_checks := array_append(v_checks, 'migrated_at without a target account rejected');
    else
      v_failures := array_append(v_failures, format('migrated_at without a target was rejected for another reason: %s', v_msg));
    end if;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_failures := array_append(v_failures, format('migrated_at without a target was rejected as %s: %s', v_state, v_msg));
  end;

  begin
    update anonymous_sessions set migrated_to_user_id = v_account_a where id = v_session_probe;
    v_failures := array_append(v_failures, 'a target account without migrated_at was accepted');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if position('anonymous_sessions_migration_consistency' in v_msg) > 0 then
      v_checks := array_append(v_checks, 'target account without migrated_at rejected');
    else
      v_failures := array_append(v_failures, format('target without migrated_at rejected for another reason: %s', v_msg));
    end if;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_failures := array_append(v_failures, format('target without migrated_at rejected as %s: %s', v_state, v_msg));
  end;

  begin
    update anonymous_sessions set migrated_file_count = 1 where id = v_session_probe;
    v_failures := array_append(v_failures, 'a recorded count without a migration record was accepted');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if position('anonymous_sessions_migration_consistency' in v_msg) > 0 then
      v_checks := array_append(v_checks, 'recorded counts without a migration record rejected');
    else
      v_failures := array_append(v_failures, format('counts without a record rejected for another reason: %s', v_msg));
    end if;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_failures := array_append(v_failures, format('counts without a record rejected as %s: %s', v_state, v_msg));
  end;

  -- A migrated session that is still active would leave the same data reachable by two principals:
  -- the account that now owns the rows and the credential that still authenticates.
  begin
    update anonymous_sessions
       set status = 'active', revoked_at = null, migrated_at = now(), migrated_to_user_id = v_account_a
     where id = v_session_probe;
    v_failures := array_append(v_failures, 'a migrated session left active was accepted');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if position('anonymous_sessions_migration_consistency' in v_msg) > 0 then
      v_checks := array_append(v_checks, 'a migrated session cannot stay active');
    else
      v_failures := array_append(v_failures, format('migrated-but-active rejected for another reason: %s', v_msg));
    end if;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_failures := array_append(v_failures, format('migrated-but-active rejected as %s: %s', v_state, v_msg));
  end;

  -- The complete record, in the shape `recordSessionMigration` writes it: this must be accepted.
  begin
    update anonymous_sessions
       set status = 'revoked', revoked_at = now(), migrated_at = now(),
           migrated_to_user_id = v_account_a, migrated_file_count = 0, migrated_bytes = 0,
           migrated_folders = 0, migrated_skipped_files = 0
     where id = v_session_probe and status = 'active' and migrated_at is null;
    get diagnostics v_count = row_count;
    if v_count = 1 then
      v_checks := array_append(v_checks, 'a complete migration record is accepted (and the compare-and-set matched)');
    else
      v_failures := array_append(v_failures, format('the record update matched %s rows, expected 1', v_count));
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_failures := array_append(v_failures, format('a complete migration record was refused as %s: %s', v_state, v_msg));
  end;

  -- The database tolerates a record without counts (the columns are nullable); the API is what
  -- refuses to answer a replay from it (`decideMigration` returns `record_inconsistent`). Asserted
  -- so the split between schema permissiveness and application strictness is deliberate and tested.
  begin
    update anonymous_sessions
       set migrated_file_count = null, migrated_bytes = null, migrated_folders = null,
           migrated_skipped_files = null
     where id = v_session_probe;
    v_checks := array_append(v_checks, 'the schema tolerates a record whose counts are NULL (the API refuses to replay from it)');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_failures := array_append(v_failures, format('clearing the counts was refused as %s: %s', v_state, v_msg));
  end;

  -- The account that received a session cannot simply be deleted: the record of where the resources
  -- went is a fact the database keeps.
  begin
    delete from profiles where id = v_account_a;
    v_failures := array_append(v_failures, 'the receiving account was deleted despite holding a migration record');
  exception when foreign_key_violation then
    get stacked diagnostics v_msg = message_text;
    if v_fk is not null and position(v_fk in v_msg) > 0 then
      v_checks := array_append(v_checks, 'the receiving account cannot be deleted while its migration record stands');
    else
      v_checks := array_append(v_checks, format('the receiving account could not be deleted (refused by %s)', coalesce(v_fk, 'a foreign key')));
    end if;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_failures := array_append(v_failures, format('deleting the receiving account was refused as %s: %s', v_state, v_msg));
  end;

  -- -------------------------------------------------------------------------
  -- 3. The transfer, using the migration's own statements on the fixture session.
  -- -------------------------------------------------------------------------
  -- Folders first and in one statement: `folders_parent_same_owner` rejects a tree whose parent and
  -- child disagree, so a per-folder update would fail halfway through.
  -- The whole ownership change, as `transferSessionOwnership` performs it: live folders and durable
  -- files move, unfinished uploads are closed, and rows that are already deleted are detached from
  -- the folder that is leaving them behind. Splitting this across statements is impossible while the
  -- composite keys are immediate: the folder-first statement this file originally carried was
  -- refused live by `files_folder_same_owner`, and the files-first order is refused by the same key
  -- for the mirror-image reason.
  -- The composite keys are deferred for the transfer exactly as `transferSessionOwnership` does it,
  -- and flipped back to immediate afterwards, which is what validates the finished state.
  execute 'set constraints files_folder_same_owner, folders_parent_same_owner deferred';

  with moved_folders as (
    update folders
       set owner_user_id = v_account_a, owner_session_id = null
     where owner_session_id = v_session_transfer and deleted_at is null
    returning id
  ), moved_files as (
    update files
       set owner_user_id = v_account_a, owner_session_id = null, deletion_token_hash = null
     where owner_session_id = v_session_transfer and deleted_at is null
       and status not in ('pending_upload', 'uploading', 'failed')
    returning size_bytes
  ), closed_files as (
    update files
       set status = 'deleted', deleted_at = now(), deletion_token_hash = null, folder_id = null
     where owner_session_id = v_session_transfer and deleted_at is null
       and status in ('pending_upload', 'uploading', 'failed')
    returning id
  ), detached_files as (
    update files
       set folder_id = null
     where owner_session_id = v_session_transfer and deleted_at is not null and folder_id is not null
    returning id
  ), detached_folders as (
    update folders
       set parent_id = null
     where owner_session_id = v_session_transfer and deleted_at is not null and parent_id is not null
    returning id
  )
  select (select count(*)::int from moved_folders),
         (select count(*)::int from moved_files),
         (select coalesce(sum(size_bytes), 0)::bigint from moved_files),
         ((select count(*)::int from closed_files) + (select count(*)::int from detached_files))
    into v_folders, v_count, v_bytes, v_skipped;
  -- Kept in its own variable: later statements reuse `v_count` for their own row counts.
  v_files := v_count;

  -- Restoring `immediate` is what validates the finished state. If anything is left dangling, the
  -- handler below names the row instead of letting the runner report a bare FK message.
  begin
    execute 'set constraints files_folder_same_owner, folders_parent_same_owner immediate';
    v_checks := array_append(v_checks, 'the deferred checks validated when the constraints were restored to immediate');
  exception when foreign_key_violation then
    get stacked diagnostics v_msg = message_text;
    v_failures := array_append(v_failures, format(
      'deferred validation failed: %s || dangling files: %s || dangling folders: %s',
      v_msg,
      (select coalesce(string_agg(format('%s in folder %s owning %s', f.id, f.folder_id, f.owner_key), '; '), 'none')
         from files f join folders d on d.id = f.folder_id
        where f.owner_key is distinct from d.owner_key
          and (f.owner_session_id = v_session_transfer or f.owner_user_id in (v_account_a, v_account_b))),
      (select coalesce(string_agg(format('%s under %s owning %s', c.id, c.parent_id, c.owner_key), '; '), 'none')
         from folders c join folders p on p.id = c.parent_id
        where c.owner_key is distinct from p.owner_key
          and (c.owner_session_id = v_session_transfer or c.owner_user_id in (v_account_a, v_account_b)))));
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_failures := array_append(v_failures, format('restoring the immediate checks failed as %s: %s', v_state, v_msg));
  end;

  if v_folders = 3 then
    v_checks := array_append(v_checks, 'the whole live folder tree transferred in one statement (parent and child together, plus the second root)');
  else
    v_failures := array_append(v_failures, format('folder transfer moved %s rows, expected 3', v_folders));
  end if;

  if v_count = 2 and v_bytes = 5120 then
    v_checks := array_append(v_checks, 'the file transfer moved 2 durable files / 5120 bytes, counted from the rows it moved');
  else
    v_failures := array_append(v_failures, format('file transfer reported %s files / %s bytes, expected 2 / 5120', v_count, v_bytes));
  end if;

  if v_skipped = 2 then
    v_checks := array_append(v_checks, 'the unfinished upload was closed and the tombstoned file was detached, and both were reported as skipped');
  else
    v_failures := array_append(v_failures, format('the transfer reported %s skipped files, expected 2', v_skipped));
  end if;

  select count(*)::int into v_count
    from files
   where id in (v_file_ready_a, v_file_ready_b)
     and owner_user_id = v_account_a
     and owner_session_id is null
     and owner_key = v_account_a::text
     and deletion_token_hash is null;
  if v_count = 2 then
    v_checks := array_append(v_checks, 'transferred files belong to the account, carry its owner_key, and hold no deletion token');
  else
    v_failures := array_append(v_failures, format('%s of 2 transferred files are correctly owned and token-free', v_count));
  end if;

  if (select owner_user_id is null and status = 'deleted' and deleted_at is not null and folder_id is null
        from files where id = v_file_incomplete) then
    v_checks := array_append(v_checks, 'the closed file stayed with no owner, no folder and a deletion timestamp');
  else
    v_failures := array_append(v_failures, 'the closed file is not in the expected closed state');
  end if;

  if (select owner_user_id is null and owner_session_id = v_session_transfer and folder_id is null
        from files where id = v_file_removed) then
    v_checks := array_append(v_checks, 'the already-deleted file stayed the session''s and was detached from the folder it was in');
  else
    v_failures := array_append(v_failures, 'the already-deleted file is not in the expected detached state');
  end if;

  if (select owner_user_id is null and owner_session_id = v_session_transfer and parent_id is null
        from folders where id = v_folder_removed) then
    v_checks := array_append(v_checks, 'the already-deleted folder stayed the session''s and was detached from its parent');
  else
    v_failures := array_append(v_failures, 'the already-deleted folder is not in the expected detached state');
  end if;

  update quota_reservations
     set state = 'released', released_at = now()
   where owner_session_id = v_session_transfer and state = 'held';
  get diagnostics v_count = row_count;
  if v_count = 1 then
    v_checks := array_append(v_checks, 'the session''s open quota hold was released');
  else
    v_failures := array_append(v_failures, format('releasing holds matched %s rows, expected 1', v_count));
  end if;

  -- The record, exactly as `recordSessionMigration` writes it, including its compare-and-set guard.
  update anonymous_sessions
     set status = 'revoked', revoked_at = now(), migrated_at = now(),
         migrated_to_user_id = v_account_a, migrated_file_count = v_files,
         migrated_bytes = v_bytes, migrated_folders = v_folders,
         migrated_skipped_files = v_skipped
   where id = v_session_transfer and status = 'active' and migrated_at is null;
  get diagnostics v_count = row_count;
  if v_count = 1 then
    v_checks := array_append(v_checks, 'the session was revoked and its migration recorded in one statement');
  else
    v_failures := array_append(v_failures, format('recording the migration matched %s rows, expected 1', v_count));
  end if;

  select migrated_to_user_id, status, migrated_file_count, migrated_bytes, migrated_folders,
         migrated_skipped_files
    into v_target, v_status, v_count, v_bytes, v_folders, v_skipped
    from anonymous_sessions where id = v_session_transfer;
  if v_target = v_account_a and v_status = 'revoked' then
    v_checks := array_append(v_checks, 'the stored record names the receiving account and the session is revoked');
  else
    v_failures := array_append(v_failures, format('stored record names %s with status %s', v_target, v_status));
  end if;

  if v_count = 2 and v_bytes = 5120 and v_folders = 3 and v_skipped = 2 then
    v_checks := array_append(v_checks, 'the record stores the counts the transfer reported (2 files / 5120 bytes / 3 folders / 2 skipped)');
  else
    v_failures := array_append(v_failures, format('the stored record reads %s files / %s bytes / %s folders / %s skipped', v_count, v_bytes, v_folders, v_skipped));
  end if;

  -- Replay: the same compare-and-set finds nothing to update, which is what makes a repeated
  -- request idempotent instead of a second transfer.
  update anonymous_sessions
     set status = 'revoked', revoked_at = now(), migrated_at = now(),
         migrated_to_user_id = v_account_a, migrated_file_count = 99,
         migrated_bytes = 99, migrated_folders = 99, migrated_skipped_files = 99
   where id = v_session_transfer and status = 'active' and migrated_at is null;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    v_checks := array_append(v_checks, 'a repeated migration record updates nothing (the compare-and-set refuses a second transfer)');
  else
    v_failures := array_append(v_failures, format('a repeated record updated %s rows, expected 0', v_count));
  end if;

  -- Cross-account: the same guard refuses a different account, and the record still names the first.
  update anonymous_sessions
     set status = 'revoked', revoked_at = now(), migrated_at = now(),
         migrated_to_user_id = v_account_b, migrated_file_count = 0,
         migrated_bytes = 0, migrated_folders = 0, migrated_skipped_files = 0
   where id = v_session_transfer and status = 'active' and migrated_at is null;
  get diagnostics v_count = row_count;
  select migrated_to_user_id into v_target from anonymous_sessions where id = v_session_transfer;
  if v_count = 0 and v_target = v_account_a then
    v_checks := array_append(v_checks, 'a second account cannot claim the session: the record still names the first');
  else
    v_failures := array_append(v_failures, format('a second account updated %s rows and the record now names %s', v_count, v_target));
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Isolation: the account owns everything, the other account owns nothing, the session owns nothing.
  -- -------------------------------------------------------------------------
  select count(*)::int into v_count from files where owner_user_id = v_account_a;
  select count(*)::int into v_folders from folders where owner_user_id = v_account_a;
  if v_count = 2 and v_folders = 3 then
    v_checks := array_append(v_checks, 'the receiving account owns both durable files and all three live folders');
  else
    v_failures := array_append(v_failures, format('the receiving account owns %s files and %s folders', v_count, v_folders));
  end if;

  -- Nothing *live* may still carry the session's owner key: the account is the owner of everything
  -- a person can see, and the only rows left behind are tombstones the account should not inherit.
  select count(*)::int into v_count
    from files where owner_session_id = v_session_transfer and deleted_at is null;
  select count(*)::int into v_folders
    from folders where owner_session_id = v_session_transfer and deleted_at is null;
  if v_count = 0 and v_folders = 0 then
    v_checks := array_append(v_checks, 'no live row still carries the session''s owner key');
  else
    v_failures := array_append(v_failures, format('%s live files and %s live folders still belong to the session', v_count, v_folders));
  end if;

  select count(*)::int into v_count from files where owner_session_id = v_session_transfer;
  select count(*)::int into v_folders from folders where owner_session_id = v_session_transfer;
  if v_count = 2 and v_folders = 1 then
    v_checks := array_append(v_checks, 'the session keeps exactly its tombstones: the closed upload, the deleted file and the deleted folder, each detached');
  else
    v_failures := array_append(v_failures, format('the session keeps %s files and %s folders, expected 2 and 1', v_count, v_folders));
  end if;

  select count(*)::int into v_count from files where owner_user_id = v_account_b;
  select count(*)::int into v_folders from folders where owner_user_id = v_account_b;
  if v_count = 0 and v_folders = 0 then
    v_checks := array_append(v_checks, 'an unrelated account reads none of the transferred rows');
  else
    v_failures := array_append(v_failures, format('an unrelated account sees %s files and %s folders', v_count, v_folders));
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Privileges: the new columns are internal, like the rest of the table.
  -- -------------------------------------------------------------------------
  if not has_table_privilege('authenticated', 'public.anonymous_sessions', 'select')
     and not has_table_privilege('anon', 'public.anonymous_sessions', 'select') then
    v_checks := array_append(v_checks, 'anon and authenticated hold no grant on anonymous_sessions (including the new columns)');
  else
    v_failures := array_append(v_failures, 'a client role holds a grant on anonymous_sessions');
  end if;

  if exists (select 1 from pg_roles where rolname = 'opendrive_app') then
    if has_column_privilege('opendrive_app', 'public.anonymous_sessions', 'migrated_to_user_id', 'select')
       and has_column_privilege('opendrive_app', 'public.anonymous_sessions', 'migrated_bytes', 'select') then
      v_checks := array_append(v_checks, 'the API role can read the new columns');
    else
      v_failures := array_append(v_failures, 'the API role cannot read the new columns');
    end if;
  else
    v_checks := array_append(v_checks, 'no opendrive_app role on this instance: the API-role column check was skipped');
  end if;

  -- -------------------------------------------------------------------------
  -- Verdict. Raising rolls the whole block back, which is the only reason running this against a
  -- live database is safe at all.
  -- -------------------------------------------------------------------------
  if coalesce(array_length(v_failures, 1), 0) > 0 then
    raise exception 'FAILED % of % checks (rolled back): %',
      array_length(v_failures, 1), array_length(v_failures, 1) + coalesce(array_length(v_checks, 1), 0),
      array_to_string(v_failures, ' | ');
  end if;

  raise exception 'VERIFIED % checks (rolled back): %',
    coalesce(array_length(v_checks, 1), 0), array_to_string(v_checks, ' | ');
end
$live$;
