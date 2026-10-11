-- Suite 4: identity, ownership and placement.
--
-- Phase 1's central invariant is that a resource belongs to exactly one principal — a registered
-- user or an anonymous session — and that a resource can only reference another resource owned by
-- the same principal. Both halves are enforced by the database here, not merely by the API, because
-- an invariant that only lives in application code is one refactor away from being false.

set search_path = public, verify;

truncate table public.files, public.folders, public.storage_objects, public.upload_sessions,
  public.shares, public.api_keys, public.audit_events, public.abuse_reports,
  public.moderation_actions, public.quota_reservations, public.usage_counters,
  public.anonymous_sessions, public.profiles, auth.users cascade;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'bo@example.test');

insert into profiles (id, display_name) values
  ('11111111-1111-4111-8111-111111111111', 'Ada'),
  ('22222222-2222-4222-8222-222222222222', 'Bo');

insert into anonymous_sessions (id, credential_hash, expires_at) values
  ('sess_abcdeabcdeabcdeabcdeabcdef', repeat('11', 32), now() + interval '24 hours'),
  ('sess_bcdefbcdefbcdefbcdefbcdefb', repeat('22', 32), now() + interval '24 hours');

-- --------------------------------------------------------------------------- anonymous sessions

select verify.rejected(
  'sessions',
  'a session id without the sess_ prefix is rejected',
  $sql$insert into anonymous_sessions (id, credential_hash, expires_at)
       values ('xidedeidedeidedeidedeidedei', repeat('33', 32), now() + interval '1 hour')$sql$,
  'anonymous_sessions_id_check'
);

select verify.rejected(
  'sessions',
  'a session credential hash that is not a sha256 digest is rejected',
  $sql$insert into anonymous_sessions (id, credential_hash, expires_at)
       values ('sess_cdefgcdefgcdefgcdefgcdefgc', 'not-a-hash', now() + interval '1 hour')$sql$,
  'anonymous_sessions_credential_hash_check'
);

select verify.rejected(
  'sessions',
  'a second session cannot reuse another session''s credential hash',
  $sql$insert into anonymous_sessions (id, credential_hash, expires_at)
       values ('sess_cdefgcdefgcdefgcdefgcdefgc', repeat('11', 32), now() + interval '1 hour')$sql$,
  'anonymous_sessions_credential_hash_key'
);

select verify.rejected(
  'sessions',
  'a session that expires before it was created is rejected',
  $sql$insert into anonymous_sessions (id, credential_hash, created_at, expires_at)
       values ('sess_cdefgcdefgcdefgcdefgcdefgc', repeat('44', 32),
               now(), now() - interval '1 hour')$sql$,
  'anonymous_sessions_expires_after_creation'
);

select verify.rejected(
  'sessions',
  'revoking a session without recording when is rejected',
  $sql$update anonymous_sessions set status = 'revoked'
        where id = 'sess_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'anonymous_sessions_revoked_consistency'
);

select verify.rejected(
  'sessions',
  'setting revoked_at while the session stays active is rejected',
  $sql$update anonymous_sessions set revoked_at = now()
        where id = 'sess_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'anonymous_sessions_revoked_consistency'
);

select verify.rejected(
  'sessions',
  'a raw IP address stored as created_ip_hash is rejected',
  $sql$update anonymous_sessions set created_ip_hash = '203.0.113.9'
        where id = 'sess_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'anonymous_sessions_created_ip_hash_check'
);

select verify.accepted(
  'sessions',
  'revoking a session records both status and revoked_at',
  $sql$update anonymous_sessions set status = 'revoked', revoked_at = now()
        where id = 'sess_bcdefbcdefbcdefbcdefbcdefb'$sql$
);

select verify.accepted(
  'sessions',
  'a revoked session row is retained, so its files stay attributable',
  $sql$update anonymous_sessions set status = 'active', revoked_at = null
        where id = 'sess_bcdefbcdefbcdefbcdefbcdefb'$sql$
);

-- --------------------------------------------------------------------------- files: exactly one principal

insert into files (id, owner_user_id, original_filename, size_bytes, mime_type, status)
values ('file_abcdeabcdeabcdeabcdeabcdef', '11111111-1111-4111-8111-111111111111', 'ada.bin', 1024,
        'application/octet-stream', 'ready');

select verify.rejected(
  'principal',
  'a file owned by neither a user nor a session is rejected',
  $sql$insert into files (id, original_filename, size_bytes, mime_type)
       values ('file_bcdefbcdefbcdefbcdefbcdefb', 'orphan.bin', 1, 'application/octet-stream')$sql$,
  'files_one_owner'
);

select verify.rejected(
  'principal',
  'a file owned by both a user and a session is rejected',
  $sql$insert into files (id, owner_user_id, owner_session_id, original_filename, size_bytes, mime_type)
       values ('file_bcdefbcdefbcdefbcdefbcdefb', '11111111-1111-4111-8111-111111111111',
               'sess_abcdeabcdeabcdeabcdeabcdef', 'both.bin', 1, 'application/octet-stream')$sql$,
  'files_one_owner'
);

select verify.rejected(
  'principal',
  'a file owned by a nonexistent anonymous session is rejected',
  $sql$insert into files (id, owner_session_id, original_filename, size_bytes, mime_type)
       values ('file_bcdefbcdefbcdefbcdefbcdefb', 'sess_ffffffffffffffffffffffffff',
               'ghost.bin', 1, 'application/octet-stream')$sql$,
  'files_owner_session_id_fkey'
);

select verify.accepted(
  'principal',
  'a file owned by an anonymous session alone is accepted',
  $sql$insert into files (id, owner_session_id, original_filename, size_bytes, mime_type)
       values ('file_bcdefbcdefbcdefbcdefbcdefb', 'sess_abcdeabcdeabcdeabcdeabcdef',
               'anon.bin', 512, 'application/octet-stream')$sql$
);

select verify.eq(
  'principal',
  'the session-owned file''s principal key is the session id, not a user id',
  (select owner_key from files where id = 'file_bcdefbcdefbcdefbcdefbcdefb'),
  'sess_abcdeabcdeabcdeabcdeabcdef'
);

-- Changing ownership by editing a row must not be possible: there is no UPDATE path that leaves
-- both principal columns set, and a session-owned file cannot silently become user-owned without
-- also clearing the session. Both directions are refused.
select verify.rejected(
  'principal',
  'adding a user owner to a session-owned file is rejected',
  $sql$update files set owner_user_id = '11111111-1111-4111-8111-111111111111'
        where id = 'file_bcdefbcdefbcdefbcdefbcdefb'$sql$,
  'files_one_owner'
);

select verify.rejected(
  'principal',
  'adding a session owner to a user-owned file is rejected',
  $sql$update files set owner_session_id = 'sess_abcdeabcdeabcdeabcdeabcdef'
        where id = 'file_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'files_one_owner'
);

select verify.rejected(
  'principal',
  'clearing the only principal is rejected',
  $sql$update files set owner_user_id = null where id = 'file_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'files_one_owner'
);

-- --------------------------------------------------------------------------- folders

select verify.rejected(
  'folders',
  'a folder owned by neither principal is rejected',
  $sql$insert into folders (id, name) values ('fold_abcdeabcdeabcdeabcdeabcdef', 'Orphan')$sql$,
  'folders_one_owner'
);

select verify.rejected(
  'folders',
  'a folder owned by both principals is rejected',
  $sql$insert into folders (id, owner_user_id, owner_session_id, name)
       values ('fold_abcdeabcdeabcdeabcdeabcdef', '11111111-1111-4111-8111-111111111111',
               'sess_abcdeabcdeabcdeabcdeabcdef', 'Both')$sql$,
  'folders_one_owner'
);

select verify.accepted(
  'folders',
  'a root folder has no parent and depth zero',
  $sql$insert into folders (id, owner_user_id, name)
       values ('fold_abcdeabcdeabcdeabcdeabcdef', '11111111-1111-4111-8111-111111111111', 'Documents')$sql$
);

select verify.eq(
  'folders',
  'a root folder reports depth 0',
  (select depth from folders where id = 'fold_abcdeabcdeabcdeabcdeabcdef'),
  0
);

select verify.accepted(
  'folders',
  'a child folder is accepted under its owner''s folder',
  $sql$insert into folders (id, owner_user_id, name, parent_id)
       values ('fold_bcdefbcdefbcdefbcdefbcdefb', '11111111-1111-4111-8111-111111111111',
               'Invoices', 'fold_abcdeabcdeabcdeabcdeabcdef')$sql$
);

select verify.eq(
  'folders',
  'the trigger computes the child''s depth from its parent',
  (select depth from folders where id = 'fold_bcdefbcdefbcdefbcdefbcdefb'),
  1
);

-- A folder parented on itself is the smallest possible cycle. The guard trigger refuses it first
-- (it runs before the check constraints), so the assertion names the trigger's message; the
-- declarative check constraint that would also catch it is asserted from the catalogue below,
-- because dropping it should fail this suite even though the trigger alone would still refuse.
select verify.rejected(
  'folders',
  'a folder cannot be its own parent',
  $sql$update folders set parent_id = id where id = 'fold_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'cannot be its own ancestor'
);

select verify.eq(
  'folders',
  'the self-parent rule is also covered by a declarative check constraint',
  (select count(*) from pg_constraint where conname = 'folders_no_self_parent' and contype = 'c'),
  1::bigint
);

select verify.eq(
  'folders',
  'the exactly-one-principal rule is covered by a declarative check constraint on folders',
  (select count(*) from pg_constraint where conname = 'folders_one_owner' and contype = 'c'),
  1::bigint
);

select verify.eq(
  'folders',
  'the same rule is covered on files',
  (select count(*) from pg_constraint where conname = 'files_one_owner' and contype = 'c'),
  1::bigint
);

select verify.rejected(
  'folders',
  'another owner''s folder cannot be used as a parent',
  $sql$insert into folders (id, owner_user_id, name, parent_id)
       values ('fold_cdefgcdefgcdefgcdefgcdefgc', '22222222-2222-4222-8222-222222222222',
               'Cross owner', 'fold_abcdeabcdeabcdeabcdeabcdef')$sql$,
  'folders_parent_same_owner'
);

select verify.rejected(
  'folders',
  'an anonymous session cannot nest under a user''s folder',
  $sql$insert into folders (id, owner_session_id, name, parent_id)
       values ('fold_cdefgcdefgcdefgcdefgcdefgc', 'sess_abcdeabcdeabcdeabcdeabcdef',
               'Cross principal', 'fold_abcdeabcdeabcdeabcdeabcdef')$sql$,
  'folders_parent_same_owner'
);

select verify.accepted(
  'folders',
  'an anonymous session gets its own root folder',
  $sql$insert into folders (id, owner_session_id, name)
       values ('fold_cdefgcdefgcdefgcdefgcdefgc', 'sess_abcdeabcdeabcdeabcdeabcdef', 'Anon uploads')$sql$
);

select verify.accepted(
  'folders',
  'a grandchild is accepted',
  $sql$insert into folders (id, owner_user_id, name, parent_id)
       values ('fold_fghjkfghjkfghjkfghjkfghjkm', '11111111-1111-4111-8111-111111111111',
               '2026', 'fold_bcdefbcdefbcdefbcdefbcdefb')$sql$
);

-- The cycle test: moving the root under its own grandchild must be refused, or the tree becomes a
-- ring and every recursive query over it never terminates.
select verify.rejected(
  'folders',
  'moving a folder under its own descendant is refused (cycle)',
  $sql$update folders set parent_id = 'fold_fghjkfghjkfghjkfghjkfghjkm'
        where id = 'fold_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'cannot be its own ancestor'
);

select verify.eq(
  'folders',
  'the refused move left the hierarchy unchanged',
  (select depth from folders where id = 'fold_fghjkfghjkfghjkfghjkfghjkm'),
  2
);

select verify.rejected(
  'folders',
  'a sibling with the same name is rejected',
  $sql$insert into folders (id, owner_user_id, name, parent_id)
       values ('fold_fghjkfghjkfghjkfghjkfghjkn', '11111111-1111-4111-8111-111111111111',
               'Invoices', 'fold_abcdeabcdeabcdeabcdeabcdef')$sql$,
  'folders_sibling_name_unique'
);

select verify.rejected(
  'folders',
  'a sibling name differing only in case is rejected',
  $sql$insert into folders (id, owner_user_id, name, parent_id)
       values ('fold_fghjkfghjkfghjkfghjkfghjkn', '11111111-1111-4111-8111-111111111111',
               'INVOICES', 'fold_abcdeabcdeabcdeabcdeabcdef')$sql$,
  'folders_sibling_name_unique'
);

select verify.rejected(
  'folders',
  'a second root folder with the same name is rejected (NULL parents are still siblings)',
  $sql$insert into folders (id, owner_user_id, name)
       values ('fold_fghjkfghjkfghjkfghjkfghjkn', '11111111-1111-4111-8111-111111111111', 'Documents')$sql$,
  'folders_sibling_name_unique'
);

select verify.accepted(
  'folders',
  'the same name in a different parent is allowed',
  $sql$insert into folders (id, owner_user_id, name, parent_id)
       values ('fold_fghjkfghjkfghjkfghjkfghjkn', '11111111-1111-4111-8111-111111111111',
               'Documents', 'fold_bcdefbcdefbcdefbcdefbcdefb')$sql$
);

select verify.rejected(
  'folders',
  'another owner may not collide with an existing sibling name check by ownership',
  $sql$update folders set owner_user_id = '22222222-2222-4222-8222-222222222222'
        where id = 'fold_fghjkfghjkfghjkfghjkfghjkn'$sql$,
  'folders_parent_same_owner'
);

-- Soft deletion frees the name only because the uniqueness index excludes deleted rows. Without
-- that predicate a user could never reuse a name they had deleted.
select verify.accepted(
  'folders',
  'a folder can be soft deleted',
  $sql$update folders set deleted_at = now() where id = 'fold_fghjkfghjkfghjkfghjkfghjkn'$sql$
);

select verify.accepted(
  'folders',
  'a soft-deleted sibling name can be reused',
  $sql$insert into folders (id, owner_user_id, name, parent_id)
       values ('fold_fghjkfghjkfghjkfghjkfghjkp', '11111111-1111-4111-8111-111111111111',
               'Documents', 'fold_bcdefbcdefbcdefbcdefbcdefb')$sql$
);

-- --------------------------------------------------------------------------- placement

select verify.rejected(
  'placement',
  'a file cannot be placed in another user''s folder',
  $sql$insert into files (id, owner_user_id, folder_id, original_filename, size_bytes, mime_type)
       values ('file_cdefgcdefgcdefgcdefgcdefgc', '22222222-2222-4222-8222-222222222222',
               'fold_abcdeabcdeabcdeabcdeabcdef', 'wrong-place.bin', 1, 'application/octet-stream')$sql$,
  'files_folder_same_owner'
);

select verify.rejected(
  'placement',
  'a user''s file cannot be placed in an anonymous session''s folder',
  $sql$insert into files (id, owner_user_id, folder_id, original_filename, size_bytes, mime_type)
       values ('file_cdefgcdefgcdefgcdefgcdefgc', '11111111-1111-4111-8111-111111111111',
               'fold_cdefgcdefgcdefgcdefgcdefgc', 'wrong-place.bin', 1, 'application/octet-stream')$sql$,
  'files_folder_same_owner'
);

select verify.rejected(
  'placement',
  'a session''s file cannot be placed in another session''s folder',
  $sql$insert into files (id, owner_session_id, folder_id, original_filename, size_bytes, mime_type)
       values ('file_cdefgcdefgcdefgcdefgcdefgc', 'sess_bcdefbcdefbcdefbcdefbcdefb',
               'fold_cdefgcdefgcdefgcdefgcdefgc', 'wrong-place.bin', 1, 'application/octet-stream')$sql$,
  'files_folder_same_owner'
);

select verify.rejected(
  'placement',
  'a file cannot be moved into another owner''s folder after the fact',
  $sql$update files set folder_id = 'fold_abcdeabcdeabcdeabcdeabcdef'
        where id = 'file_bcdefbcdefbcdefbcdefbcdefb'$sql$,
  'files_folder_same_owner'
);

select verify.accepted(
  'placement',
  'a file can live in its owner''s own folder',
  $sql$update files set folder_id = 'fold_cdefgcdefgcdefgcdefgcdefgc'
        where id = 'file_bcdefbcdefbcdefbcdefbcdefb'$sql$
);

select verify.rejected(
  'placement',
  'a file cannot be placed in a nonexistent folder',
  $sql$update files set folder_id = 'fold_ffffffffffffffffffffffffff'
        where id = 'file_bcdefbcdefbcdefbcdefbcdefb'$sql$,
  'files_folder_same_owner'
);

-- --------------------------------------------------------------------------- provider ids are not identifiers

-- The schema must never treat a provider's identifier (a Telegram chat/message pair, for example)
-- as a unique or public key: the same provider message can be re-referenced, re-uploaded or
-- migrated, and provider ids are guessable in ways an internal id must not be. Two files sharing
-- exactly the same provider reference is therefore legitimate.
select verify.accepted(
  'provider_refs',
  'two storage objects may hold identical provider references',
  $sql$insert into storage_objects (id, file_id, provider_id, provider_ref, size_bytes) values
         ('sobj_abcdeabcdeabcdeabcdeabcdef', 'file_abcdeabcdeabcdeabcdeabcdef', 'telegram',
          '{"chat_id":-1001234567890,"message_id":7}'::jsonb, 1024),
         ('sobj_bcdefbcdefbcdefbcdefbcdefb', 'file_bcdefbcdefbcdefbcdefbcdefb', 'telegram',
          '{"chat_id":-1001234567890,"message_id":7}'::jsonb, 512)$sql$
);

select verify.eq(
  'provider_refs',
  'no unique constraint exists on provider references (they are locators, not identity)',
  (select count(*) from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where i.indisunique and c.relname like 'storage_objects%' and a.attname = 'provider_ref'),
  0::bigint
);

-- Referential actions on sessions, folders and shares are at the end of this file, because they
-- consume the fixtures they are testing: see "referential actions" below.

-- --------------------------------------------------------------------------- subtree depth repair

select verify.eq(
  'folders',
  'the subtree before the move: root 0, child 1, grandchild 2',
  (select string_agg(depth::text, ',' order by depth) from folders
    where id in ('fold_abcdeabcdeabcdeabcdeabcdef', 'fold_bcdefbcdefbcdefbcdefbcdefb',
                 'fold_fghjkfghjkfghjkfghjkfghjkm')),
  '0,1,2'
);

update folders set parent_id = null where id = 'fold_bcdefbcdefbcdefbcdefbcdefb';

select verify.eq(
  'folders',
  're-parenting a folder to the root repairs its whole subtree''s depths',
  (select string_agg(depth::text, ',' order by depth) from folders
    where id in ('fold_abcdeabcdeabcdeabcdeabcdef', 'fold_bcdefbcdefbcdefbcdefbcdefb',
                 'fold_fghjkfghjkfghjkfghjkfghjkm')),
  '0,0,1'
);

-- --------------------------------------------------------------------------- depth ceiling

-- The cycle-detection walk is bounded at 32 levels. That bound is what makes it terminate even if
-- the data were somehow wrong, so it is worth proving rather than trusting.
do $$
declare
  v_parent text := null;
  v_id text;
  v_deepest integer := -1;
  v_refused_at integer := 0;
  v_owner uuid := '11111111-1111-4111-8111-111111111111';
begin
  for level in 0..40 loop
    v_id := 'fold_' || lpad(level::text, 26, '0');
    begin
      insert into folders (id, owner_user_id, name, parent_id)
      values (v_id, v_owner, 'level-' || level, v_parent);
      v_deepest := level;
      v_parent := v_id;
    exception when check_violation then
      v_refused_at := level;
      exit;
    end;
  end loop;

  perform verify.eq('folders', 'folders nest to depth 32', v_deepest, 32);
  perform verify.eq('folders', 'level 33 is refused (the 32 level ceiling holds)', v_refused_at, 33);
end;
$$;

-- --------------------------------------------------------------------------- referential actions

-- Which foreign key reports a blocked delete depends on the order PostgreSQL happens to check them
-- in, so the first assertion is about the refusal itself. The ones after it isolate each dependent
-- by removing the others in turn, so each mechanism is named rather than merely present.
select verify.rejected(
  'cascades',
  'deleting an anonymous session that still owns resources is refused',
  $sql$delete from anonymous_sessions where id = 'sess_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'foreign key constraint'
);

select verify.rejected(
  'cascades',
  'a folder that still holds a file cannot be deleted (placement is a restrict, not a cascade)',
  $sql$delete from folders where owner_session_id = 'sess_abcdeabcdeabcdeabcdeabcdef'$sql$,
  'files_folder_same_owner'
);

-- A share's creator reference is nulled, not cascaded: the link is a record of what happened on the
-- file, and the file outlives its creator's account.
insert into shares (id, file_id, kind, token_hash, created_by)
values ('shr_abcdeabcdeabcdeabcdeabcdef', 'file_bcdefbcdefbcdefbcdefbcdefb', 'unlisted', repeat('77', 32),
        '22222222-2222-4222-8222-222222222222');

delete from profiles where id = '22222222-2222-4222-8222-222222222222';

select verify.eq(
  'cascades',
  'deleting a profile nulls shares.created_by and keeps the share',
  (select count(*) from shares where id = 'shr_abcdeabcdeabcdeabcdeabcdef' and created_by is null),
  1::bigint
);

-- Now remove the session's own resources, one dependency at a time. Deleting its file also cascades
-- the share that pointed at it.
delete from files where owner_session_id = 'sess_abcdeabcdeabcdeabcdeabcdef';

delete from folders where owner_session_id = 'sess_abcdeabcdeabcdeabcdeabcdef';

with session_delete as (
  delete from anonymous_sessions where id = 'sess_abcdeabcdeabcdeabcdeabcdef' returning 1
)
select verify.eq(
  'cascades',
  'a session with no remaining resources can be deleted (revocation is the normal lifecycle)',
  (select count(*) from session_delete),
  1::bigint
);

select verify.eq(
  'cascades',
  'deleting the session''s file also removed the share that referenced it',
  (select count(*) from shares where id = 'shr_abcdeabcdeabcdeabcdeabcdef'),
  0::bigint
);
